// Message protocol between the sidebar panel host (src/views/overview.ts, overviewPages.ts) and its webview
// (webview/overview.ts + webview/ov/*). Types only: both sides import this with `import type`, so nothing from here
// ends up in either bundle.

/** A number that may be unavailable (NaN does not survive postMessage's JSON encoding). */
export type N = number | null;

/** Keys of the translated strings the host sends in `init` (values come from literal `l10n.t()` calls). */
export type OvKey =
  | 'title' | 'openDash' | 'refresh' | 'uptime' | 'segs' | 'tabMon' | 'tabGpu' | 'tabTools' | 'pages'
  | 'pOv' | 'pProc' | 'pPort' | 'pDisk' | 'pGpu' | 'pUser' | 'pTmux' | 'pTools' | 'pDu' | 'pWatch' | 'pDocker'
  | 'attnBadge' | 'locate' | 'more' | 'less' | 'dismiss'
  | 'cpu' | 'mem' | 'gpu' | 'disk' | 'net' | 'uptimeL' | 'coresLoad' | 'usedOfTotal' | 'noGpu' | 'gpuSub' | 'gpuMemTip' | 'memTip' | 'noSwap'
  | 'down' | 'up' | 'dh' | 'hm' | 'mm' | 'checking' | 'notResp' | 'waiting' | 'loading' | 'linuxOnly'
  | 'openProcs' | 'showMem' | 'showGpus' | 'showDisks'
  | 'cat' | 'moodCalm' | 'moodBusy' | 'moodHot' | 'moodGpu' | 'freeUp' | 'freeUpNote'
  | 'free' | 'inUse' | 'util' | 'vram' | 'copyCuda' | 'exportCuda' | 'notifyFree' | 'watching' | 'selected' | 'freeSel' | 'noneFree'
  | 'clear' | 'noGpuTitle' | 'noGpuHint' | 'you' | 'youTag'
  | 'dashboard' | 'pickGpus' | 'watchFree' | 'newTmux' | 'du' | 'settings' | 'quick' | 'add' | 'run' | 'remove' | 'noQuick'
  | 'copied' | 'actions' | 'moreActions'
  // processes
  | 'mine' | 'allUsers' | 'scope' | 'search' | 'searchPh' | 'sortBy' | 'sCpu' | 'sMem' | 'sGpu' | 'sTime' | 'colProc' | 'colCpu' | 'colMem' | 'colGpu'
  | 'nProcs' | 'nMatched' | 'scanningAll' | 'noProcs' | 'noMatch' | 'showMoreN' | 'pidL' | 'ppidL' | 'threadsL' | 'startedAgo' | 'runFor' | 'ago'
  | 'stR' | 'stS' | 'stD' | 'stZ' | 'stT' | 'stI'
  | 'aWatch' | 'aCwd' | 'aCopyPid' | 'aCopyCmd' | 'aInt' | 'aTerm' | 'aKill' | 'otherUserNote'
  // ports
  | 'myPorts' | 'otherPorts' | 'noPorts' | 'noMyPorts' | 'loopback' | 'allIfaces' | 'aOpen' | 'aOpenEditor' | 'aCopyUrl' | 'aKillPort' | 'portsHint' | 'portsCapped'
  // disks
  | 'ioRead' | 'ioWrite' | 'diskIo' | 'noDisks' | 'homeTag' | 'netTag' | 'freeOf' | 'aAnalyze' | 'aTermHere' | 'aCopyPath' | 'diskTimeoutHint'
  // users
  | 'usersHint' | 'noUsers' | 'nProcsShort' | 'userProcsTip' | 'coresUsed'
  // tmux
  | 'tmuxMissing' | 'tmuxEmpty' | 'tmuxEmptyHint' | 'newSession' | 'nWindows' | 'nPanes' | 'nRunning' | 'attachedTag' | 'idleTag' | 'aAttach' | 'aPeek' | 'aWatchCmd' | 'aCtrlC'
  | 'aRename' | 'aKillSession' | 'aKillPane' | 'aKillWindow' | 'runningTip' | 'deadTip' | 'created'
  // folder sizes
  | 'duChoose' | 'duUp' | 'duRescan' | 'duCancel' | 'duScanningFor' | 'duEmptyTitle' | 'duEmptyHint' | 'duRecent' | 'duPlaces'
  | 'duPartial' | 'duSmaller' | 'duEmptyFolder' | 'duCancelled' | 'duFailed' | 'duScanned' | 'duTotal' | 'duAlsoScanning' | 'duOpenIn' | 'duCrumbs'
  // watches
  | 'wEmpty' | 'wEmptyHint' | 'wSince' | 'wAddGpu' | 'wClear' | 'wHintProc' | 'wHintTmux' | 'wGoProc' | 'wGoTmux' | 'wAlerts' | 'wAlertsOff'
  // docker
  | 'dkDisabled' | 'dkNoSocket' | 'dkNoPerm' | 'dkError' | 'dkEmpty' | 'dkRunning' | 'aStart' | 'aStop' | 'aRestart' | 'aLogs' | 'aExec' | 'aCopyId'
  // I/O, pressure, temperatures, GPU health
  | 'io' | 'ioTip' | 'ioNone' | 'split' | 'steal' | 'stall' | 'psiCpu' | 'psiMem' | 'psiIo' | 'psiNote' | 'swapLine' | 'swapping'
  | 'await' | 'iops' | 'physDisks' | 'busy' | 'onDisk' | 'inodes' | 'fillEta' | 'fillRate' | 'temp'
  | 'slowPower' | 'slowThermal' | 'slowHw' | 'slowTip' | 'clock' | 'pcie' | 'pcieDown' | 'ecc' | 'idleHeld' | 'idleHeldTip' | 'sIo';

