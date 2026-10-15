// Pure parsers for /proc, /sys and tool output. No I/O here so everything is unit-testable with fixtures.

export interface CpuTimes {
  idle: number;
  total: number;
}

/** /proc/stat → aggregate (`all`) and per-core jiffies, plus boot time. Offline cores leave holes. */
export function parseProcStat(text: string): { all: CpuTimes; cores: CpuTimes[]; btime: number } {
  let all: CpuTimes = { idle: 0, total: 0 };
  const cores: CpuTimes[] = [];
  let btime = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('cpu')) {
      const parts = line.trim().split(/\s+/);
      // user nice system idle iowait irq softirq steal (guest/guest_nice are already included in user/nice)
      let total = 0;
      for (let i = 1; i <= 8 && i < parts.length; i++) total += Number(parts[i]) || 0;
      const idle = (Number(parts[4]) || 0) + (Number(parts[5]) || 0);
      const name = parts[0];
      if (name === 'cpu') all = { idle, total };
      else cores[Number(name.slice(3))] = { idle, total };
    } else if (line.startsWith('btime ')) {
      btime = Number(line.slice(6)) || 0;
    }
  }
  return { all, cores, btime };
}

export function cpuPercent(prev: CpuTimes | undefined, cur: CpuTimes | undefined): number {
  if (!prev || !cur) return 0;
  const dt = cur.total - prev.total;
  if (dt <= 0) return 0;
  const busy = 1 - (cur.idle - prev.idle) / dt;
  return Math.max(0, Math.min(100, busy * 100));
}

/** /proc/meminfo → values in bytes keyed by field name. */
export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = /^([\w()]+):\s+(\d+)(\s+kB)?/.exec(line);
    if (m) out[m[1]] = Number(m[2]) * (m[3] ? 1024 : 1);
  }
  return out;
}

export interface MemSample {
  total: number;
  used: number;
  available: number;
  free: number;
  cache: number;
  shared: number;
  swapTotal: number;
  swapUsed: number;
  percent: number;
}

export function memFromMeminfo(m: Record<string, number>): MemSample {
  const total = m.MemTotal || 0;
  const free = m.MemFree || 0;
  // MemAvailable exists since Linux 3.14; fall back to the classic estimate.
  const cache = (m.Buffers || 0) + (m.Cached || 0) + (m.SReclaimable || 0);
  const available = m.MemAvailable ?? free + cache;
  const used = Math.max(0, total - available);
  const swapTotal = m.SwapTotal || 0;
  const swapUsed = Math.max(0, swapTotal - (m.SwapFree || 0));
  return { total, used, available, free, cache, shared: m.Shmem || 0, swapTotal, swapUsed, percent: total ? (used / total) * 100 : 0 };
}

export interface NetCounter {
  iface: string;
  rx: number;
  tx: number;
}

/** /proc/net/dev → cumulative byte counters per interface. */
export function parseNetDev(text: string): NetCounter[] {
  const out: NetCounter[] = [];
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const iface = line.slice(0, colon).trim();
    const f = line.slice(colon + 1).trim().split(/\s+/);
    if (f.length < 9) continue;
    out.push({ iface, rx: Number(f[0]) || 0, tx: Number(f[8]) || 0 });
  }
  return out;
}

export interface DiskCounter {
  dev: string;
  readBytes: number;
  writeBytes: number;
}

/** /proc/diskstats → cumulative bytes (sectors are always 512 B here), restricted to `devices` when given. */
export function parseDiskstats(text: string, devices?: Set<string>): DiskCounter[] {
  const out: DiskCounter[] = [];
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const dev = f[2];
    if (devices && !devices.has(dev)) continue;
    out.push({ dev, readBytes: (Number(f[5]) || 0) * 512, writeBytes: (Number(f[9]) || 0) * 512 });
  }
  return out;
}

/** Whole physical disks from a /sys/block listing; skips virtual/stacked devices to avoid double counting. */
export function physicalBlockDevices(names: string[]): Set<string> {
  return new Set(names.filter((n) => !/^(loop|ram|zram|dm-|md|sr|fd|nbd)/.test(n)));
}

export interface PidStat {
  pid: number;
  comm: string;
  state: string;
  ppid: number;
  ticks: number; // utime + stime
  threads: number;
  startTicks: number; // since boot
  rssPages: number;
}

