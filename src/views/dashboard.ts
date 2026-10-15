import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import type { CoreMsg, DisksMsg, GpuMsg, HistoryMsg, HostMsg, InitMsg, N, ProcRow, ProcsMsg, Snapshot, StringKey, SysMsg, UserRow } from '../../webview/protocol';
import { CoreSample } from '../collectors/core';
import { MountUsage } from '../collectors/disks';
import { GpuSample } from '../collectors/gpu';
import { ProcInfo } from '../collectors/processes';
import { getSysInfo } from '../collectors/sysinfo';
import { aggregateUsers } from '../collectors/users';
import { HistorySnapshot } from '../history';
import { Monitor, ProcData } from '../monitor';
import { remoteLabel } from '../util/remote';
import { shortCmd } from './common';
import { gotoPanel } from './nav';

const VIEW_TYPE = 'serverMonitor.dashboard';
const KEY = 'dashboard';
const PRESETS = [1, 5, 10, 30];
const TOP_PROCS = 20;
const MAX_GPU_PROCS = 40;
const MAX_USERS = 30;
const MAX_CMD = 2000;
const SYSINFO_MS = 30_000;
/** Commands the webview may run. Anything else is ignored. */
const COMMANDS = new Set(['serverMonitor.copyFreeGpus', 'serverMonitor.pickGpus', 'serverMonitor.watchFreeGpus', 'serverMonitor.refresh', 'serverMonitor.openSettings', 'serverMonitor.processes.focus']);

/** Translated UI strings for the webview. Literal l10n.t() calls so the bundle extractor finds them. */
function strings(): Record<StringKey, string> {
  return {
    range: l10n.t('Time range'),
    min: l10n.t('{0} min'),
    copyFree: l10n.t('Copy free GPUs'),
    watchFree: l10n.t('Watch for a free GPU'),
    pickGpus: l10n.t('Pick GPUs…'),
    refresh: l10n.t('Refresh'),
    settings: l10n.t('Settings'),
    openProcs: l10n.t('Open Processes view'),
    cores: l10n.t('{0} cores'),
    ram: l10n.t('{0} RAM'),
    uptime: l10n.t('up {0}'),
    usersOnline: l10n.t('{0} users online'),
    driver: l10n.t('Driver {0}'),
    cuda: l10n.t('CUDA {0}'),
    cgMem: l10n.t('Memory limit {0}'),
    cgCpu: l10n.t('CPU limit {0}'),
    cpu: l10n.t('CPU'),
    memory: l10n.t('Memory'),
    gpusFree: l10n.t('Free GPUs'),
    network: l10n.t('Network'),
    diskIo: l10n.t('Disk I/O'),
    load: l10n.t('load {0}'),
    usedOfTotal: l10n.t('{0} of {1}'),
    avgUtil: l10n.t('avg. utilization {0}'),
    down: l10n.t('Download'),
    up: l10n.t('Upload'),
    read: l10n.t('Read'),
    write: l10n.t('Write'),
    cpuUsage: l10n.t('CPU usage'),
    loadAvg: l10n.t('Load average {0}'),
    perCore: l10n.t('Per-core usage'),
    core: l10n.t('Core {0}'),
    busiest: l10n.t('Busiest: {0}'),
    heatAria: l10n.t('{0} cores, average {1}, highest {2}'),
    used: l10n.t('Used'),
    cache: l10n.t('Cache'),
    free: l10n.t('Free'),
    swap: l10n.t('Swap'),
    noSwap: l10n.t('No swap'),
    memUsage: l10n.t('Memory usage'),
    gpus: l10n.t('GPUs'),
    util: l10n.t('Utilization'),
    memUsed: l10n.t('Memory used'),
    temp: l10n.t('Temperature'),
    power: l10n.t('Power'),
    inUse: l10n.t('In use'),
    gpuUsers: l10n.t('Users: {0}'),
    noGpuProcs: l10n.t('No processes'),
    filterHint: l10n.t('Click a GPU to filter the process table'),
    topProcs: l10n.t('Top processes'),
    pid: l10n.t('PID'),
    user: l10n.t('User'),
    cpuPct: l10n.t('CPU %'),
    gpuMem: l10n.t('GPU memory'),
    command: l10n.t('Command'),
    users: l10n.t('Users'),
    procsCol: l10n.t('Processes'),
    disks: l10n.t('Disks'),
    mount: l10n.t('Mount'),
    fstype: l10n.t('Type'),
    usage: l10n.t('Usage'),
    usedTotal: l10n.t('Used / total'),
    status: l10n.t('Status'),
    ok: l10n.t('OK'),
    timeout: l10n.t('Not responding'),
    error: l10n.t('Error'),
    pending: l10n.t('Checking…'),
    home: l10n.t('Home'),
    you: l10n.t('{0} (you)'),
    onlyGpu: l10n.t('GPU {0} only'),
    clearFilter: l10n.t('Clear filter'),
    noProcsOnGpu: l10n.t('No processes on GPU {0}'),
    scanning: l10n.t('Scanning all users…'),
    totalProcs: l10n.t('{0} processes in total'),
    noProcSupport: l10n.t('Process details are only available on Linux.'),
    waiting: l10n.t('Waiting for data…'),
    noDisks: l10n.t('No disks'),
  };
}

