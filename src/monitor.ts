import * as vscode from 'vscode';
import { Config, readConfig } from './config';
import { CoreCollector, CoreSample } from './collectors/core';
import { DiskCollector, MountUsage } from './collectors/disks';
import { DockerClient, DockerContainer, DockerStatus } from './collectors/docker';
import { GpuCollector, GpuSample, isGpuFree } from './collectors/gpu';
import { GpuApp, GpuInfo } from './collectors/parsers';
import { PortCollector, PortInfo } from './collectors/ports';
import { ProcessCollector, ProcSnapshot } from './collectors/processes';
import { TmuxClient, TmuxState } from './collectors/tmux';
import { History } from './history';
import { deepEqual, Demandable, DemandOptions, Scheduler, Source } from './scheduler';
import { UserNames } from './util/users';
import { pidUid, readProc } from './util/procfs';
import { parseCmdline, slowdowns } from './collectors/parsers';
import { fillEta, Point } from './util/forecast';
import { physicalDisksOf } from './util/blockdev';

/**
 * Refresh interval for glanceable consumers (the status bar): pass `{ minInterval: GLANCE_INTERVAL_MS }` to demand() so
 * they do not keep a source at the fast base interval when nothing else is looking.
 */
export const GLANCE_INTERVAL_MS = 5000;
export const GLANCE: DemandOptions = { minInterval: GLANCE_INTERVAL_MS };

export interface GpuProc extends GpuApp {
  gpuIndex: number;
  uid?: number;
  user: string;
  cmd: string;
}

export interface ProcData extends ProcSnapshot {
  scope: 'mine' | 'all';
}

/** A GPU idle for a while yet holding memory: since when, how much, and whose processes. */
export interface IdleHold {
  index: number;
  since: number;
  heldMiB: number;
  holders: GpuProc[];
}

/** Memory a GPU's processes must hold for "idle but held" (desktop/driver leftovers stay below this). */
const HOLD_MIN_MIB = 1024;
/** A gap this long between GPU samples (nothing asked for them) restarts the idle clock: we cannot vouch for it. */
const IDLE_GAP_MS = 5 * 60_000;
/** Used-space samples kept per mount for the fill forecast. */
const DISK_HIST_MS = 3 * 3600_000;

/** Owns every collector and data source; views and the dashboard subscribe through `Source.demand()`. */
export class Monitor implements vscode.Disposable {
  cfg: Config = readConfig();
  readonly sched = new Scheduler();
  readonly names = new UserNames();
  readonly onConfig = new vscode.EventEmitter<Config>();

  readonly coreC = new CoreCollector();
  readonly procC = new ProcessCollector();
  readonly gpuC = new GpuCollector();
  readonly portC: PortCollector;
  readonly tmuxC = new TmuxClient();
  readonly diskC: DiskCollector;
  readonly dockerC = new DockerClient();

  readonly core: Source<CoreSample>;
  readonly gpu: Source<GpuSample>;
  readonly gpuApps: Source<GpuProc[]>;
  readonly procs: Source<ProcData>;
  readonly ports: Source<{ ports: PortInfo[]; supported: boolean }>;
  readonly tmux: Source<TmuxState>;
  readonly disks: Source<{ mounts: MountUsage[]; supported: boolean }>;
  readonly docker: Source<{ status: DockerStatus; containers: DockerContainer[]; error?: string }>;

  coreHistory: History;
  gpuHistory: History;

  /** GPU index → since when it is idle while holding memory (and when that was last confirmed). */
  private gpuIdle = new Map<number, { since: number; seen: number; heldMiB: number }>();
  /** GPU index → recent samples with a thermal / hardware slowdown (0..5; flagged from 3, so one blip is not). */
  private gpuSlow = new Map<number, number>();
  /** OOM kills seen while running (the counter is per boot, so only increases we observe are events). */
  readonly oomEvents: { t: number; n: number }[] = [];
  private oomLast?: number;
  /** Mount → used bytes over time. */
  private diskHist = new Map<string, Point[]>();

