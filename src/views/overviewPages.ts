import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import type {
  DuPlace, OvDisks, OvDocker, OvDu, OvPorts, OvProcs, OvTmux, OvUsers, OvViewMsg, OvWatches, ProcQuery, ProcRow, ProcSort, TmuxSessionRow, WatchRow,
} from '../../webview/overview-protocol';
import { AlertManager, Watch } from '../alerts';
import { isLinux } from '../collectors/core';
import { MountUsage } from '../collectors/disks';
import { PortInfo } from '../collectors/ports';
import { ProcInfo } from '../collectors/processes';
import { SHELLS } from '../collectors/tmux';
import { aggregateUsers } from '../collectors/users';
import { Monitor } from '../monitor';
import * as fmt from '../util/format';
import { shortCmd, tildify } from './common';
import { chooseFolder, DuScanner, expandHome, isDir, recentFolders, rememberFolder } from './duShared';
import { LOCAL_ONLY } from './portsView';
import type { ProcTarget } from './processView';

// Payloads and actions of the sidebar panel's pages (everything but 概览 and GPU, which live in overview.ts).
// Builders read the sources' latest values only; they never poll. Actions validate what the webview sent against
// current data and then run the same commands as the tree views' context menus, with a `{ data }` node payload.

const home = os.homedir();
const DU_ROWS = 200;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const rnd1 = (v: number) => (isFinite(v) ? Math.round(v * 10) / 10 : null);

export type Run = (id: string, ...args: unknown[]) => void;
type Msg<T extends OvViewMsg['type']> = Extract<OvViewMsg, { type: T }>;

// ------------------------------------------------------------------ processes

const SORTS: readonly ProcSort[] = ['cpu', 'mem', 'gpu', 'io', 'time'];
export const MAX_PROC_LIMIT = 2000;
const MAX_CMD = 2000;

export function validQuery(v: unknown): ProcQuery | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if ((o.scope !== 'mine' && o.scope !== 'all') || typeof o.q !== 'string' || o.q.length > 300 || !SORTS.includes(o.sort as ProcSort)) return undefined;
  if (!isInt(o.limit) || o.limit < 1 || o.limit > MAX_PROC_LIMIT) return undefined;
  return { scope: o.scope, q: o.q, sort: o.sort as ProcSort, limit: o.limit };
}

/** GPU memory (MiB) per pid, when the GPU app list is recent. */
function gpuMemByPid(m: Monitor): Map<number, number> {
  const out = new Map<number, number>();
  if (Date.now() - m.gpuApps.updatedAt > 30_000) return out;
  for (const a of m.gpuApps.latest ?? []) if (isFinite(a.memMiB)) out.set(a.pid, (out.get(a.pid) ?? 0) + a.memMiB);
  return out;
}

/** Same rules as the tree view's filter: every term matches; `user:NAME` matches the owner, digits the PID or text. */
function matcher(m: Monitor, q: string): (p: ProcInfo) => boolean {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return () => true;
  return (p) =>
    terms.every((t) => {
      if (t.startsWith('user:')) return m.names.name(p.uid).toLowerCase() === t.slice(5);
      return String(p.pid) === t || p.comm.toLowerCase().includes(t) || m.procC.cmdline(p).toLowerCase().includes(t) || m.names.name(p.uid).toLowerCase() === t;
    });
}

/**
 * The visible rows only. `sent` holds the pid:start keys whose command line this webview instance already has; a row
 * carries its command line the first time only.
 */
