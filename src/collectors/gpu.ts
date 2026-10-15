import { ChildProcess } from 'child_process';
import { GPU_FIELDS, GpuApp, GpuInfo, parseGpuApps, parseGpuLine } from './parsers';
import { run, runExclusive, spawnLines, which } from '../util/exec';
import { readProc } from '../util/procfs';

export interface GpuSample {
  t: number;
  gpus: GpuInfo[];
}

const QUERY = `--query-gpu=${GPU_FIELDS.join(',')}`;
const APPS_QUERY = '--query-compute-apps=pid,gpu_uuid,used_memory,process_name';
const FORMAT = '--format=csv,noheader,nounits';
/** All lines of one `-lms` cycle arrive within a millisecond or two; this much silence ends the cycle. */
const APPS_BURST_MS = 60;
/** The first cycle comes right after NVML init; no output by then means "no compute apps". */
const APPS_FIRST_CYCLE_MS = 1500;

/**
 * NVIDIA GPUs via nvidia-smi. Polling uses one long-lived `nvidia-smi -lms` process so NVML is initialised once,
 * instead of paying ~150 ms of startup per sample. If the stream stalls or keeps dying we fall back to one-shot queries.
 */
export class GpuCollector {
  readonly binary = which('nvidia-smi', ['/usr/lib/wsl/lib/nvidia-smi', '/usr/bin/nvidia-smi']);
  driverVersion?: string;
  cudaVersion?: string;
  gpuCount = 0;
  /** Set once detection finished: whether nvidia-smi exists and reported at least one GPU. */
  available?: boolean;
  /** WSL's nvidia-smi cannot list per-process usage. */
  appsSupported = true;
  private ready?: Promise<boolean>;

  private child?: ChildProcess;
  private pending: GpuInfo[] = [];
  private streamFailures = 0;
  private pollTimer?: NodeJS.Timeout;
  private watchdog?: NodeJS.Timeout;
  private lastLineAt = 0;
  private intervalMs = 0;
  private emit?: (s: GpuSample) => void;
  /** uuid → index, from detection (indexes do not change while the driver is loaded). */
  private indexByUuid = new Map<string, number>();

  // Compute-apps stream: cycles have no delimiter and an empty cycle prints nothing, so a cycle ends after a short
  // silence, and a missing cycle (no output for 1.5 intervals while nvidia-smi keeps running) means "no apps".
  private appsChild?: ChildProcess;
  private appsInterval = 0;
  private appsEmit?: (apps: GpuApp[]) => void;
  private appsPending: GpuApp[] = [];
  private appsBurstTimer?: NodeJS.Timeout;
  private appsIdleTimer?: NodeJS.Timeout;
  private appsPollTimer?: NodeJS.Timeout;
  private appsFailures = 0;
  private appsHeartbeat = -1;
  private appsStalls = 0;

  detect(): Promise<boolean> {
    if (!this.ready) {
      this.ready = (async () => {
        if (!this.binary) return (this.available = false);
        const r = await run(this.binary, [QUERY + ',driver_version', FORMAT], { timeoutMs: 15000 });
        const lines = r.stdout.split('\n').filter(Boolean);
        const gpus = lines.map(parseGpuLine).filter((g): g is GpuInfo => !!g);
        this.gpuCount = gpus.length;
        for (const g of gpus) this.indexByUuid.set(g.uuid, g.index);
        const first = lines[0]?.split(', ');
        this.driverVersion = first?.[GPU_FIELDS.length]?.trim();
        this.available = this.gpuCount > 0;
        if (this.binary.startsWith('/usr/lib/wsl/')) this.appsSupported = false;
        return this.available;
      })();
    }
    return this.ready;
  }

  /** Start emitting samples every `intervalMs`. Calling again with a new interval restarts the stream. */
  async start(intervalMs: number, emit: (s: GpuSample) => void): Promise<void> {
    this.emit = emit;
    if (this.intervalMs === intervalMs && (this.child || this.pollTimer)) return;
    this.stop();
    this.intervalMs = intervalMs;
    if (!(await this.detect()) || this.intervalMs !== intervalMs) return;
    if (this.streamFailures >= 3) this.startPolling();
    else this.startStream();
  }

  stop(): void {
    this.intervalMs = 0;
    if (this.child) {
      const c = this.child;
      this.child = undefined;
      c.kill();
    }
    clearTimeout(this.pollTimer);
    clearInterval(this.watchdog);
    this.pollTimer = this.watchdog = undefined;
    this.pending = [];
  }

