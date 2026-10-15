import * as fs from 'fs';
import { isLinux } from './core';
import { parseCmdline, parsePidStat, parseProcStat } from './parsers';
import { run } from '../util/exec';
import { listPids, pidUid, readProc } from '../util/procfs';

export interface ProcInfo {
  pid: number;
  ppid: number;
  uid: number;
  comm: string;
  state: string;
  cpu: number; // % of one core (can exceed 100)
  rss: number; // bytes
  start: number; // epoch ms
  threads: number;
}

export interface ProcSnapshot {
  t: number;
  procs: ProcInfo[];
  /** Number of processes on the system (including ones skipped by the uid filter). */
  total: number;
  supported: boolean;
}

const HZ = 100; // USER_HZ is 100 on every mainstream Linux userland
const BATCH = 256;
/** Cached uids are fully re-checked every Nth listing (a process may setuid() after we first saw it: sshd, cron, sudo). */
const UID_RECHECK = 10;
/**
 * Kernel threads (children of kthreadd) are re-read on every Nth full scan only. A busy server has ~1000 of them and
 * their /proc/<pid>/stat reads are ~30% of an all-users scan; in between they keep their last values, and since every
 * baseline has its own timestamp their CPU% is still exact, just averaged over a longer window.
 */
const KTHREAD_EVERY = 3;

/** CPU baseline of one process: tick count when it was last read, and when. */
interface Baseline {
  ticks: number;
  startTicks: number;
  t: number;
}

/**
 * Scans /proc. Uses synchronous reads into a shared buffer (3 syscalls per process, no thread-pool round trips) and
 * yields to the event loop every BATCH processes so the extension host never blocks for long. The /proc listing
 * itself is shared (see listPids) and runs off the event loop.
 */
export class ProcessCollector {
  private prev = new Map<number, Baseline>();
  private cmdCache = new Map<number, { start: number; cmd: string }>();
  /** pid → uid as of the last listing. stat()ing every /proc/<pid> is a third of a full scan, so uids are cached. */
  private uids = new Map<number, number>();
  private listedAt = 0;
  /** Last scan that listed /proc: when, and for which uid filter (null = everyone). */
  private lastFull?: { t: number; uid: number | null };
  private listings = 0;
  /** Last info of kernel threads, and the full-scan counter that decides when they are re-read. */
  private kthreads = new Map<number, ProcInfo>();
  private kthreadRound = 0;
  private total = 0;
  private btime = 0;
  private pageSize = 4096;

  constructor() {
    if (!isLinux) return;
    try {
      this.btime = parseProcStat(fs.readFileSync('/proc/stat', 'utf8')).btime;
    } catch {
      /* ignore */
    }
    void run('getconf', ['PAGESIZE'], { timeoutMs: 2000 }).then((r) => {
      const n = Number(r.stdout.trim());
      if (n > 0) this.pageSize = n;
    });
  }