export function procsMsg(m: Monitor, q: ProcQuery, sent: Set<string>): OvProcs {
  const snap = m.procs.latest;
  const base: OvProcs = { type: 'procs', supported: isLinux, scope: q.scope, pending: !snap, total: snap?.total ?? 0, matched: 0, rows: [], gpuCol: false };
  if (!snap) return base;
  if (!snap.supported) return { ...base, supported: false };
  const myUid = m.names.myUid;
  // A scan in "mine" scope cannot serve "all" until the next scan arrives; an "all" scan is a superset of "mine".
  const pending = q.scope === 'all' && snap.scope !== 'all';
  let procs = snap.procs;
  if (q.scope === 'mine' || snap.scope === 'mine') procs = procs.filter((p) => p.uid === myUid);
  const match = matcher(m, q.q);
  procs = procs.filter((p) => p.pid !== process.pid && match(p));
  const gmem = gpuMemByPid(m);
  const key = (p: ProcInfo): number => (q.sort === 'cpu' ? p.cpu : q.sort === 'mem' ? p.rss : q.sort === 'gpu' ? (gmem.get(p.pid) ?? 0) : q.sort === 'io' ? (p.ioR ?? 0) + (p.ioW ?? 0) : p.start);
  procs.sort((a, b) => key(b) - key(a) || b.rss - a.rss);
  if (sent.size > 5000) sent.clear();
  const rows = procs.slice(0, q.limit).map((p): ProcRow => {
    const k = `${p.pid}:${p.start}`;
    const g = gmem.get(p.pid);
    const io = (v: number | undefined) => (v === undefined ? null : Math.round(v));
    const row: ProcRow = { pid: p.pid, start: p.start, ppid: p.ppid, cpu: rnd1(p.cpu), rss: p.rss, g: g === undefined ? null : Math.round(g), ior: io(p.ioR), iow: io(p.ioW), st: p.state, mine: p.uid === myUid, threads: p.threads };
    if (q.scope === 'all') row.u = m.names.name(p.uid);
    if (!sent.has(k)) {
      const cmd = m.procC.cmdline(p);
      // shown in the action bar only; "copy command" reads the full one on the host
      row.cmd = cmd.length > MAX_CMD ? cmd.slice(0, MAX_CMD) + '…' : cmd;
      row.sc = shortCmd(cmd) || p.comm;
      sent.add(k);
    }
    return row;
  });
  return { ...base, pending, matched: procs.length, rows, gpuCol: procs.some((p) => gmem.has(p.pid)) };
}

export function procAction(m: Monitor, o: Msg<'proc'>, run: Run): void {
  if (!isInt(o.pid) || o.pid <= 0 || typeof o.start !== 'number') return;
  const p = m.procs.latest?.procs.find((x) => x.pid === o.pid && Math.abs(x.start - o.start) < 1500);
  if (!p) return void vscode.window.showWarningMessage(l10n.t('Process {0} no longer exists.', o.pid));
  const mine = p.uid === m.names.myUid;
  const data: ProcTarget = { pid: p.pid, label: shortCmd(m.procC.cmdline(p)) || p.comm, mine, start: p.start };
  const own: Partial<Record<typeof o.action, string>> = { cwd: 'serverMonitor.proc.terminalAtCwd', sigint: 'serverMonitor.proc.interrupt', sigterm: 'serverMonitor.proc.kill', sigkill: 'serverMonitor.proc.kill9' };
  const any: Partial<Record<typeof o.action, string>> = { watch: 'serverMonitor.proc.watch', copyPid: 'serverMonitor.proc.copyPid', copyCmd: 'serverMonitor.proc.copyCmd' };
  const id = any[o.action] ?? (mine ? own[o.action] : undefined);
  if (id) run(id, { data });
}

// ------------------------------------------------------------------ ports

/** Other users' ports sent at most (a shared server can have hundreds). */
export const MAX_OTHER_PORTS = 300;

export function portsMsg(m: Monitor, others: boolean): OvPorts {
  const d = m.ports.latest;
  const myUid = m.names.myUid;
  const all = d?.ports ?? [];
  const othersN = all.filter((p) => p.uid !== myUid).length;
  const row = (p: PortInfo) => ({ port: p.port, hosts: p.hosts, uid: p.uid, user: m.names.name(p.uid), pid: p.pid, proc: p.procName, mine: p.uid === myUid, local: p.hosts.every(LOCAL_ONLY) });
  const byPort = (a: PortInfo, b: PortInfo) => a.port - b.port;
  const rows = all.filter((p) => p.uid === myUid).sort(byPort).map(row);
  if (others) rows.push(...all.filter((p) => p.uid !== myUid).sort(byPort).slice(0, MAX_OTHER_PORTS).map(row));
  return { type: 'ports', supported: d ? d.supported : isLinux, loading: !d, rows, othersN };
}

export function portAction(m: Monitor, o: Msg<'port'>, run: Run): void {
  if (!isInt(o.port) || !isInt(o.uid)) return;
  const p = m.ports.latest?.ports.find((x) => x.port === o.port && x.uid === o.uid && (x.pid ?? 0) === (o.pid ?? 0));
  if (!p) return;
  const ids = { open: 'serverMonitor.port.open', editor: 'serverMonitor.port.openInEditor', copy: 'serverMonitor.port.copyUrl', kill: 'serverMonitor.port.kill' } as const;
  if (o.action === 'kill' && (p.uid !== m.names.myUid || !p.pid)) return;
  const id = ids[o.action];
  if (id) run(id, { data: p });
}

