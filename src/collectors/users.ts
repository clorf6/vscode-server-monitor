import { GpuInfo, GpuApp } from './parsers';
import { ProcInfo } from './processes';

export interface UserUsage {
  uid: number;
  cpu: number; // % of one core
  rss: number;
  procs: number;
  gpus: number[]; // GPU indexes with at least one of the user's processes
  gpuMem: number; // MiB
}

/** Per-user totals from a full process scan plus GPU compute apps (whose pids are mapped to uids via the scan). */
export function aggregateUsers(procs: ProcInfo[], apps: GpuApp[], gpus: GpuInfo[]): UserUsage[] {
  const by = new Map<number, UserUsage>();
  const get = (uid: number) => {
    let u = by.get(uid);
    if (!u) by.set(uid, (u = { uid, cpu: 0, rss: 0, procs: 0, gpus: [], gpuMem: 0 }));
    return u;
  };
  const uidOf = new Map<number, number>();
  for (const p of procs) {
    uidOf.set(p.pid, p.uid);
    const u = get(p.uid);
    u.cpu += p.cpu;
    u.rss += p.rss;
    u.procs++;
  }
  const indexOf = new Map(gpus.map((g) => [g.uuid, g.index]));
  for (const a of apps) {
    const uid = uidOf.get(a.pid);
    if (uid === undefined) continue;
    const u = get(uid);
    if (isFinite(a.memMiB)) u.gpuMem += a.memMiB;
    const idx = indexOf.get(a.uuid);
    if (idx !== undefined && !u.gpus.includes(idx)) u.gpus.push(idx);
  }
  for (const u of by.values()) u.gpus.sort((a, b) => a - b);
  return [...by.values()];
}