  /**
   * @param onlyUid when set, other users' processes are counted but not read.
   * @param discover list /proc to find new processes. On hosts with tens of thousands of threads the listing alone
   *   costs ~6–15 ms of kernel time, so filtered scans may skip it and just refresh the processes already known.
   */
  async scan(onlyUid?: number, discover = true): Promise<ProcSnapshot> {
    const t = Date.now();
    if (!isLinux) return { t, procs: [], total: 0, supported: false };
    const full = discover || onlyUid === undefined || !this.listedAt;
    let pids: number[];
    if (full) {
      pids = await listPids();
      this.total = pids.length;
    } else {
      pids = [];
      for (const [pid, uid] of this.uids) if (uid === onlyUid) pids.push(pid);
    }

    const recheck = full && this.listings++ % UID_RECHECK === 0;
    const uids = full ? new Map<number, number>() : this.uids;
    const next = new Map<number, Baseline>();
    const procs: ProcInfo[] = [];
    const readKthreads = !full || this.kthreadRound++ % KTHREAD_EVERY === 0;
    const kthreads = full ? new Map<number, ProcInfo>() : this.kthreads;
    let now = Date.now();
    for (let i = 0; i < pids.length; i++) {
      if (i > 0 && i % BATCH === 0) {
        await new Promise((r) => setImmediate(r));
        now = Date.now();
      }
      const pid = pids[i];
      let uid = recheck ? undefined : this.uids.get(pid);
      if (uid === undefined && (uid = pidUid(pid)) === undefined) {
        if (!full) uids.delete(pid);
        continue; // exited
      }
      if (full) uids.set(pid, uid);
      if (onlyUid !== undefined && uid !== onlyUid) continue;
      const kt = readKthreads ? undefined : this.kthreads.get(pid);
      if (kt) {
        const b = this.prev.get(pid);
        if (b) next.set(pid, b);
        kthreads.set(pid, kt);
        procs.push(kt);
        continue;
      }
      const text = readProc(`/proc/${pid}/stat`);
      const st = text && parsePidStat(text);
      if (!st) {
        if (!full) uids.delete(pid);
        continue;
      }
      const p = this.prev.get(pid);
      if (p && p.startTicks !== st.startTicks) {
        // pid was reused: the cached uid may belong to the previous owner.
        const u = pidUid(pid);
        if (u === undefined) continue;
        uid = u;
        uids.set(pid, uid);
        if (onlyUid !== undefined && uid !== onlyUid) continue;
      }
      next.set(pid, { ticks: st.ticks, startTicks: st.startTicks, t: now });
      // Each baseline carries its own timestamp, so the rate is right however old it is (e.g. other users' processes
      // last read by an "all" scan a minute ago).
      const cpu = p && p.startTicks === st.startTicks && now > p.t ? Math.max(0, ((st.ticks - p.ticks) / HZ / ((now - p.t) / 1000)) * 100) : 0;
      const info: ProcInfo = {
        pid,
        ppid: st.ppid,
        uid,
        comm: st.comm,
        state: st.state,
        cpu,
        rss: st.rssPages * this.pageSize,
        start: (this.btime + st.startTicks / HZ) * 1000,
        threads: st.threads,
      };
      // Only kernel threads with a valid rate may be skipped next time (else they would show 0% for a while).
      if ((st.ppid === 2 || pid === 2) && p && p.startTicks === st.startTicks) kthreads.set(pid, info);
      procs.push(info);
    }
    // Keep baselines of processes skipped this round (other users) so widening the filter later has rates at once.
    if (onlyUid !== undefined) for (const [pid, v] of this.prev) if (!next.has(pid) && uids.has(pid) && uids.get(pid) !== onlyUid) next.set(pid, v);
    if (full) {
      this.kthreads = kthreads;
      this.uids = uids;
      this.listedAt = t;
      this.lastFull = { t, uid: onlyUid ?? null };
    }
    this.prev = next;
    for (const pid of this.cmdCache.keys()) if (!next.has(pid)) this.cmdCache.delete(pid);
    return { t, procs, total: this.total, supported: true };
  }

  /**
   * Whether a single scan for `onlyUid` yields valid CPU rates: a scan covering that scope ran within `maxAgeMs`.
   * Otherwise the scheduler takes a quick baseline first (warm-up).
   */
  hasBaseline(onlyUid: number | undefined, maxAgeMs = 30_000): boolean {
    const f = this.lastFull;
    if (!f || Date.now() - f.t > maxAgeMs) return false;
    return f.uid === null || f.uid === onlyUid;
  }

  /** pids owned by `uid` as of the last /proc listing, if that is at most `maxAgeMs` old. */
  pidsOf(uid: number, maxAgeMs: number): number[] | undefined {
    if (!this.listedAt || Date.now() - this.listedAt > maxAgeMs) return undefined;
    const out: number[] = [];
    for (const [pid, u] of this.uids) if (u === uid) out.push(pid);
    return out;
  }

  /** Cached owner of a pid from the last listing (undefined if unknown). */
  cachedUid(pid: number): number | undefined {
    return this.uids.get(pid);
  }

  /** Full command line (cached per pid+start time). Falls back to `[comm]` for kernel threads. */
  cmdline(p: Pick<ProcInfo, 'pid' | 'start' | 'comm'>): string {
    const c = this.cmdCache.get(p.pid);
    if (c && c.start === p.start) return c.cmd;
    const raw = readProc(`/proc/${p.pid}/cmdline`);
    const cmd = (raw && parseCmdline(raw.slice(0, 8192))) || `[${p.comm}]`;
    this.cmdCache.set(p.pid, { start: p.start, cmd });
    return cmd;
  }

  async details(pid: number): Promise<{ cwd?: string; exe?: string }> {
    const [cwd, exe] = await Promise.all([fs.promises.readlink(`/proc/${pid}/cwd`).catch(() => undefined), fs.promises.readlink(`/proc/${pid}/exe`).catch(() => undefined)]);
    return { cwd, exe };
  }

  /** Cheap liveness check used by exit watchers: same pid and same start time. */
  isAlive(pid: number, start?: number): boolean {
    const text = readProc(`/proc/${pid}/stat`);
    const st = text && parsePidStat(text);
    if (!st) return false;
    if (st.state === 'Z') return false;
    return start === undefined || Math.abs((this.btime + st.startTicks / HZ) * 1000 - start) < 1500;
  }

  startTimeOf(pid: number): number | undefined {
    const text = readProc(`/proc/${pid}/stat`);
    const st = text && parsePidStat(text);
    return st ? (this.btime + st.startTicks / HZ) * 1000 : undefined;
  }
}