// ------------------------------------------------------------------ disks

/** Home disk first, network filesystems last, otherwise by path. */
export function sortedMounts(mounts: MountUsage[]): MountUsage[] {
  const rank = (d: MountUsage) => (d.home ? 0 : d.network ? 2 : 1);
  return [...mounts].sort((a, b) => rank(a) - rank(b) || a.mount.localeCompare(b.mount));
}

export function disksMsg(m: Monitor): OvDisks {
  const d = m.disks.latest;
  const n = (v: number | undefined) => (v === undefined || !isFinite(v) ? null : v);
  const mounts = sortedMounts(d?.mounts ?? []).map((x) => {
    const eta = x.status === 'ok' ? m.fillEta(x) : undefined;
    return {
      mount: x.mount, device: x.device, fstype: x.fstype, status: x.status, network: x.network, home: x.home,
      used: n(x.used), total: n(x.total), avail: n(x.avail), percent: x.percent === undefined ? null : rnd1(x.percent),
      inodes: x.inodes ? rnd1(x.inodes.percent) : null,
      eta: eta ? Math.round(eta.seconds) : null,
      rate: eta ? Math.round(eta.rate) : null,
      disks: m.disksOf(x),
    };
  });
  return { type: 'disks', supported: d ? d.supported : isLinux, loading: !d, mounts };
}

export function diskAction(m: Monitor, o: Msg<'disk'>, run: Run): void {
  const d = m.disks.latest?.mounts.find((x) => x.mount === o.mount);
  if (!d) return;
  if (o.action === 'term') run('serverMonitor.disk.terminal', { data: d });
  else if (o.action === 'copy') run('serverMonitor.disk.copyPath', { data: d });
}

// ------------------------------------------------------------------ users

export function usersMsg(m: Monitor): OvUsers {
  const snap = m.procs.latest;
  const memTotal = m.core.latest?.mem.total || os.totalmem();
  if (!snap?.supported || snap.scope !== 'all') return { type: 'users', supported: snap ? snap.supported : isLinux, pending: true, memTotal, rows: [] };
  const myUid = m.names.myUid;
  const rows = aggregateUsers(snap.procs, m.gpuApps.latest ?? [], m.gpu.latest?.gpus ?? [])
    .filter((u) => u.cpu >= 0.5 || u.gpus.length || u.uid === myUid || u.rss > 512 * 1024 * 1024)
    .sort((a, b) => b.gpus.length - a.gpus.length || b.cpu - a.cpu)
    .map((u) => ({ uid: u.uid, name: m.names.name(u.uid), me: u.uid === myUid, cpu: Math.round(u.cpu), rss: u.rss, gpus: u.gpus, gpuMem: Math.round(u.gpuMem), procs: u.procs }));
  return { type: 'users', supported: true, pending: false, memTotal, rows };
}

// ------------------------------------------------------------------ tmux

const busyPane = (p: { dead: boolean; command: string }) => !p.dead && !SHELLS.has(p.command);

export function tmuxMsg(m: Monitor): OvTmux {
  const st = m.tmux.latest;
  const sessions: TmuxSessionRow[] = (st?.sessions ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    attached: s.attached,
    created: s.created,
    windows: s.windows.map((w) => ({
      index: w.index,
      name: w.name,
      active: w.active,
      panes: w.panes.map((p) => ({ id: p.id, index: p.index, command: p.command, path: tildify(p.path, home), active: p.active, dead: p.dead, busy: busyPane(p) })),
    })),
  }));
  return { type: 'tmux', installed: !!m.tmuxC.binary, loading: !!m.tmuxC.binary && !st, sessions };
}

/** Resolve a session id ($1), window ("$1:2") or pane id (%3) to the tree view's TmuxTarget payload. */
function tmuxTarget(m: Monitor, target: string) {
  for (const s of m.tmux.latest?.sessions ?? []) {
    if (s.id === target) return { target: s.id, session: s, label: s.name };
    for (const w of s.windows) {
      if (`${s.id}:${w.index}` === target) return { target, session: s, label: `${s.name}:${w.index}` };
      for (const p of w.panes) if (p.id === target) return { target: p.id, session: s, label: w.panes.length === 1 ? `${s.name}:${w.index}` : `${s.name}:${w.index}.${p.index}`, pane: p };
    }
  }
  return undefined;
}