  /** Consumers that need every user's processes (others only need the current user's). */
  private allProcsDemand = new Set<string>();
  private procTick = 0;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    // Port owners: reuse the process scan's /proc listing and uid cache when it is fresh instead of stat()ing all of /proc.
    this.portC = new PortCollector(this.names.myUid, { pidsOf: (uid) => this.procC.pidsOf(uid, 1500), uidOf: (pid) => this.procC.cachedUid(pid) });
    this.diskC = new DiskCollector(() => ({ excludeFsTypes: this.cfg.diskExcludeFsTypes, excludeMounts: this.cfg.diskExcludeMounts, networkTimeoutMs: this.cfg.diskNetworkTimeoutMs }));
    this.applySchedulerConfig();

    const s = this.sched;
    this.core = s.source('core', { interval: () => this.cfg.refreshInterval, poll: () => this.coreC.sample(), warmup: true, hasBaseline: () => this.coreC.hasBaseline() });
    this.gpu = s.source('gpu', {
      interval: () => this.cfg.refreshInterval,
      stream: { start: (ms, emit) => void this.gpuC.start(ms, emit), stop: () => this.gpuC.stop() },
    });
    this.gpuApps = s.source('gpuApps', {
      interval: () => 5000,
      // A long-lived `nvidia-smi --query-compute-apps -lms` while demanded; one-shot query for fetch()/refresh().
      stream: { start: (ms, emit) => void this.gpuC.startApps(ms, (apps) => emit(this.enrichApps(apps))), stop: () => this.gpuC.stopApps() },
      poll: () => this.pollGpuApps(),
      same: deepEqual,
    });
    this.procs = s.source('procs', {
      interval: () => (this.allProcsDemand.size ? 5000 : 3000),
      poll: async () => {
        const scope = this.allProcsDemand.size ? 'all' : 'mine';
        // "mine" refreshes known processes every tick and looks for new ones every other tick (see ProcessCollector.scan).
        const discover = scope === 'all' || this.procs.latest?.scope !== 'mine' || ++this.procTick % 2 === 0;
        const snap = await this.procC.scan(scope === 'all' ? undefined : this.names.myUid, discover);
        return { ...snap, scope };
      },
      warmup: true,
      hasBaseline: () => this.procC.hasBaseline(this.allProcsDemand.size ? undefined : this.names.myUid),
    });
    this.ports = s.source('ports', { interval: () => 5000, poll: () => this.portC.collect(), same: deepEqual });
    this.tmux = s.source('tmux', { interval: () => 3000, poll: () => this.tmuxC.list(), same: deepEqual });
    this.disks = s.source('disks', {
      interval: () => 30000,
      poll: async () => {
        const d = await this.diskC.collect();
        // Slow (network) mounts answer in the background; pick their result up soon instead of in 30 s.
        if (d.mounts.some((x) => x.status === 'pending')) setTimeout(() => this.disks.refresh(), 4000);
        return d;
      },
      same: deepEqual,
    });
    this.docker = s.source('docker', { interval: () => 5000, poll: () => this.dockerC.list(), same: deepEqual });

    this.coreHistory = this.newHistory();
    this.gpuHistory = this.newHistory();
    this.core.onData.event((c) => {
      const io = c.disks.length ? Math.max(...c.disks.map((d) => d.util)) : NaN;
      this.coreHistory.push(c.t, { cpu: c.cpu, mem: c.mem.percent, rx: c.rx, tx: c.tx, dr: c.diskRead, dw: c.diskWrite, io, iow: c.split?.iowait ?? NaN });
      this.trackOom(c);
    });
    this.disks.onData.event((d) => this.trackDisks(d.mounts));
    this.gpu.onData.event((g) => {
      this.trackIdle(g);
      const v: Record<string, number> = {};
      for (const x of g.gpus) {
        v[`u${x.index}`] = x.util;
        v[`m${x.index}`] = x.memTotal ? (x.memUsed / x.memTotal) * 100 : NaN;
      }
      this.gpuHistory.push(g.t, v);
    });

