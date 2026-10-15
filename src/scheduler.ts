import { Disposable, Emitter } from './util/emitter';

/**
 * fg: wanted only while the user is looking (status bar, visible views, dashboard).
 * bg: needed even when the window is unfocused (alerts/watchers) — runs at the background interval.
 */
export type DemandKind = 'fg' | 'bg';

export interface DemandOptions {
  /**
   * This consumer is happy with data at most this often (ms). The source runs at the fastest interval any active demand
   * asks for, so e.g. a status bar asking for 5 s does not force the 2 s base interval when no view is visible.
   */
  minInterval?: number;
}

/** The variance-free part of a Source that consumers holding several sources need. */
export interface Demandable {
  demand(key: string, kind?: DemandKind, opts?: DemandOptions): Disposable;
}

export interface SourceImpl<T> {
  interval: () => number;
  /** One sample. A stream source may also have one: it then serves fetch() and refresh() without a standing stream. */
  poll?: () => Promise<T>;
  stream?: { start(intervalMs: number, emit: (v: T) => void): void; stop(): void };
  /** Rate-based samples need a baseline: poll twice when data is missing or stale. */
  warmup?: boolean;
  /** Gap between the baseline poll and the published one (default WARMUP_MS). */
  warmupMs?: number;
  /** For warm-up sources: the collector still holds a usable baseline, so a single poll yields a valid rate. */
  hasBaseline?: () => boolean;
  /**
   * Values equal to the latest are not re-published (updatedAt still advances). Saves tree/webview re-renders for
   * sources that rarely change (tmux, ports, disks, docker, GPU apps).
   */
  same?: (a: T, b: T) => boolean;
}

/** Default warm-up gap: long enough for meaningful CPU deltas (USER_HZ = 100 → 3% steps per process), short for first paint. */
export const WARMUP_MS = 300;

interface DemandEntry {
  kind: DemandKind;
  minInterval: number;
}

/**
 * A data source that only runs while something demands it. Polls never overlap; the next poll is scheduled after the
 * previous one finished, so a slow collector cannot pile up work.
 */
export class Source<T> implements Demandable {
  latest?: T;
  updatedAt = 0;
  error?: string;
  readonly onData = new Emitter<T>();
  readonly onError = new Emitter<string>();
  private demands = new Map<string, DemandEntry>();
  private timer?: NodeJS.Timeout;
  private slowTimer?: NodeJS.Timeout;
  private running = false;
  private current?: number;

  constructor(
    readonly name: string,
    private readonly sched: Scheduler,
    private readonly impl: SourceImpl<T>,
  ) {}

  demand(key: string, kind: DemandKind = 'fg', opts?: DemandOptions): Disposable {
    const entry: DemandEntry = { kind, minInterval: Math.max(0, opts?.minInterval ?? 0) };
    this.demands.set(key, entry);
    this.reconcile();
    return {
      dispose: () => {
        // Only our own registration: a later demand() under the same key replaced it and is not ours to remove.
        if (this.demands.get(key) === entry) {
          this.demands.delete(key);
          this.reconcile();
        }
      },
    };
  }

  get active(): boolean {
    return this.current !== undefined;
  }

  /** The interval the source runs at right now (undefined = stopped). */
  get interval(): number | undefined {
    return this.current;
  }

  effectiveInterval(): number | undefined {
    if (!this.demands.size) return undefined;
    const base = this.impl.interval();
    const background = Math.max(base, this.sched.backgroundIntervalMs);
    let best: number | undefined;
    for (const d of this.demands.values()) {
      let iv: number | undefined;
      if (d.kind === 'bg') iv = background;
      else if (this.sched.focused) iv = base;
      else if (this.sched.backgroundMode === 'slow') iv = background;
      if (iv === undefined) continue;
      iv = Math.max(iv, d.minInterval);
      if (best === undefined || iv < best) best = iv;
    }
    return best;
  }