/** Round for the wire; NaN/Infinity become null (JSON cannot carry NaN). */
function rnd(v: number | undefined, digits = 0): N {
  if (v === undefined || !isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function pack(s: HistorySnapshot, digits: (key: string) => number): Snapshot {
  const t = s.t;
  const series: Record<string, N[]> = {};
  for (const [k, vals] of Object.entries(s.series)) {
    const d = digits(k);
    series[k] = vals.map((v) => rnd(v, d));
  }
  return { t0: t[0] ?? 0, dt: t.map((v, i) => (i ? v - t[i - 1] : 0)), series };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function registerDashboard(ctx: vscode.ExtensionContext, m: Monitor): void {
  let current: Dashboard | undefined;
  const create = (panel: vscode.WebviewPanel, range?: number) => {
    current = new Dashboard(ctx, m, panel, range, () => (current = undefined));
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand('serverMonitor.openDashboard', () => {
      if (current) return current.panel.reveal();
      const panel = vscode.window.createWebviewPanel(VIEW_TYPE, l10n.t('Server Monitor: {0}', getSysInfo().hostname), vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: resourceRoots(ctx),
      });
      create(panel);
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown) => {
        if (current) return panel.dispose();
        const r = (state as { range?: unknown } | undefined)?.range;
        create(panel, typeof r === 'number' ? r : undefined);
      },
    }),
    { dispose: () => current?.panel.dispose() },
  );
}

function resourceRoots(ctx: vscode.ExtensionContext): vscode.Uri[] {
  return [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'media')];
}

/**
 * One dashboard panel. The webview is destroyed whenever the panel is hidden (retainContextWhenHidden: false), so all
 * demands and subscriptions live only while the panel is visible, and each fresh webview asks for an `init` snapshot.
 */
