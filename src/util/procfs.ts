import * as fs from 'fs';

let shared = Buffer.allocUnsafe(64 * 1024);

/**
 * Synchronous read of a small pseudo-file (/proc, /sys) into a shared buffer. For these files a sync read costs a few
 * microseconds, while fs.promises.readFile costs several thread-pool round trips — 4–5x more CPU per sample.
 */
export function readProc(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path, 'r');
    let len = 0;
    for (;;) {
      if (len === shared.length) {
        const bigger = Buffer.allocUnsafe(shared.length * 2);
        shared.copy(bigger, 0, 0, len);
        shared = bigger;
      }
      const n = fs.readSync(fd, shared, len, shared.length - len, null);
      if (n <= 0) break;
      len += n;
    }
    return shared.toString('utf8', 0, len);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Owner uid of a process, without throwing (an exception per exited pid costs more than the stat). */
export function pidUid(pid: number): number | undefined {
  try {
    return fs.statSync(`/proc/${pid}`, { throwIfNoEntry: false })?.uid;
  } catch {
    return undefined;
  }
}

/** How long one /proc listing is shared between consumers (process scan, port owner lookup). */
export const PID_LIST_TTL_MS = 1000;

let listing: { at: number; pids: number[] } | undefined;
let inflight: Promise<number[]> | undefined;

/**
 * Process ids currently in /proc. Listing /proc walks every task in the pid namespace — ~6–15 ms of kernel time on a
 * host with ~70k threads — so it runs on the thread pool (the event loop stays free) and one result is shared by
 * every caller within `maxAgeMs`. Concurrent callers share the listing in flight.
 */
export function listPids(maxAgeMs = PID_LIST_TTL_MS): Promise<number[]> {
  if (listing && Date.now() - listing.at <= maxAgeMs) return Promise.resolve(listing.pids);
  if (!inflight) {
    const at = Date.now();
    inflight = fs.promises
      .readdir('/proc')
      .then(
        (entries) => {
          const pids: number[] = [];
          for (const e of entries) {
            const c = e.charCodeAt(0);
            if (c >= 48 && c <= 57) pids.push(Number(e));
          }
          listing = { at, pids };
          return pids;
        },
        () => [] as number[],
      )
      .finally(() => (inflight = undefined));
  }
  return inflight;
}

/** Testing hook: forget the shared listing. */
export function resetPidList(): void {
  listing = undefined;
}