/** /proc/<pid>/stat. `comm` may contain spaces and parentheses, so split around the last ')'. */
export function parsePidStat(text: string): PidStat | undefined {
  const l = text.indexOf('(');
  const r = text.lastIndexOf(')');
  if (l < 0 || r < l) return undefined;
  // Fields after ") ": 0 state, 1 ppid, 11 utime, 12 stime, 17 num_threads, 19 starttime, 21 rss. Read in place: this
  // runs for every process on every full scan, and splitting all 52 fields was most of the parse cost.
  const n = text.length;
  let pos = r + 2;
  let ppid = 0;
  let ticks = 0;
  let threads = 0;
  let startTicks = 0;
  let rssPages = 0;
  for (let field = 1; field <= 21; field++) {
    // advance past the current field to the start of `field`
    while (pos < n && text.charCodeAt(pos) !== 32) pos++;
    pos++;
    if (pos >= n) return undefined;
    if (field !== 1 && field !== 11 && field !== 12 && field !== 17 && field !== 19 && field !== 21) continue;
    let v = 0;
    let digits = 0;
    for (let c = text.charCodeAt(pos); c >= 48 && c <= 57; c = text.charCodeAt(++pos)) {
      v = v * 10 + (c - 48);
      digits++;
    }
    if (!digits) return undefined;
    pos--; // stay inside the field so the skip loop above finds its end
    if (field === 1) ppid = v;
    else if (field === 11 || field === 12) ticks += v;
    else if (field === 17) threads = v;
    else if (field === 19) startTicks = v;
    else rssPages = v;
  }
  return { pid: Number(text.slice(0, l)), comm: text.slice(l + 1, r), state: text.charAt(r + 2), ppid, ticks, threads, startTicks, rssPages };
}

/** /proc/<pid>/cmdline: NUL-separated argv. Empty for kernel threads. */
export function parseCmdline(buf: string): string {
  return buf.replace(/\0+$/, '').split('\0').join(' ');
}

export interface ListenSocket {
  host: string;
  port: number;
  uid: number;
  inode: number;
  family: 4 | 6;
}

function splitHostPort(addr: string): { host: string; port: number } | undefined {
  const i = addr.lastIndexOf(':');
  if (i < 0) return undefined;
  let host = addr.slice(0, i);
  const port = Number(addr.slice(i + 1));
  if (!isFinite(port)) return undefined;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const pct = host.indexOf('%'); // 127.0.0.53%lo
  if (pct >= 0) host = host.slice(0, pct);
  return { host, port };
}

/** `ss -tlnHe` output. */
export function parseSsListen(text: string): ListenSocket[] {
  const out: ListenSocket[] = [];
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0] !== 'LISTEN') continue;
    const hp = splitHostPort(f[3]);
    if (!hp) continue;
    const uid = /\buid:(\d+)/.exec(line);
    const ino = /\bino:(\d+)/.exec(line);
    const host = hp.host === '*' ? '0.0.0.0' : hp.host;
    out.push({ host, port: hp.port, uid: uid ? Number(uid[1]) : 0, inode: ino ? Number(ino[1]) : 0, family: host.includes(':') ? 6 : 4 });
  }
  return out;
}