    this.disposables.push(
      vscode.window.onDidChangeWindowState((w) => this.sched.setFocused(w.focused)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('serverMonitor')) return;
        const prevMinutes = this.cfg.historyMinutes;
        this.cfg = readConfig();
        this.applySchedulerConfig();
        if (prevMinutes !== this.cfg.historyMinutes) {
          this.coreHistory = this.newHistory();
          this.gpuHistory = this.newHistory();
        }
        this.sched.reconcileAll();
        this.onConfig.fire(this.cfg);
      }),
    );
    this.sched.focused = vscode.window.state.focused;
  }

  private applySchedulerConfig(): void {
    this.sched.backgroundMode = this.cfg.backgroundMode;
    this.sched.backgroundIntervalMs = this.cfg.backgroundInterval;
  }

  private newHistory(): History {
    return new History(Math.ceil((this.cfg.historyMinutes * 60_000) / Math.min(this.cfg.refreshInterval, 1000)) + 10);
  }

  /** Ask for all users' processes (users view, dashboard, "all" scope). */
  needAllProcesses(key: string, on: boolean): void {
    const before = this.allProcsDemand.size > 0;
    if (on) this.allProcsDemand.add(key);
    else this.allProcsDemand.delete(key);
    if (before !== this.allProcsDemand.size > 0) {
      this.procs.reconcile();
      this.procs.refresh();
    }
  }

  private async pollGpuApps(): Promise<GpuProc[]> {
    return this.enrichApps(await this.gpuC.queryApps());
  }

  /** Owner and full command line for each compute app (GPU index from detection, so no extra nvidia-smi query). */
  private enrichApps(apps: GpuApp[]): GpuProc[] {
    return apps.map((a) => {
      const uid = pidUid(a.pid); // undefined: other pid namespace (containers) or exited
      const raw = readProc(`/proc/${a.pid}/cmdline`);
      return {
        ...a,
        gpuIndex: this.gpuC.indexOf(a.uuid),
        uid,
        user: uid === undefined ? '?' : this.names.name(uid),
        cmd: (raw && parseCmdline(raw.slice(0, 4096))) || a.name,
      };
    });
  }

  // ------------------------------------------------------------ derived state

  /** Recent compute apps (undefined when unknown or stale). */
  recentApps(): GpuProc[] | undefined {
    return this.gpuC.appsSupported && Date.now() - this.gpuApps.updatedAt < 30_000 ? this.gpuApps.latest : undefined;
  }

  private trackIdle(g: GpuSample): void {
    for (const x of g.gpus) {
      const bad = slowdowns(x.throttle).some((r) => r !== 'power');
      const n = this.gpuSlow.get(x.index) ?? 0;
      this.gpuSlow.set(x.index, bad ? Math.min(5, n + 1) : Math.max(0, n - 1));
    }
    const apps = this.recentApps();
    if (!apps) return; // who holds what is unknown (WSL, or the app list is not running): no verdict
    for (const x of g.gpus) {
      const held = apps.filter((a) => a.gpuIndex === x.index).reduce((n, a) => n + (isFinite(a.memMiB) ? a.memMiB : 0), 0);
      const idle = isFinite(x.util) && x.util < this.cfg.gpuFreeUtilPercent && held >= HOLD_MIN_MIB;
      const prev = this.gpuIdle.get(x.index);
      if (!idle) this.gpuIdle.delete(x.index);
      else if (!prev || g.t - prev.seen > IDLE_GAP_MS) this.gpuIdle.set(x.index, { since: g.t, seen: g.t, heldMiB: held });
      else (prev.seen = g.t), (prev.heldMiB = held);
    }
  }

  /** GPUs idle for at least the configured time while processes hold their memory. */
  idleHolds(now = Date.now()): IdleHold[] {
    const min = this.cfg.gpuIdleHoldMinutes * 60_000;
    if (!min) return [];
    const apps = this.recentApps() ?? [];
    const out: IdleHold[] = [];
    for (const [index, s] of this.gpuIdle) {
      if (now - s.seen > IDLE_GAP_MS || now - s.since < min) continue;
      out.push({ index, since: s.since, heldMiB: s.heldMiB, holders: apps.filter((a) => a.gpuIndex === index) });
    }
    return out.sort((a, b) => a.index - b.index);
  }

  /** A thermal or hardware slowdown has lasted several samples. */
  slowSustained(index: number): boolean {
    return (this.gpuSlow.get(index) ?? 0) >= 3;
  }

  /** Since when a GPU has been idle while held (whether or not that is long enough to flag yet). */
  idleSince(index: number): number | undefined {
    const s = this.gpuIdle.get(index);
    return s && Date.now() - s.seen <= IDLE_GAP_MS ? s.since : undefined;
  }

  private trackOom(c: CoreSample): void {
    if (c.oomKills === undefined) return;
    if (this.oomLast !== undefined && c.oomKills > this.oomLast) {
      this.oomEvents.push({ t: c.t, n: c.oomKills - this.oomLast });
      if (this.oomEvents.length > 20) this.oomEvents.shift();
    }
    this.oomLast = c.oomKills;
  }

  private trackDisks(mounts: MountUsage[]): void {
    const now = Date.now();
    for (const d of mounts) {
      if (d.status !== 'ok' || d.used === undefined) continue;
      let h = this.diskHist.get(d.mount);
      if (!h) this.diskHist.set(d.mount, (h = []));
      // a long gap (nothing showed the disks) starts over: the trend before it says nothing about now
      if (h.length && now - h[h.length - 1].t > 15 * 60_000) h.length = 0;
      if (!h.length || now - h[h.length - 1].t >= 5000) h.push({ t: now, v: d.used });
      while (h.length && h[0].t < now - DISK_HIST_MS) h.shift();
    }
  }

  /** When a mount fills up at its recent rate (undefined: not filling measurably within a week). */
  fillEta(d: MountUsage): { seconds: number; rate: number } | undefined {
    const h = this.diskHist.get(d.mount);
    return h && d.avail !== undefined ? fillEta(h, d.avail) : undefined;
  }

  /** Physical disks behind a mount (empty for network and virtual filesystems). */
  disksOf(d: MountUsage): string[] {
    return d.network ? [] : physicalDisksOf(d.device, this.coreC.physicalDisks());
  }

  freeGpus(gpus: GpuInfo[] = this.gpu.latest?.gpus ?? []): GpuInfo[] {
    const apps = this.gpuC.appsSupported && Date.now() - this.gpuApps.updatedAt < 30_000 ? this.gpuApps.latest : undefined;
    const ctx = { busy: apps ? new Set(apps.map((a) => a.gpuIndex)) : undefined, noProcessInfo: this.gpuC.appsSupported === false };
    return gpus.filter((g) => isGpuFree(g, this.cfg.gpuFreeMemoryMiB, this.cfg.gpuFreeUtilPercent, ctx));
  }

  dispose(): void {
    this.sched.dispose();
    this.gpuC.stop();
    this.gpuC.stopApps();
    this.onConfig.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/** Register a demand on `sources` whenever `view` is visible. */
export function demandWhileVisible(view: { visible: boolean; onDidChangeVisibility: vscode.Event<unknown> }, key: string, sources: () => Demandable[], onChange?: (visible: boolean) => void): vscode.Disposable {
  let held: { dispose(): void }[] = [];
  const update = () => {
    for (const d of held) d.dispose();
    held = view.visible ? sources().map((s) => s.demand(key)) : [];
    onChange?.(view.visible);
  };
  const sub = view.onDidChangeVisibility(update);
  update();
  return { dispose: () => (sub.dispose(), held.forEach((d) => d.dispose())) };
}