  reconcile(): void {
    const iv = this.effectiveInterval();
    if (this.impl.stream && iv !== undefined && this.current !== undefined && iv > this.current && this.sched.streamSlowdownMs > 0) {
      // Slowing a stream down means restarting its process (NVML init ≈ 50 ms CPU); wait a little in case the faster
      // consumer comes right back (view toggled, quick alt-tab).
      if (!this.slowTimer) {
        this.slowTimer = setTimeout(() => {
          this.slowTimer = undefined;
          this.apply(this.effectiveInterval());
        }, this.sched.streamSlowdownMs);
      }
      return;
    }
    this.apply(iv);
  }

  private apply(iv: number | undefined): void {
    clearTimeout(this.slowTimer);
    this.slowTimer = undefined;
    if (iv === this.current) return;
    this.current = iv;
    if (this.impl.stream) {
      if (iv === undefined) this.impl.stream.stop();
      else this.impl.stream.start(iv, (v) => this.publish(v));
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    if (iv !== undefined && !this.running) this.schedule(Math.max(0, this.updatedAt + iv - Date.now()));
  }

  /** Poll as soon as possible (e.g. after a user action changed the state). */
  refresh(): void {
    if (!this.impl.poll || this.running || this.current === undefined) return;
    if (this.impl.stream) void this.tick();
    else this.schedule(0);
  }

  /** One-off poll for consumers that need data even without a standing demand. */
  async fetch(): Promise<T | undefined> {
    if (this.latest !== undefined && Date.now() - this.updatedAt < (this.current ?? this.impl.interval())) return this.latest;
    if (this.impl.poll && !this.running) await this.tick();
    return this.latest;
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (this.running) return; // the run in progress reschedules when it finishes
    clearTimeout(this.timer);
    this.timer = undefined;
    this.running = true;
    try {
      const stale = !this.updatedAt || Date.now() - this.updatedAt > 3 * this.impl.interval() + 1000;
      if (this.impl.warmup && stale && !this.impl.hasBaseline?.()) {
        await this.impl.poll!();
        await new Promise((r) => setTimeout(r, this.impl.warmupMs ?? WARMUP_MS));
      }
      this.publish(await this.impl.poll!());
      this.error = undefined;
    } catch (err) {
      this.error = String((err as Error)?.message ?? err);
      this.onError.fire(this.error);
    } finally {
      this.running = false;
    }
    // Streams deliver on their own; polls reschedule after they finished so they never overlap.
    if (!this.impl.stream && this.current !== undefined && !this.timer) this.schedule(this.current);
  }

  private publish(v: T): void {
    const prev = this.latest;
    this.updatedAt = Date.now();
    if (prev !== undefined && this.impl.same?.(prev, v)) return;
    this.latest = v;
    this.onData.fire(v);
  }

  dispose(): void {
    this.demands.clear();
    this.apply(undefined);
    this.onData.dispose();
    this.onError.dispose();
  }
}

export class Scheduler {
  focused = true;
  backgroundMode: 'slow' | 'pause' = 'slow';
  backgroundIntervalMs = 15000;
  /** How long a stream keeps its faster interval after the consumer that needed it left (0 = switch at once). */
  streamSlowdownMs = 10000;
  private sources: { reconcile(): void; dispose(): void }[] = [];

  source<T>(name: string, impl: SourceImpl<T>): Source<T> {
    const s = new Source<T>(name, this, impl);
    this.sources.push(s);
    return s;
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.reconcileAll();
  }

  /** Re-evaluate intervals after a configuration change. */
  reconcileAll(): void {
    for (const s of this.sources) s.reconcile();
  }

  dispose(): void {
    for (const s of this.sources) s.dispose();
    this.sources = [];
  }
}

/** Structural equality for plain data (JSON-like values; NaN equals NaN). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'number') return Number.isNaN(a) && Number.isNaN(b as number);
  if (!a || !b || typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}