/** Primary sections (the segmented control) and the pages inside them (the underline tabs). */
export type Seg = 'mon' | 'gpu' | 'tools';
export type Page = 'ov' | 'proc' | 'port' | 'disk' | 'gpu' | 'user' | 'tmux' | 'tools' | 'du' | 'watch' | 'docker';

export type ProcSort = 'cpu' | 'mem' | 'gpu' | 'io' | 'time';
export type Scope = 'mine' | 'all';

/** What the process page asks for; the host answers with at most `limit` rows. */
export interface ProcQuery {
  scope: Scope;
  /** Text / PID / `user:NAME` terms, space separated, all must match. */
  q: string;
  sort: ProcSort;
  limit: number;
}

/** Navigation requests from commands (serverMonitor.locate, Explorer "analyze folder", …). */
export type Goto =
  | { page: 'proc'; q?: string; sort?: ProcSort; scope?: Scope }
  | { page: 'disk'; mount?: string }
  | { page: 'gpu'; index?: number }
  | { page: 'du'; path?: string }
  | { page: Exclude<Page, 'proc' | 'disk' | 'gpu' | 'du'> };

/** What a "Locate" action on an attention card points at (handled inside the webview). */
export type Locate = { kind: 'proc'; pid: number } | { kind: 'cpu' } | { kind: 'mem' } | { kind: 'disk'; mount: string } | { kind: 'gpu'; index: number };

export interface Attn {
  /** Stable per condition (e.g. `gpu:3`), so a dismissed card stays dismissed until the condition clears. */
  id: string;
  sev: 'warn' | 'crit';
  title: string;
  detail: string;
  loc: Locate;
}

export interface OvSys {
  hostname: string;
  conn: string;
  os: string;
  kernel: string;
  arch: string;
  cpuCount: number;
  /** Boot time, epoch ms (the webview derives the uptime from it). */
  boot: number;
}

export interface OvCfg {
  type: 'cfg';
  warn: number;
  crit: number;
  quick: { name: string; command: string }[];
}

/** One physical disk's activity. */
export interface IoRow {
  dev: string;
  /** % of the time it had I/O in flight. */
  util: N;
  r: N; // bytes/s
  w: N;
  iops: N;
  /** Average time per request, ms. */
  await: N;
  temp: N;
  /** Mounts on it. */
  mounts: string[];
}

export interface OvCore {
  type: 'core';
  t: number;
  cpu: N;
  load: number[];
  mem: { used: number; total: number; percent: N; cache: number; swapUsed: number; swapTotal: number };
  rx: N;
  tx: N;
  /** Disk read / write, bytes/s. */
  dr: N;
  dw: N;
  /** CPU time split, %: user, system, waiting for I/O, stolen (null before the second sample). */
  split: { u: N; s: N; w: N; st: N } | null;
  /** Hottest CPU package, °C. */
  cpuTemp: N;
  /** Stall pressure, % of the last 10 s ("some" tasks waiting), when the kernel reports it. */
  psi: { cpu: N; mem: N; io: N } | null;
  /** Swap traffic, bytes/s (in + out). */
  swapRate: N;
  /** Physical disks, busiest first. */
  disks: IoRow[];
}