function hexToIpv4(hex: string): string {
  // Little-endian 32-bit word.
  const n = parseInt(hex, 16);
  return [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
}

function hexToIpv6(hex: string): string {
  const words: string[] = [];
  for (let w = 0; w < 4; w++) {
    const chunk = hex.slice(w * 8, w * 8 + 8);
    // Each 32-bit word is little-endian.
    const b = chunk.match(/../g)!.reverse().join('');
    words.push(b.slice(0, 4), b.slice(4, 8));
  }
  const full = words.map((x) => parseInt(x, 16).toString(16));
  const s = full.join(':');
  if (s === '0:0:0:0:0:0:0:0') return '::';
  if (s === '0:0:0:0:0:0:0:1') return '::1';
  const v4mapped = /^0:0:0:0:0:ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(s);
  if (v4mapped) {
    const hi = parseInt(v4mapped[1], 16);
    const lo = parseInt(v4mapped[2], 16);
    return `::ffff:${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return s.replace(/(^|:)0(:0)+(:|$)/, '::');
}

/** /proc/net/tcp or tcp6 → listening sockets (state 0A). Fallback when `ss` is missing. */
export function parseProcNetTcp(text: string, family: 4 | 6): ListenSocket[] {
  const out: ListenSocket[] = [];
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].trim().split(/\s+/);
    if (f.length < 10 || f[3] !== '0A') continue;
    const [hostHex, portHex] = f[1].split(':');
    out.push({
      host: family === 4 ? hexToIpv4(hostHex) : hexToIpv6(hostHex),
      port: parseInt(portHex, 16),
      uid: Number(f[7]),
      inode: Number(f[9]),
      family,
    });
  }
  return out;
}

export interface MountEntry {
  device: string;
  mount: string;
  fstype: string;
}

function unescapeMount(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

export function parseMounts(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split('\n')) {
    const f = line.split(' ');
    if (f.length < 3) continue;
    out.push({ device: unescapeMount(f[0]), mount: unescapeMount(f[1]), fstype: f[2] });
  }
  return out;
}

export interface StatFs {
  total: number;
  used: number;
  avail: number;
  percent: number;
}

/** Turn statfs block counts into df-style numbers (percent is used / (used + avail), like df). */
export function statfsToUsage(bsize: number, blocks: number, bfree: number, bavail: number): StatFs {
  const total = blocks * bsize;
  const used = (blocks - bfree) * bsize;
  const avail = bavail * bsize;
  const denom = used + avail;
  return { total, used, avail, percent: denom > 0 ? (used / denom) * 100 : 0 };
}

/** `stat -f -c '%S %b %f %a'` output. */
export function parseStatF(out: string): StatFs | undefined {
  const f = out.trim().split(/\s+/).map(Number);
  if (f.length < 4 || f.some((x) => !isFinite(x))) return undefined;
  return statfsToUsage(f[0], f[1], f[2], f[3]);
}

export const GPU_FIELDS = [
  'index',
  'uuid',
  'name',
  'utilization.gpu',
  'utilization.memory',
  'memory.used',
  'memory.total',
  'temperature.gpu',
  'power.draw',
  'power.limit',
  'fan.speed',
] as const;

export interface GpuInfo {
  index: number;
  uuid: string;
  name: string;
  util: number; // %
  memUtil: number; // % (memory controller)
  memUsed: number; // MiB
  memTotal: number; // MiB
  temp: number; // °C
  power: number; // W
  powerLimit: number; // W
  fan: number; // %
}

function num(s: string | undefined): number {
  if (s === undefined) return NaN;
  const v = Number(s.trim());
  return isFinite(v) ? v : NaN; // "[N/A]", "[Not Supported]"
}

/** One line of `nvidia-smi --query-gpu=<GPU_FIELDS> --format=csv,noheader,nounits`. */
export function parseGpuLine(line: string): GpuInfo | undefined {
  const f = line.split(', ');
  if (f.length < GPU_FIELDS.length) return undefined;
  const index = Number(f[0]);
  if (!isFinite(index)) return undefined;
  return {
    index,
    uuid: f[1].trim(),
    name: f[2].trim().replace(/^NVIDIA /, ''),
    util: num(f[3]),
    memUtil: num(f[4]),
    memUsed: num(f[5]),
    memTotal: num(f[6]),
    temp: num(f[7]),
    power: num(f[8]),
    powerLimit: num(f[9]),
    fan: num(f[10]),
  };
}

export interface GpuApp {
  pid: number;
  uuid: string;
  memMiB: number;
  name: string;
}

/** `nvidia-smi --query-compute-apps=pid,gpu_uuid,used_memory,process_name --format=csv,noheader,nounits` */
export function parseGpuApps(text: string): GpuApp[] {
  const out: GpuApp[] = [];
  for (const line of text.split('\n')) {
    const f = line.split(', ');
    if (f.length < 4) continue;
    const pid = Number(f[0]);
    if (!isFinite(pid) || pid <= 0) continue;
    out.push({ pid, uuid: f[1].trim(), memMiB: num(f[2]), name: f.slice(3).join(', ').trim() });
  }
  return out;
}

export const TMUX_FIELDS = [
  'session_name',
  'session_id',
  'session_attached',
  'session_created',
  'window_index',
  'window_name',
  'window_active',
  'pane_index',
  'pane_id',
  'pane_pid',
  'pane_current_command',
  'pane_current_path',
  'pane_active',
  'pane_dead',
] as const;

export const TMUX_FORMAT = TMUX_FIELDS.map((f) => `#{${f}}`).join('\t');

export interface TmuxPane {
  id: string; // %3
  index: number;
  pid: number;
  command: string;
  path: string;
  active: boolean;
  dead: boolean;
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  panes: TmuxPane[];
}

export interface TmuxSession {
  name: string;
  id: string;
  attached: number;
  created: number; // epoch ms
  windows: TmuxWindow[];
}

/** `tmux list-panes -a -F TMUX_FORMAT` → sessions/windows/panes in tmux order. */
export function parseTmuxPanes(text: string): TmuxSession[] {
  const sessions = new Map<string, TmuxSession>();
  for (const line of text.split('\n')) {
    const f = line.split('\t');
    if (f.length < TMUX_FIELDS.length) continue;
    const [sName, sId, sAttached, sCreated, wIndex, wName, wActive, pIndex, pId, pPid, pCmd, pPath, pActive, pDead] = f;
    let s = sessions.get(sId);
    if (!s) {
      s = { name: sName, id: sId, attached: Number(sAttached) || 0, created: Number(sCreated) * 1000, windows: [] };
      sessions.set(sId, s);
    }
    const wi = Number(wIndex);
    let w = s.windows.find((x) => x.index === wi);
    if (!w) {
      w = { index: wi, name: wName, active: wActive === '1', panes: [] };
      s.windows.push(w);
    }
    w.panes.push({ id: pId, index: Number(pIndex), pid: Number(pPid), command: pCmd, path: pPath, active: pActive === '1', dead: pDead === '1' });
  }
  return [...sessions.values()];
}

export function parsePasswd(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split('\n')) {
    const f = line.split(':');
    if (f.length >= 3 && f[0] && !line.startsWith('#')) out.set(Number(f[2]), f[0]);
  }
  return out;
}

/** `du -x -a -d1 -B1 <dir>` → entries (excluding the dir itself) and the dir total. */
export function parseDu(text: string, dir: string): { total: number; entries: { path: string; size: number }[] } {
  const entries: { path: string; size: number }[] = [];
  let total = 0;
  const norm = dir.replace(/\/+$/, '') || '/';
  for (const line of text.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const size = Number(line.slice(0, tab));
    const p = line.slice(tab + 1);
    if ((p.replace(/\/+$/, '') || '/') === norm) total = size;
    else entries.push({ path: p, size });
  }
  entries.sort((a, b) => b.size - a.size);
  return { total, entries };
}

/** Logged-in user names from a glibc x86_64/aarch64 utmp file (384-byte records). */
export function parseUtmpUsers(buf: Uint8Array): string[] {
  const REC = 384;
  const users = new Set<string>();
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let off = 0; off + REC <= buf.length; off += REC) {
    if (dv.getInt16(off, true) !== 7) continue; // USER_PROCESS
    let end = off + 44;
    while (end < off + 76 && buf[end] !== 0) end++;
    const name = new TextDecoder().decode(buf.subarray(off + 44, end));
    if (name) users.add(name);
  }
  return [...users].sort();
}

export function parseOsRelease(text: string): string | undefined {
  const m = /^PRETTY_NAME="?([^"\n]*)"?/m.exec(text);
  return m?.[1];
}

/** cgroup v2 `memory.max` / v1 `memory.limit_in_bytes`; huge v1 sentinels count as unlimited. */
export function parseCgroupLimit(text: string): number | undefined {
  const s = text.trim();
  if (!s || s === 'max') return undefined;
  const n = Number(s);
  if (!isFinite(n) || n <= 0 || n >= 2 ** 60) return undefined;
  return n;
}

/** cgroup v2 `cpu.max` ("quota period" or "max period") → number of CPUs, if limited. */
export function parseCpuMax(text: string): number | undefined {
  const [quota, period] = text.trim().split(/\s+/);
  if (!quota || quota === 'max') return undefined;
  const q = Number(quota);
  const p = Number(period) || 100000;
  return q > 0 ? q / p : undefined;
}
