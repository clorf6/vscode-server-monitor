// Message protocol between the dashboard host (src/views/dashboard.ts) and its webview (webview/main.ts).
// Types only: both bundles import this with `import type`, so nothing from here ends up in either bundle.

/** A number that may be unavailable. NaN does not survive postMessage's JSON encoding, so the host sends null. */
export type N = number | null;

/** Keys of the translated strings the host sends in `init` (values come from literal `l10n.t()` calls). */
export type StringKey =
  | 'range' | 'min' | 'copyFree' | 'watchFree' | 'pickGpus' | 'refresh' | 'settings' | 'openProcs'
  | 'cores' | 'ram' | 'uptime' | 'usersOnline' | 'driver' | 'cuda' | 'cgMem' | 'cgCpu'
  | 'cpu' | 'memory' | 'gpusFree' | 'network' | 'diskIo' | 'load' | 'usedOfTotal' | 'avgUtil'
  | 'down' | 'up' | 'read' | 'write'
  | 'cpuUsage' | 'loadAvg' | 'perCore' | 'core' | 'busiest' | 'heatAria'
  | 'used' | 'cache' | 'free' | 'swap' | 'noSwap' | 'memUsage'
  | 'gpus' | 'util' | 'memUsed' | 'temp' | 'power' | 'inUse' | 'gpuUsers' | 'noGpuProcs' | 'filterHint'
  | 'topProcs' | 'pid' | 'user' | 'cpuPct' | 'gpuMem' | 'command' | 'users' | 'procsCol'
  | 'disks' | 'mount' | 'fstype' | 'usage' | 'usedTotal' | 'status' | 'ok' | 'timeout' | 'error' | 'pending' | 'home'
  | 'you' | 'onlyGpu' | 'clearFilter' | 'noProcsOnGpu' | 'scanning' | 'totalProcs' | 'noProcSupport' | 'waiting' | 'noDisks';

/** History in a compact form: timestamps are delta-encoded (t[i] = t0 + dt[1] + … + dt[i]). */
export interface Snapshot {
  t0: number;
  dt: number[];
  series: Record<string, N[]>;
}

export interface MemInfo {
  total: number;
  used: number;
  /** MemFree (never used); the rest of `available` is reclaimable cache. */
  free: number;
  cache: number;
  available: number;
  swapTotal: number;
  swapUsed: number;
  percent: N;
}

export interface CoreMsg {
  type: 'core';
  t: number;
  cpu: N;
  /** Per logical core, integer %. */
  cores: N[];
  load: number[];
  mem: MemInfo;
  /** Bytes/s. */
  rx: N;
  tx: N;
  dr: N;
  dw: N;
}

export interface GpuCard {
  i: number;
  name: string;
  util: N;
  memUsed: N; // MiB
  memTotal: N; // MiB
  temp: N;
  power: N;
  powerLimit: N;
  free: boolean;
  users: string[];
}

export interface GpuMsg {
  type: 'gpu';
  t: number;
  gpus: GpuCard[];
}

export interface ProcRow {
  pid: number;
  user: string;
  me: boolean;
  /** % of one core; null for GPU processes outside the process scan (other pid namespaces). */
  cpu: N;
  rss: N;
  /** [gpu index, MiB] per GPU the process uses. */
  gpu: [number, number][];
  cmd: string;
  /** Full command line; sent only the first time a pid appears (the webview caches it by pid). */
  full?: string;
}

export interface UserRow {
  name: string;
  me: boolean;
  cpu: N;
  rss: number;
  gpus: number[];
  gpuMem: N; // MiB
  procs: number;
}

export interface ProcsMsg {
  type: 'procs';
  supported: boolean;
  scope: 'mine' | 'all';
  total: number;
  /** Top processes by CPU, followed by GPU processes that are not among them. */
  procs: ProcRow[];
  users: UserRow[];
}

export interface DiskRow {
  mount: string;
  fstype: string;
  device: string;
  total: N;
  used: N;
  percent: N;
  status: 'ok' | 'timeout' | 'error' | 'pending';
  network: boolean;
  home: boolean;
}

export interface DisksMsg {
  type: 'disks';
  mounts: DiskRow[];
}

export interface SysMsg {
  type: 'sys';
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  memTotal: number;
  uptime: number; // s
  users: string[];
  conn: string;
  driver: string | null;
  cuda: string | null;
  cgroupMem: N;
  cgroupCpus: N;
}

export interface HistoryMsg {
  type: 'history';
  /** Minutes. */
  range: number;
  core: Snapshot; // cpu, mem, rx, tx, dr, dw
  gpu: Snapshot; // u<i> (util %), m<i> (memory used %)
}

export interface InitMsg {
  type: 'init';
  strings: Record<StringKey, string>;
  ranges: number[];
  /** False when nvidia-smi is missing or reports no GPU; null while detection is still running. */
  gpuAvailable: boolean | null;
  sys: SysMsg;
  history: HistoryMsg;
  core?: CoreMsg;
  gpu?: GpuMsg;
  procs?: ProcsMsg;
  disks?: DisksMsg;
}

export type HostMsg = InitMsg | CoreMsg | GpuMsg | ProcsMsg | DisksMsg | SysMsg | HistoryMsg;

export type ViewMsg = { type: 'ready' } | { type: 'range'; minutes: number } | { type: 'command'; id: string };