export interface OvGpuRow {
  i: number;
  name: string;
  util: N;
  memUsed: N; // MiB
  memTotal: N; // MiB
  temp: N;
  power: N;
  powerLimit: N;
  free: boolean;
  /** Users with a process on this GPU (sorted). */
  users: string[];
  /** Why it runs below full clocks (empty: it does not, or the driver does not say). */
  slow: ('power' | 'thermal' | 'hardware')[];
  sm: N; // MHz
  smMax: N;
  pcie: { gen: N; genMax: N; width: N; widthMax: N } | null;
  /** Uncorrectable ECC errors since the driver loaded. */
  ecc: N;
  /** Idle while processes hold its memory: since when (epoch ms), how much (MiB), and whether that is long enough
   * (serverMonitor.gpu.idleHoldMinutes) to be flagged. */
  idle: { since: number; held: number; flagged: boolean } | null;
}

export interface OvGpu {
  type: 'gpu';
  t: number;
  gpus: OvGpuRow[];
  /** Set once detection found no GPU at all. */
  none?: boolean;
}

export type MountState = 'ok' | 'timeout' | 'error' | 'pending';

export interface OvDisk {
  type: 'disk';
  /** The mount holding the user's home directory. */
  home: { mount: string; used: N; total: N; percent: N; status: MountState } | null;
}

export interface OvAttn {
  type: 'attn';
  items: Attn[];
}

export interface OvWatch {
  type: 'watch';
  /** Number of GPUs an active "notify when free" watch waits for (0 = none). */
  gpuFree: number;
  /** Active watches of any kind. */
  n: number;
}

/** Recent history for the sparklines: delta-encoded timestamps (t[i] = t0 + dt[1] + … + dt[i]). */
export interface OvHist {
  type: 'hist';
  t0: number;
  dt: number[];
  cpu: N[];
  mem: N[];
  rx: N[];
  tx: N[];
  /** Average GPU utilization; timestamps of its own. */
  g: { t0: number; dt: number[]; u: N[] };
  /** Busiest disk's busy %. */
  io: N[];
}

// ---------------------------------------------------------------- page payloads (sent only while that page is shown)

export interface ProcRow {
  pid: number;
  start: number;
  ppid: number;
  cpu: N;
  rss: number;
  /** GPU memory, MiB (null: none). */
  g: N;
  /** Storage read / write, bytes/s (own processes; null when unknown). */
  ior: N;
  iow: N;
  /** Owner name (all-users scope only). */
  u?: string;
  st: string;
  mine: boolean;
  threads: number;
  /** Full and short command line: sent once per pid+start for each webview instance. */
  cmd?: string;
  sc?: string;
}

export interface OvProcs {
  type: 'procs';
  supported: boolean;
  scope: Scope;
  /** The all-users scan is still on its way; rows are the current user's only. */
  pending: boolean;
  /** Processes on the system. */
  total: number;
  /** Processes matching scope + search. */
  matched: number;
  rows: ProcRow[];
  /** Some matching process uses a GPU (show the GPU memory column). */
  gpuCol: boolean;
}

export interface PortRow {
  port: number;
  hosts: string[];
  uid: number;
  user: string;
  pid?: number;
  proc?: string;
  mine: boolean;
  local: boolean;
}

export interface OvPorts {
  type: 'ports';
  supported: boolean;
  loading: boolean;
  /** My ports, plus other users' only while that section is expanded (at most MAX_OTHER_PORTS). */
  rows: PortRow[];
  othersN: number;
}

export interface DiskRow {
  mount: string;
  device: string;
  fstype: string;
  status: MountState;
  network: boolean;
  home: boolean;
  used: N;
  total: N;
  avail: N;
  percent: N;
  /** Inodes used, % (null: the filesystem has no fixed number). */
  inodes: N;
  /** Fills up in this many seconds at its recent rate, growing `rate` bytes/s (null: not filling measurably). */
  eta: N;
  rate: N;
  /** Physical disks it lives on. */
  disks: string[];
}

export interface OvDisks {
  type: 'disks';
  supported: boolean;
  loading: boolean;
  mounts: DiskRow[];
}

export interface UserRow {
  uid: number;
  name: string;
  me: boolean;
  cpu: number;
  rss: number;
  gpus: number[];
  gpuMem: number; // MiB
  procs: number;
}

export interface OvUsers {
  type: 'users';
  supported: boolean;
  /** Waiting for the first all-users scan. */
  pending: boolean;
  memTotal: number;
  rows: UserRow[];
}