export function tmuxAction(m: Monitor, o: Msg<'tmux'>, run: Run): void {
  if (typeof o.target !== 'string' || !m.tmuxC.binary) return;
  const t = tmuxTarget(m, o.target);
  if (!t) return;
  const ids = { attach: 'serverMonitor.tmux.attach', peek: 'serverMonitor.tmux.peek', watch: 'serverMonitor.tmux.watch', ctrlC: 'serverMonitor.tmux.ctrlC', rename: 'serverMonitor.tmux.rename', kill: 'serverMonitor.tmux.kill' } as const;
  if (o.action === 'rename' && t.target !== t.session.id) return;
  const id = ids[o.action];
  if (id) run(id, { data: t });
}

// ------------------------------------------------------------------ watches

function watchDetail(w: Watch): string {
  switch (w.kind) {
    case 'pid':
      return l10n.t('process exit · pid {0}', w.pid);
    case 'tmux':
      return l10n.t('tmux job done');
    case 'gpuFree':
      return l10n.t('GPUs free');
  }
}

export function watchesMsg(m: Monitor, alerts: AlertManager): OvWatches {
  const items: WatchRow[] = alerts.watches.map((w) => ({ id: w.id, kind: w.kind, label: w.label, detail: watchDetail(w), since: w.since }));
  return { type: 'watches', items, alerts: m.cfg.alertsEnabled };
}

export function watchRemove(alerts: AlertManager, id: unknown, run: Run): void {
  if (typeof id === 'string' && alerts.watches.some((w) => w.id === id)) run('serverMonitor.watch.remove', { data: id });
}

// ------------------------------------------------------------------ docker

export function dockerMsg(m: Monitor): OvDocker {
  const d = m.docker.latest;
  const containers = (d?.containers ?? []).map((c) => ({ id: c.id, name: c.name, image: c.image, state: c.state, status: c.status, ports: c.ports, created: c.created }));
  return { type: 'docker', enabled: m.cfg.dockerEnabled, status: d ? d.status : 'loading', error: d?.error, socket: m.dockerC.socketPath, containers };
}

export function dockerAction(m: Monitor, o: Msg<'docker'>, run: Run): void {
  const c = m.docker.latest?.containers.find((x) => x.id === o.id);
  if (!c) return;
  const ids = { start: 'serverMonitor.docker.start', stop: 'serverMonitor.docker.stop', restart: 'serverMonitor.docker.restart', logs: 'serverMonitor.docker.logs', exec: 'serverMonitor.docker.exec', copyId: 'serverMonitor.docker.copyId' } as const;
  const id = ids[o.action];
  if (id) run(id, { data: c });
}

// ------------------------------------------------------------------ folder sizes

/**
 * The panel's folder browser: one folder (the root) at a time, its `du` level from the shared scanner. The root lives
 * here (host memory, per window), so the page shows the same folder again after the view was hidden.
 */