  private startStream(): void {
    const interval = this.intervalMs;
    this.lastLineAt = Date.now();
    const child = spawnLines(
      this.binary!,
      [QUERY, FORMAT, `-lms`, String(interval)],
      (line) => this.onLine(line),
      () => {
        if (this.child !== child) return; // stopped on purpose
        this.child = undefined;
        this.streamFailures++;
        clearInterval(this.watchdog);
        if (this.intervalMs === interval) setTimeout(() => this.intervalMs === interval && !this.child && (this.streamFailures >= 3 ? this.startPolling() : this.startStream()), 2000);
      },
    );
    this.child = child;
    // Stall detection: no output for 3 intervals (+ slack for the first NVML init) means the stream is wedged.
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastLineAt > interval * 3 + 10000) {
        this.streamFailures = 3;
        child.kill('SIGKILL');
      }
    }, interval * 3 + 10000);
  }

  private onLine(line: string): void {
    this.lastLineAt = Date.now();
    const g = parseGpuLine(line);
    if (!g) return;
    // A new cycle starts when the index does not increase; also flush as soon as we have every GPU.
    if (this.pending.length && g.index <= this.pending[this.pending.length - 1].index) this.flush();
    this.pending.push(g);
    if (this.pending.length >= this.gpuCount) this.flush();
  }

  private flush(): void {
    if (!this.pending.length) return;
    const gpus = this.pending;
    this.pending = [];
    this.streamFailures = 0;
    this.emit?.({ t: Date.now(), gpus });
  }

  /** One-shot queries, each scheduled after the previous one finished (a hung driver must not pile up processes). */
  private startPolling(): void {
    const interval = this.intervalMs;
    const tick = async () => {
      const s = await this.queryOnce();
      if (this.intervalMs !== interval || !this.pollTimer) return;
      if (s) this.emit?.(s);
      this.pollTimer = setTimeout(tick, interval);
    };
    this.pollTimer = setTimeout(tick, 0);
  }

  /** GPU index for a uuid (from detection); -1 if unknown. */
  indexOf(uuid: string): number {
    return this.indexByUuid.get(uuid) ?? -1;
  }

  /**
   * Emit the compute-app list every `intervalMs` from one long-lived `nvidia-smi --query-compute-apps -lms` process
   * (NVML initialised once: ~5x cheaper than a one-shot query per sample). Falls back to one-shot polling if the
   * stream keeps dying. Without per-process support (WSL) or GPUs it emits a single empty list.
   */
  async startApps(intervalMs: number, emit: (apps: GpuApp[]) => void): Promise<void> {
    this.appsEmit = emit;
    if (this.appsInterval === intervalMs && (this.appsChild || this.appsPollTimer)) return;
    this.stopApps();
    this.appsInterval = intervalMs;
    if (!(await this.detect()) || !this.appsSupported) {
      if (this.appsInterval === intervalMs) emit([]);
      return;
    }
    if (this.appsInterval !== intervalMs) return;
    if (this.appsFailures >= 3) this.startAppsPolling();
    else this.startAppsStream();
  }

  stopApps(): void {
    this.appsInterval = 0;
    if (this.appsChild) {
      const c = this.appsChild;
      this.appsChild = undefined;
      c.kill();
    }
    clearTimeout(this.appsPollTimer);
    clearTimeout(this.appsBurstTimer);
    clearTimeout(this.appsIdleTimer);
    this.appsPollTimer = this.appsBurstTimer = this.appsIdleTimer = undefined;
    this.appsPending = [];
  }

  private startAppsStream(): void {
    const interval = this.appsInterval;
    this.appsHeartbeat = -1;
    this.appsStalls = 0;
    const child = spawnLines(
      this.binary!,
      [APPS_QUERY, FORMAT, '-lms', String(interval)],
      (line) => this.onAppLine(line),
      () => {
        if (this.appsChild !== child) return; // stopped on purpose
        this.appsChild = undefined;
        this.appsFailures++;
        clearTimeout(this.appsBurstTimer);
        clearTimeout(this.appsIdleTimer);
        this.appsPending = [];
        const retry = () => this.appsInterval === interval && !this.appsChild && !this.appsPollTimer && (this.appsFailures >= 3 ? this.startAppsPolling() : this.startAppsStream());
        if (this.appsInterval === interval) setTimeout(retry, 2000);
      },
    );
    this.appsChild = child;
    this.armAppsIdle(Math.min(interval, APPS_FIRST_CYCLE_MS));
  }

  private onAppLine(line: string): void {
    const a = parseGpuApps(line)[0];
    if (!a) return;
    clearTimeout(this.appsIdleTimer);
    this.appsPending.push(a);
    clearTimeout(this.appsBurstTimer);
    this.appsBurstTimer = setTimeout(() => this.flushApps(), APPS_BURST_MS);
  }

  private flushApps(): void {
    const apps = this.appsPending;
    this.appsPending = [];
    this.appsFailures = 0;
    this.appsStalls = 0;
    this.appsEmit?.(apps);
    this.appsHeartbeat = probe(this.appsChild?.pid)?.beat ?? -1;
    this.armAppsIdle(this.appsInterval * 1.5 + 500);
  }

  /** No cycle output by `ms`: an empty cycle — unless nvidia-smi made no progress at all (wedged driver). */
  private armAppsIdle(ms: number): void {
    clearTimeout(this.appsIdleTimer);
    this.appsIdleTimer = setTimeout(() => {
      const child = this.appsChild;
      if (!child) return;
      const p = probe(child.pid);
      if (p && (p.blocked || p.beat === this.appsHeartbeat)) {
        // Keep the last list rather than claiming the GPUs are idle; restart a stream that stays stuck.
        if (++this.appsStalls >= 3) child.kill('SIGKILL');
      } else {
        this.appsStalls = 0;
        this.appsEmit?.([]);
      }
      this.appsHeartbeat = p?.beat ?? -1;
      this.armAppsIdle(this.appsInterval);
    }, ms);
  }

  /** One-shot queries, each scheduled after the previous one finished (a hung driver must not pile up processes). */
  private startAppsPolling(): void {
    const interval = this.appsInterval;
    const tick = async () => {
      const apps = await this.queryApps();
      if (this.appsInterval !== interval || !this.appsPollTimer) return;
      this.appsEmit?.(apps);
      this.appsPollTimer = setTimeout(tick, interval);
    };
    this.appsPollTimer = setTimeout(tick, 0);
  }

  async queryOnce(): Promise<GpuSample | undefined> {
    if (!(await this.detect())) return undefined;
    const r = await runExclusive('nvidia-smi:gpus', this.binary!, [QUERY, FORMAT], { timeoutMs: 10000 });
    const gpus = r.stdout.split('\n').map(parseGpuLine).filter((g): g is GpuInfo => !!g);
    return gpus.length ? { t: Date.now(), gpus } : undefined;
  }

  async queryApps(): Promise<GpuApp[]> {
    if (!(await this.detect()) || !this.appsSupported) return [];
    const r = await runExclusive('nvidia-smi:apps', this.binary!, [APPS_QUERY, FORMAT], { timeoutMs: 10000 });
    return parseGpuApps(r.stdout);
  }

  /** CUDA version only appears in the plain table header; fetched once, lazily. */
  async fetchCudaVersion(): Promise<string | undefined> {
    if (this.cudaVersion !== undefined || !(await this.detect())) return this.cudaVersion;
    const r = await run(this.binary!, [], { timeoutMs: 15000 });
    this.cudaVersion = /CUDA Version:\s*([\d.]+)/.exec(r.stdout)?.[1] ?? '';
    return this.cudaVersion;
  }
}