export interface TmuxPaneRow {
  id: string;
  index: number;
  command: string;
  path: string;
  active: boolean;
  dead: boolean;
  busy: boolean;
}

export interface TmuxSessionRow {
  id: string;
  name: string;
  attached: number;
  created: number;
  windows: { index: number; name: string; active: boolean; panes: TmuxPaneRow[] }[];
}

export interface OvTmux {
  type: 'tmux';
  installed: boolean;
  loading: boolean;
  sessions: TmuxSessionRow[];
}

export interface DuEntryRow {
  name: string;
  path: string;
  size: number;
  dir: boolean;
}

export interface DuPlace {
  path: string;
  label: string;
  kind: 'recent' | 'home' | 'ws' | 'mount' | 'net';
  /** Known size from a cached scan, or a mount's usage text. */
  note?: string;
}

export interface OvDu {
  type: 'du';
  supported: boolean;
  root?: string;
  crumbs: { label: string; path: string }[];
  /** The root is being scanned (since epoch ms). */
  scanning?: number;
  /** Other folders being scanned (display labels). */
  busy: string[];
  total?: number;
  scannedAt?: number;
  partial: boolean;
  entries: DuEntryRow[];
  /** Entries beyond the shown ones, folded into one line. */
  rest?: { n: number; size: number };
  error?: string;
  cancelled?: boolean;
  places: DuPlace[];
}

export interface WatchRow {
  id: string;
  kind: 'pid' | 'tmux' | 'gpuFree';
  label: string;
  detail: string;
  since: number;
}

export interface OvWatches {
  type: 'watches';
  items: WatchRow[];
  alerts: boolean;
}

export interface DockerRow {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string[];
  created: number;
}

export interface OvDocker {
  type: 'docker';
  enabled: boolean;
  status: 'ok' | 'no-socket' | 'no-permission' | 'error' | 'loading';
  error?: string;
  socket?: string;
  containers: DockerRow[];
}

export interface OvGoto {
  type: 'goto';
  goto: Goto;
}

export interface OvInit {
  type: 'init';
  strings: Record<OvKey, string>;
  /** Per extension host (= window). A saved page from another session is ignored: new windows open on 概览. */
  sess: string;
  page: Page;
  goto?: Goto;
  me: string;
  /** serverMonitor.processes.defaultScope / .limit */
  procScope: Scope;
  procLimit: number;
  /** Show the Docker page (a Docker socket exists). */
  docker: boolean;
  /** False when nvidia-smi is missing or reports no GPU; null while detection is still running. */
  gpuAvailable: boolean | null;
  sys: OvSys;
  cfg: OvCfg;
  watch: OvWatch;
  attn: OvAttn;
}

export type OvPageMsg = OvHist | OvCore | OvGpu | OvDisk | OvProcs | OvPorts | OvDisks | OvUsers | OvTmux | OvDu | OvWatches | OvDocker;
export type OvHostMsg = OvInit | OvCfg | OvAttn | OvWatch | OvGoto | OvPageMsg;

export type ProcAction = 'watch' | 'cwd' | 'copyPid' | 'copyCmd' | 'sigint' | 'sigterm' | 'sigkill';
export type PortAction = 'open' | 'editor' | 'copy' | 'kill';
export type TmuxAction = 'attach' | 'peek' | 'watch' | 'ctrlC' | 'rename' | 'kill';
export type DockerAction = 'start' | 'stop' | 'restart' | 'logs' | 'exec' | 'copyId';

export type OvViewMsg =
  | { type: 'ready'; page?: Page; sess?: string }
  | { type: 'page'; page: Page }
  | { type: 'command'; id: string }
  | { type: 'quickRun'; index: number; command: string }
  | { type: 'quickRemove'; index: number; command: string }
  | { type: 'copyGpus'; indexes: number[] }
  | { type: 'exportGpus'; indexes: number[] }
  | { type: 'procQuery'; query: ProcQuery }
  | { type: 'portOthers'; on: boolean }
  | { type: 'proc'; action: ProcAction; pid: number; start: number }
  | { type: 'port'; action: PortAction; port: number; uid: number; pid?: number }
  | { type: 'disk'; action: 'term' | 'copy'; mount: string }
  | { type: 'tmux'; action: TmuxAction; target: string }
  | { type: 'du'; action: 'open'; path: string }
  | { type: 'du'; action: 'up' | 'rescan' | 'cancel' | 'choose' }
  | { type: 'du'; action: 'term' | 'copy'; path: string }
  | { type: 'watchRemove'; id: string }
  | { type: 'docker'; action: DockerAction; id: string };