export class DuPanel {
  root?: string;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly m: Monitor,
    readonly scanner: DuScanner,
    private readonly changed: () => void,
  ) {}

  /** Open a folder that came from the host side (command argument, folder chooser): only checked to be a folder. */
  async openTrusted(dir: string): Promise<boolean> {
    dir = expandHome(dir).replace(/(.)\/+$/, '$1');
    if (!path.isAbsolute(dir)) return false;
    const mt = this.mountOf(dir);
    if (mt?.status === 'timeout') {
      void vscode.window.showWarningMessage(l10n.t('Disk {0} is not responding', mt.mount));
      return false;
    }
    if (!(await isDir(dir))) {
      void vscode.window.showWarningMessage(l10n.t('Not a folder: {0}', dir));
      return false;
    }
    this.show(dir);
    return true;
  }

  private show(dir: string): void {
    this.root = dir;
    rememberFolder(this.ctx, dir);
    if (!this.scanner.cache.has(dir)) this.scan(dir);
    this.changed();
  }

  private scan(dir: string): void {
    this.scanner.scan(dir).catch(() => undefined);
  }

  private mountOf(dir: string): MountUsage | undefined {
    let best: MountUsage | undefined;
    for (const d of this.m.disks.latest?.mounts ?? []) if ((dir === d.mount || dir.startsWith(d.mount === '/' ? '/' : d.mount + '/')) && d.mount.length > (best?.mount.length ?? -1)) best = d;
    return best;
  }

  /** Paths the webview may ask for: entries of cached scans, ancestors of the root, recent folders and places. */
  private allowed(p: string): 'dir' | 'file' | 'check' | undefined {
    if (!path.isAbsolute(p) || p.includes('\0')) return undefined;
    const parent = this.scanner.cache.get(path.dirname(p));
    const e = parent?.entries.find((x) => x.path === p);
    if (e) return e.dir ? 'dir' : 'file';
    if (this.root && (this.root === p || this.root.startsWith(p === '/' ? '/' : p + '/'))) return 'dir';
    if (this.places().some((x) => x.path === p)) return 'check';
    return undefined;
  }

  async action(o: Msg<'du'>, run: Run): Promise<void> {
    switch (o.action) {
      case 'open': {
        const kind = typeof o.path === 'string' ? this.allowed(o.path) : undefined;
        if (kind === 'dir') this.show(o.path);
        else if (kind === 'check') await this.openTrusted(o.path);
        return;
      }
      case 'up':
        if (this.root && this.root !== '/') this.show(path.dirname(this.root));
        return;
      case 'rescan':
        if (!this.root) return;
        this.scanner.invalidate(this.root);
        this.scan(this.root);
        return;
      case 'cancel':
        this.scanner.cancel(this.root);
        return;
      case 'choose': {
        const dir = await chooseFolder(this.ctx, this.m, this.scanner, this.root);
        if (dir) await this.openTrusted(dir);
        return;
      }
      case 'term':
      case 'copy': {
        const kind = typeof o.path === 'string' ? this.allowed(o.path) : undefined;
        if (!kind) return;
        if (o.action === 'copy') run('serverMonitor.du.copyPath', { data: o.path });
        else run('serverMonitor.du.terminal', { data: o.path, contextValue: kind === 'file' ? 'duFile' : 'duDir' });
        return;
      }
    }
  }

  private places(): DuPlace[] {
    const out: DuPlace[] = [];
    const seen = new Set<string>();
    const add = (p: DuPlace) => {
      if (!p.path || seen.has(p.path)) return;
      seen.add(p.path);
      out.push(p);
    };
    const size = (p: string) => {
      const r = this.scanner.cache.get(p);
      return r ? fmt.bytes(r.total) : undefined;
    };
    for (const d of recentFolders(this.ctx)) add({ path: d, label: tildify(d, home), kind: 'recent', note: size(d) });
    add({ path: home, label: '~', kind: 'home', note: size(home) });
    for (const f of vscode.workspace.workspaceFolders ?? []) if (f.uri.scheme === 'file') add({ path: f.uri.fsPath, label: f.name, kind: 'ws', note: tildify(f.uri.fsPath, home) });
    for (const mt of this.m.disks.latest?.mounts ?? []) {
      if (mt.status === 'timeout') continue;
      add({ path: mt.mount, label: mt.mount, kind: mt.network ? 'net' : 'mount', note: mt.percent !== undefined ? `${fmt.pct(mt.percent)} · ${fmt.bytes(mt.used ?? 0)}/${fmt.bytes(mt.total ?? 0)}` : mt.fstype });
    }
    return out;
  }

  msg(): OvDu {
    const root = this.root;
    const sc = this.scanner;
    const busy = [...sc.scans.keys()].filter((k) => k !== root).map((k) => tildify(k, home));
    const base: OvDu = { type: 'du', supported: isLinux, crumbs: [], busy, partial: false, entries: [], places: this.places() };
    if (!root) return base;
    const crumbs: { label: string; path: string }[] = [];
    const inHome = root === home || root.startsWith(home + '/');
    let acc = inHome ? home : '';
    crumbs.push(inHome ? { label: '~', path: home } : { label: '/', path: '/' });
    for (const part of (inHome ? root.slice(home.length) : root).split('/').filter(Boolean)) {
      acc = acc === '/' ? '/' + part : acc + '/' + part;
      crumbs.push({ label: part, path: acc });
    }
    const r = sc.cache.get(root);
    const err = sc.errors.get(root);
    const out: OvDu = { ...base, root, crumbs, scanning: sc.scans.get(root)?.started, partial: !!r?.partial, total: r?.total, scannedAt: r?.scannedAt };
    if (err === 'cancelled') out.cancelled = true;
    else if (err) out.error = err;
    if (r) {
      out.entries = r.entries.slice(0, DU_ROWS).map((e) => ({ name: path.basename(e.path), path: e.path, size: e.size, dir: e.dir }));
      if (r.entries.length > DU_ROWS) out.rest = { n: r.entries.length - DU_ROWS, size: r.entries.slice(DU_ROWS).reduce((a, e) => a + e.size, 0) };
    }
    return out;
  }
}