class Dashboard {
  private visible = false;
  /** The current webview instance has said `ready` and not been torn down since. */
  private ready = false;
  private live: { dispose(): void }[] = [];
  private subs: vscode.Disposable[] = [];
  private sysTimer?: NodeJS.Timeout;
  private disposed = false;
  private range: number;
  /** pid → full command line already sent to the current webview instance. */
  private sentCmd = new Map<number, string>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly m: Monitor,
    readonly panel: vscode.WebviewPanel,
    range: number | undefined,
    private readonly onDispose: () => void,
  ) {
    this.range = this.clamp(range ?? 5);
    panel.webview.options = { enableScripts: true, localResourceRoots: resourceRoots(ctx) };
    panel.title = l10n.t('Server Monitor: {0}', getSysInfo().hostname);
    panel.webview.html = this.html();
    this.subs.push(
      panel.onDidChangeViewState(() => this.setVisible(panel.visible)),
      panel.onDidDispose(() => this.dispose()),
      panel.webview.onDidReceiveMessage((msg: unknown) => this.onMessage(msg)),
      m.onConfig.event(() => {
        this.range = this.clamp(this.range);
        this.sentCmd.clear();
        this.post(() => this.init());
      }),
    );
    this.setVisible(panel.visible);
  }

  // ------------------------------------------------------------ lifecycle

  private setVisible(v: boolean): void {
    if (v === this.visible || this.disposed) return;
    this.visible = v;
    if (!v) return this.release();
    const m = this.m;
    const sources = m.gpuC.available === false ? [m.core, m.procs, m.disks] : [m.core, m.gpu, m.gpuApps, m.procs, m.disks];
    this.live.push(
      ...sources.map((s) => s.demand(KEY)),
      m.core.onData.event((c) => this.post(() => this.coreMsg(c))),
      m.gpu.onData.event((g) => this.post(() => this.gpuMsg(g))),
      m.procs.onData.event((p) => this.post(() => this.procsMsg(p))),
      m.disks.onData.event((d) => this.post(() => this.disksMsg(d.mounts))),
    );
    m.needAllProcesses(KEY, true);
    this.sysTimer = setInterval(() => this.post(() => this.sysMsg()), SYSINFO_MS);
    if (m.gpuC.cudaVersion === undefined) {
      void m.gpuC.fetchCudaVersion().then(
        () => this.post(() => this.sysMsg()),
        () => undefined,
      );
    }
  }

  private release(): void {
    this.ready = false;
    for (const d of this.live) d.dispose();
    this.live = [];
    clearInterval(this.sysTimer);
    this.sysTimer = undefined;
    this.m.needAllProcesses(KEY, false);
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.visible = false;
    this.release();
    for (const d of this.subs) d.dispose();
    this.subs = [];
    this.onDispose();
  }

  /** Messages are built and sent only for a visible, initialised webview. */
  private post(make: () => HostMsg): void {
    if (this.visible && this.ready && !this.disposed) void this.panel.webview.postMessage(make());
  }

  private onMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const o = msg as { type?: unknown; minutes?: unknown; id?: unknown };
    switch (o.type) {
      case 'ready':
        this.ready = true;
        this.sentCmd.clear();
        this.post(() => this.init());
        break;
      case 'range':
        if (typeof o.minutes !== 'number' || !isFinite(o.minutes)) return;
        this.range = this.clamp(o.minutes);
        this.post(() => this.historyMsg());
        break;
      case 'command':
        // "Open processes" goes to the sidebar panel unless the classic tree views are enabled.
        if (o.id === 'serverMonitor.processes.focus' && !this.m.cfg.sidebarTreeViews) {
          void gotoPanel({ page: 'proc' });
          break;
        }
        if (typeof o.id === 'string' && COMMANDS.has(o.id)) {
          void vscode.commands.executeCommand(o.id).then(undefined, (err: unknown) => void vscode.window.showErrorMessage(String((err as Error)?.message ?? err)));
        }
        break;
    }
  }

  // ------------------------------------------------------------ ranges

  /** 1/5/10/30 minutes, limited by how much history is kept. */
  private ranges(): number[] {
    const h = this.m.cfg.historyMinutes;
    return [...new Set([...PRESETS.filter((r) => r < h), Math.min(h, PRESETS[PRESETS.length - 1])])];
  }

  private clamp(minutes: number): number {
    const r = this.ranges();
    let best = r[0];
    for (const x of r) if (x <= minutes) best = x;
    return best;
  }

  // ------------------------------------------------------------ payloads

  private init(): InitMsg {
    const m = this.m;
    return {
      type: 'init',
      strings: strings(),
      ranges: this.ranges(),
      gpuAvailable: m.gpuC.available ?? null,
      sys: this.sysMsg(),
      history: this.historyMsg(),
      core: m.core.latest && this.coreMsg(m.core.latest),
      gpu: m.gpu.latest && this.gpuMsg(m.gpu.latest),
      procs: m.procs.latest && this.procsMsg(m.procs.latest),
      disks: m.disks.latest && this.disksMsg(m.disks.latest.mounts),
    };
  }

  private historyMsg(): HistoryMsg {
    const since = Date.now() - this.range * 60_000;
    return {
      type: 'history',
      range: this.range,
      core: pack(this.m.coreHistory.snapshot(since), (k) => (k === 'cpu' || k === 'mem' ? 1 : 0)),
      gpu: pack(this.m.gpuHistory.snapshot(since), (k) => (k[0] === 'm' ? 1 : 0)),
    };
  }

  private sysMsg(): SysMsg {
    const s = getSysInfo();
    const g = this.m.gpuC;
    return {
      type: 'sys',
      hostname: s.hostname,
      os: s.os,
      kernel: s.kernel,
      arch: s.arch,
      cpuModel: s.cpuModel,
      cpuCount: s.cpuCount,
      memTotal: s.memTotal,
      uptime: Math.round(s.uptime),
      users: [...new Set(s.users)],
      conn: remoteLabel(),
      driver: g.driverVersion || null,
      cuda: g.cudaVersion || null,
      cgroupMem: s.cgroupMem ?? null,
      cgroupCpus: s.cgroupCpus ?? null,
    };
  }

  private coreMsg(c: CoreSample): CoreMsg {
    const mem = c.mem;
    return {
      type: 'core',
      t: c.t,
      cpu: rnd(c.cpu, 1),
      cores: Array.from(c.cores, (v) => rnd(v)),
      load: c.load.map((v) => Math.round(v * 100) / 100),
      mem: { total: mem.total, used: mem.used, free: mem.free, cache: mem.cache, available: mem.available, swapTotal: mem.swapTotal, swapUsed: mem.swapUsed, percent: rnd(mem.percent, 1) },
      rx: rnd(c.rx),
      tx: rnd(c.tx),
      dr: rnd(c.diskRead),
      dw: rnd(c.diskWrite),
    };
  }

  private gpuMsg(g: GpuSample): GpuMsg {
    const free = new Set(this.m.freeGpus(g.gpus).map((x) => x.index));
    const users = new Map<number, Set<string>>();
    for (const a of this.m.gpuApps.latest ?? []) {
      let s = users.get(a.gpuIndex);
      if (!s) users.set(a.gpuIndex, (s = new Set()));
      s.add(a.user);
    }
    return {
      type: 'gpu',
      t: g.t,
      gpus: g.gpus.map((x) => ({
        i: x.index,
        name: x.name,
        util: rnd(x.util),
        memUsed: rnd(x.memUsed),
        memTotal: rnd(x.memTotal),
        temp: rnd(x.temp),
        power: rnd(x.power),
        powerLimit: rnd(x.powerLimit),
        free: free.has(x.index),
        users: [...(users.get(x.index) ?? [])].sort(),
      })),
    };
  }

  /** Top processes by CPU plus the GPU processes, and per-user totals. Never the full process list. */
  private procsMsg(p: ProcData): ProcsMsg {
    const m = this.m;
    const myUid = m.names.myUid;
    const apps = m.gpuApps.latest ?? [];
    const gpuOf = new Map<number, [number, number][]>();
    for (const a of apps) {
      if (a.gpuIndex < 0) continue;
      let l = gpuOf.get(a.pid);
      if (!l) gpuOf.set(a.pid, (l = []));
      l.push([a.gpuIndex, rnd(a.memMiB) ?? 0]);
    }
    const row = (pr: ProcInfo): ProcRow => {
      const full = m.procC.cmdline(pr) || pr.comm;
      return { pid: pr.pid, user: m.names.name(pr.uid), me: pr.uid === myUid, cpu: rnd(pr.cpu, 1), rss: pr.rss, gpu: gpuOf.get(pr.pid) ?? [], cmd: shortCmd(full) || pr.comm, full };
    };

    const top = [...p.procs].sort((a, b) => b.cpu - a.cpu).slice(0, TOP_PROCS);
    const rows = top.map(row);
    const seen = new Set(top.map((x) => x.pid));
    const extra: ProcRow[] = [];
    if (gpuOf.size) {
      for (const pr of p.procs) if (gpuOf.has(pr.pid) && !seen.has(pr.pid) && seen.add(pr.pid)) extra.push(row(pr));
      // GPU processes we cannot see in /proc (other pid namespaces) still belong in the per-GPU view
      for (const a of apps) {
        if (seen.has(a.pid) || a.gpuIndex < 0) continue;
        seen.add(a.pid);
        extra.push({ pid: a.pid, user: a.user, me: a.uid === myUid, cpu: null, rss: null, gpu: gpuOf.get(a.pid) ?? [], cmd: shortCmd(a.cmd) || a.name, full: a.cmd });
      }
      extra.sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1));
    }
    rows.push(...extra.slice(0, MAX_GPU_PROCS));
    // Full command lines go out once per pid; the webview keeps them.
    const sent = new Map<number, string>();
    for (const r of rows) {
      const full = (r.full ?? '').length > MAX_CMD ? r.full!.slice(0, MAX_CMD) + '…' : (r.full ?? '');
      if (this.sentCmd.get(r.pid) === full) delete r.full;
      else r.full = full;
      sent.set(r.pid, full);
    }
    this.sentCmd = sent;

    const users: UserRow[] = aggregateUsers(p.procs, apps, m.gpu.latest?.gpus ?? [])
      .filter((u) => u.cpu >= 0.5 || u.gpus.length || u.uid === myUid || u.rss > 512 * 1024 * 1024)
      .sort((a, b) => b.gpus.length - a.gpus.length || b.cpu - a.cpu)
      .slice(0, MAX_USERS)
      .map((u) => ({ name: m.names.name(u.uid), me: u.uid === myUid, cpu: rnd(u.cpu, 1), rss: u.rss, gpus: u.gpus, gpuMem: rnd(u.gpuMem), procs: u.procs }));

    return { type: 'procs', supported: p.supported, scope: p.scope, total: p.total, procs: rows, users };
  }

  private disksMsg(mounts: MountUsage[]): DisksMsg {
    return {
      type: 'disks',
      mounts: mounts.map((d) => ({ mount: d.mount, fstype: d.fstype, device: d.device, total: rnd(d.total), used: rnd(d.used), percent: rnd(d.percent, 1), status: d.status, network: d.network, home: d.home })),
    };
  }

  // ------------------------------------------------------------ html

  private html(): string {
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'dashboard.css'));
    const csp = [`default-src 'none'`, `img-src ${w.cspSource} data:`, `style-src ${w.cspSource}`, `script-src 'nonce-${nonce}'`, `font-src ${w.cspSource}`].join('; ');
    const title = l10n.t('Server Monitor: {0}', getSysInfo().hostname);
    return `<!DOCTYPE html>
<html lang="${esc(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>${esc(title)}</title>
</head>
<body>
<main id="app" aria-busy="true"></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