/**
 * Liveness of a `-lms` process: its voluntary context switches grow every cycle (it sleeps between queries), and it is
 * not stuck in uninterruptible sleep (a wedged driver) or stopped. undefined = cannot tell (not Linux).
 */
function probe(pid: number | undefined): { beat: number; blocked: boolean } | undefined {
  if (pid === undefined || process.platform !== 'linux') return undefined;
  const text = readProc(`/proc/${pid}/status`);
  const beat = text && /^voluntary_ctxt_switches:\s*(\d+)/m.exec(text);
  if (!beat) return undefined;
  return { beat: Number(beat[1]), blocked: /^State:\s*[DTt]/m.test(text) };
}

export interface FreeContext {
  /** GPU indexes that have at least one compute process, when the per-process list is known and fresh. */
  busy?: Set<number>;
  /** The driver cannot list processes at all (WSL). */
  noProcessInfo?: boolean;
}

/**
 * Idle: low utilisation and no compute work. A desktop GPU (WSL, local Linux with a display) always holds some memory
 * for the compositor and browsers, so once compute processes are known — or can never be known — memory only counts
 * when it is substantial (a third of the card). With process info supported but not loaded yet, stay strict.
 */
export function isGpuFree(g: GpuInfo, freeMemMiB: number, freeUtil: number, ctx: FreeContext = {}): boolean {
  if (!(isNaN(g.util) || g.util < freeUtil)) return false;
  if (ctx.busy?.has(g.index)) return false;
  if (isNaN(g.memUsed)) return true;
  const relaxed = ctx.busy !== undefined || ctx.noProcessInfo;
  const limit = relaxed && g.memTotal > 0 ? Math.max(freeMemMiB, g.memTotal / 3) : freeMemMiB;
  return g.memUsed < limit;
}
