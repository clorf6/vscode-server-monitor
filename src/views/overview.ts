import { randomBytes } from 'crypto';
import * as os from 'os';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import type { Attn, Goto, Locate, N, OvAttn, OvCfg, OvCore, OvDisk, OvGpu, OvHist, OvHostMsg, OvInit, OvPageMsg, OvSys, OvViewMsg, OvWatch, Page, ProcQuery } from '../../webview/overview-protocol';
import { AlertManager } from '../alerts';
import { CoreSample } from '../collectors/core';
import { MountUsage } from '../collectors/disks';
import { GpuSample } from '../collectors/gpu';
import { getSysInfo } from '../collectors/sysinfo';
import { Monitor } from '../monitor';
import { Demandable } from '../scheduler';
import * as fmt from '../util/format';
import { remoteLabel } from '../util/remote';
import { shortCmd } from './common';
import { DuScanner } from './duShared';
import { setPanelNavigator } from './nav';
import { diskAction, dockerAction, dockerMsg, disksMsg, DuPanel, portAction, portsMsg, procAction, procsMsg, tmuxAction, tmuxMsg, usersMsg, validQuery, watchesMsg, watchRemove } from './overviewPages';
import { strings } from './overviewStrings';

const VIEW_ID = 'serverMonitor.overview';
/** Demands every page needs (the 概览 cards and the attention cards, whose count shows on every page). */
const KEY = 'overview';
/** Demands of the page currently shown. */
const PAGE_KEY = 'overview:page';
/** One per extension host, i.e. per window: a page saved by an earlier window is not restored (new windows open on 概览). */
const SESSION = randomBytes(8).toString('hex');
const PAGES: readonly Page[] = ['ov', 'proc', 'port', 'disk', 'gpu', 'user', 'tmux', 'tools', 'du', 'watch', 'docker'];
const isPage = (v: unknown): v is Page => PAGES.includes(v as Page);
/** Pages that show live core samples (cards / disk I/O) and GPU samples. */
const CORE_PAGES = new Set<Page>(['ov', 'disk']);
const GPU_PAGES = new Set<Page>(['ov', 'gpu']);
/** History sent for the sparklines. */
const SPARK_MS = 125_000;
const ATTN_DEBOUNCE_MS = 150;
/** Coalesces page rebuilds (e.g. a process scan and a GPU app update landing together). */
const PAGE_DEBOUNCE_MS = 60;
/** A process is "heavy" from 2 cores or 10 % of RAM. */
const HEAVY_CPU = 200;
const HEAVY_RSS = 0.1;
const GPU_MEM_PCT = 90;
const GPU_TEMP = 85;
const SWAP_PCT = 50;
/** Percentage points below a threshold before a shown card goes away (no flicker at the edge). */
const HYST = 2;
/** Commands the webview may run. Anything else is ignored. */
const COMMANDS = new Set([
  'serverMonitor.openDashboard',
  'serverMonitor.freeUp',
  'serverMonitor.pickGpus',
  'serverMonitor.copyFreeGpus',
  'serverMonitor.watchFreeGpus',
  'serverMonitor.tmux.new',
  'serverMonitor.openSettings',
  'serverMonitor.refresh',
  'serverMonitor.quickCommands.add',
  'serverMonitor.watch.clear',
  'serverMonitor.disk.refresh',
]);

/** Round for the wire; NaN/Infinity become null (JSON cannot carry NaN). */
function rnd(v: number | undefined, digits = 0): N {
  if (v === undefined || !isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** "40.2 GB" — same style as the webview's fmtBytes. */
function size(n: number | undefined): string {
  if (n === undefined || !isFinite(n) || n < 0) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export function registerOverview(ctx: vscode.ExtensionContext, m: Monitor, alerts: AlertManager, scanner = new DuScanner()): void {
  const provider = new OverviewProvider(ctx, m, alerts, scanner);
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: false } }),
    provider,
    setPanelNavigator((g) => provider.goto(g)),
  );
}

/**
 * The sidebar panel: one webview with page navigation (监控 / 算力 / 工具 and their pages). The webview is destroyed
 * whenever the view is hidden (retainContextWhenHidden: false), so demands and data subscriptions are held only while
 * it is visible. While visible, the baseline (what 概览 and the attention cards need) is always held; anything a single
 * page needs (ports, tmux, Docker, all users' processes) only while that page is shown. Only the shown page's data is
 * built and posted.
 */
export class OverviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private visible = false;
  /** The current webview instance has said `ready` and not been torn down since. */
  private ready = false;
  private live: { dispose(): void }[] = [];
  private pageLive: { dispose(): void }[] = [];
  private viewSubs: vscode.Disposable[] = [];
  private subs: { dispose(): void }[];
  private attnTimer?: NodeJS.Timeout;
  private lastAttn = '';
  /** Ids of the attention cards currently shown (for hysteresis). */
  private shown = new Set<string>();
  private relevant?: { key: string; mounts: Set<string> };
  /** The page the webview shows (it reports every switch). */
  page: Page = 'ov';
  query: ProcQuery;
  /** The ports page shows other users' ports (its "other users" section is expanded). */
  portOthers = false;
  /** pid:start keys whose command line the current webview instance already received. */
  private sentCmds = new Set<string>();
  private pageTimer?: NodeJS.Timeout;
  private lastPage = '';
  private pendingGoto?: Goto;
  readonly du: DuPanel;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly m: Monitor,
    private readonly alerts: AlertManager,
    scanner: DuScanner,
  ) {
    this.query = { scope: m.cfg.processScope, q: '', sort: 'cpu', limit: m.cfg.processLimit };
    this.du = new DuPanel(ctx, m, scanner, () => this.pageData('du'));
    this.subs = [
      m.onConfig.event(() => {
        this.post(() => this.cfgMsg());
        this.scheduleAttn();
        if (this.page === 'docker') this.setPage('docker', true);
        else this.pageData('watch');
      }),
      alerts.onChange.event(() => {
        this.post(() => this.watchMsg());
        this.pageData('watch');
      }),
      scanner.onChange.event(() => this.pageData('du')),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.relevant = undefined;
        this.scheduleAttn();
      }),
    ];
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.dropView();
    this.view = view;
    const roots = [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'), vscode.Uri.joinPath(this.ctx.extensionUri, 'media')];
    view.webview.options = { enableScripts: true, localResourceRoots: roots };
    view.webview.html = this.html(view.webview);
    this.viewSubs.push(
      view.onDidChangeVisibility(() => this.setVisible(view.visible)),
      view.onDidDispose(() => {
        if (this.view !== view) return;
        this.dropView();
        this.view = undefined;
      }),
      view.webview.onDidReceiveMessage((msg: unknown) => this.onMessage(msg)),
    );
    this.setVisible(view.visible);
  }

  // ------------------------------------------------------------ navigation (commands → panel)

  /** Show the panel on a page (used by serverMonitor.locate, Explorer "analyze folder", …). */
  async goto(g: Goto): Promise<void> {
    if (!isPage(g.page) || !this.pageAllowed(g.page)) return;
    if (g.page === 'du' && g.path && !(await this.du.openTrusted(g.path))) return;
    if (this.visible && this.ready && this.view) {
      this.applyGoto(g);
      this.post((): OvHostMsg => ({ type: 'goto', goto: g }));
    } else this.pendingGoto = g;
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
  }

  private applyGoto(g: Goto): void {
    if (g.page !== 'proc') return;
    this.query = { scope: g.scope ?? this.query.scope, q: g.q ?? this.query.q, sort: g.sort ?? this.query.sort, limit: this.m.cfg.processLimit };
  }

  private pageAllowed(p: Page): boolean {
    return p !== 'docker' || !!this.m.dockerC.socketPath;
  }

  // ------------------------------------------------------------ lifecycle

  private setVisible(v: boolean): void {
    if (v === this.visible) return;
    this.visible = v;
    if (!v) return this.release();
    const m = this.m;
    const sources = m.gpuC.available === false ? [m.core, m.disks, m.procs] : [m.core, m.disks, m.procs, m.gpu, m.gpuApps];
    this.live.push(
      ...sources.map((s) => s.demand(KEY)),
      m.core.onData.event((c) => {
        if (CORE_PAGES.has(this.page)) this.post(() => this.coreMsg(c));
        this.scheduleAttn();
      }),
      m.gpu.onData.event((g) => {
        if (GPU_PAGES.has(this.page)) this.post(() => this.gpuMsg(g));
        this.scheduleAttn();
      }),
      m.disks.onData.event((d) => {
        if (this.page === 'ov') this.post(() => this.diskMsg(d.mounts));
        this.pageData('disk');
        this.scheduleAttn();
      }),
      m.gpuApps.onData.event(() => {
        this.scheduleAttn();
        this.pageData('proc', 'user');
      }),
      m.procs.onData.event(() => {
        this.scheduleAttn();
        this.pageData('proc', 'user');
      }),
      m.ports.onData.event(() => this.pageData('port')),
      m.tmux.onData.event(() => this.pageData('tmux')),
      m.docker.onData.event(() => this.pageData('docker')),
    );
    if (m.gpuC.available === undefined) {
      // Tell the webview when detection finds no GPU, so it shows the empty state instead of "waiting".
      void m.gpuC.detect().then(
        (ok) => {
          if (!ok) this.post((): OvGpu => ({ type: 'gpu', t: Date.now(), gpus: [], none: true }));
        },
        () => undefined,
      );
    }
    // The page's own demands follow once the webview reports which page it shows (`ready`).
  }

  private release(): void {
    this.ready = false;
    for (const d of this.live) d.dispose();
    this.live = [];
    this.releasePage();
    this.m.needAllProcesses(KEY, false);
    clearTimeout(this.attnTimer);
    this.attnTimer = undefined;
  }

  private releasePage(): void {
    for (const d of this.pageLive) d.dispose();
    this.pageLive = [];
    clearTimeout(this.pageTimer);
    this.pageTimer = undefined;
  }

  private dropView(): void {
    this.visible = false;
    this.release();
    for (const d of this.viewSubs) d.dispose();
    this.viewSubs = [];
  }

  dispose(): void {
    this.dropView();
    for (const d of this.subs) d.dispose();
    this.subs = [];
  }

  // ------------------------------------------------------------ pages

  /** Sources a page needs beyond the baseline. */
  private pageSources(p: Page): Demandable[] {
    const m = this.m;
    switch (p) {
      case 'port':
        return [m.ports];
      case 'tmux':
        return m.tmuxC.binary ? [m.tmux] : [];
      case 'docker':
        return m.cfg.dockerEnabled && m.dockerC.socketPath ? [m.docker] : [];
      default:
        return [];
    }
  }

  private needsAllProcs(): boolean {
    return this.visible && (this.page === 'user' || (this.page === 'proc' && this.query.scope === 'all'));
  }

  /** Switch the page: swap its demands and send a snapshot of its data. */
  private setPage(p: Page, force = false): void {
    if (!isPage(p) || !this.pageAllowed(p)) p = 'ov';
    if (p === this.page && !force) return;
    this.page = p;
    this.releasePage();
    // set, not toggled off and on: moving between two pages that both need every user's processes costs nothing
    this.m.needAllProcesses(KEY, this.needsAllProcs());
    if (!this.visible) return;
    this.pageLive = this.pageSources(p).map((s) => s.demand(PAGE_KEY));
    this.lastPage = '';
    const m = this.m;
    if (p === 'ov') {
      this.post(() => this.hist());
      if (m.core.latest) this.post(() => this.coreMsg(m.core.latest!));
      if (m.gpu.latest) this.post(() => this.gpuMsg(m.gpu.latest!));
      if (m.disks.latest) this.post(() => this.diskMsg(m.disks.latest!.mounts));
    } else if (p === 'gpu') {
      if (m.gpu.latest) this.post(() => this.gpuMsg(m.gpu.latest!));
    } else {
      if (p === 'disk' && m.core.latest) this.post(() => this.coreMsg(m.core.latest!));
      this.schedulePage(0);
    }
  }

  /** A data change relevant to `pages`: rebuild if one of them is shown. */
  private pageData(...pages: Page[]): void {
    if (this.visible && this.ready && pages.includes(this.page)) this.schedulePage();
  }

  private schedulePage(ms = PAGE_DEBOUNCE_MS): void {
    if (this.pageTimer) {
      if (ms) return;
      clearTimeout(this.pageTimer);
    }
    this.pageTimer = setTimeout(() => {
      this.pageTimer = undefined;
      const msg = this.pageMsg();
      if (!msg) return;
      // Unchanged payloads are not re-sent (command lines go out once, so compare without them).
      const key = JSON.stringify(msg, (k, v) => (k === 'cmd' || k === 'sc' ? undefined : v));
      if (key === this.lastPage) return;
      this.lastPage = key;
      this.post(() => msg);
    }, ms);
  }

  private pageMsg(): OvPageMsg | undefined {
    const m = this.m;
    switch (this.page) {
      case 'proc':
        return procsMsg(m, this.query, this.sentCmds);
      case 'port':
        return portsMsg(m, this.portOthers);
      case 'disk':
        return disksMsg(m);
      case 'user':
        return usersMsg(m);
      case 'tmux':
        return tmuxMsg(m);
      case 'du':
        return this.du.msg();
      case 'watch':
        return watchesMsg(m, this.alerts);
      case 'docker':
        return dockerMsg(m);
      default:
        return undefined;
    }
  }

  // ------------------------------------------------------------ messages

  /** Messages are built and sent only for a visible, initialised webview. */
  private post(make: () => OvHostMsg): void {
    if (this.visible && this.ready && this.view) void this.view.webview.postMessage(make());
  }

  private run = (id: string, ...args: unknown[]): void => {
    void vscode.commands.executeCommand(id, ...args).then(undefined, (err: unknown) => void vscode.window.showErrorMessage(String((err as Error)?.message ?? err)));
  };

  private onMessage(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const o = msg as OvViewMsg;
    const m = this.m;
    switch (o.type) {
      case 'ready': {
        this.ready = true;
        this.sentCmds.clear();
        this.lastPage = '';
        let page: Page = isPage(o.page) && o.sess === SESSION ? o.page : 'ov';
        const goto = this.pendingGoto;
        this.pendingGoto = undefined;
        if (goto) {
          page = goto.page;
          this.applyGoto(goto);
        }
        if (!this.pageAllowed(page)) page = 'ov';
        this.post(() => this.init(page, goto));
        this.setPage(page, true);
        break;
      }
      case 'page':
        if (isPage(o.page)) this.setPage(o.page);
        break;
      case 'procQuery': {
        const q = validQuery(o.query);
        if (!q) return;
        this.query = q;
        if (this.page !== 'proc') return;
        m.needAllProcesses(KEY, this.needsAllProcs());
        this.lastPage = '';
        this.schedulePage(0);
        break;
      }
      case 'portOthers':
        this.portOthers = o.on === true;
        if (this.page === 'port') this.schedulePage(0);
        break;
      case 'proc':
        return procAction(m, o, this.run);
      case 'port':
        return portAction(m, o, this.run);
      case 'disk':
        return diskAction(m, o, this.run);
      case 'tmux':
        return tmuxAction(m, o, this.run);
      case 'docker':
        return dockerAction(m, o, this.run);
      case 'du':
        void this.du.action(o, this.run);
        break;
      case 'watchRemove':
        return watchRemove(this.alerts, o.id, this.run);
      case 'command':
        if (typeof o.id === 'string' && COMMANDS.has(o.id)) this.run(o.id);
        break;
      case 'quickRun':
      case 'quickRemove': {
        // The command text guards against a list that changed between render and click.
        const q = isInt(o.index) ? m.cfg.quickCommands[o.index] : undefined;
        if (q && q.command === o.command) this.run(o.type === 'quickRun' ? 'serverMonitor.quickCommands.run' : 'serverMonitor.quickCommands.remove', o.index);
        break;
      }
      case 'copyGpus':
      case 'exportGpus': {
        const ids = this.validGpus(o.indexes);
        if (!ids) return;
        if (o.type === 'copyGpus') {
          void vscode.env.clipboard.writeText(`CUDA_VISIBLE_DEVICES=${ids}`);
          vscode.window.setStatusBarMessage(`$(check) ${l10n.t('Copied CUDA_VISIBLE_DEVICES={0}', ids)}`, 3000);
        } else {
          const term = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: l10n.t('Server Monitor') });
          term.show();
          term.sendText(`export CUDA_VISIBLE_DEVICES=${ids}`);
          vscode.window.setStatusBarMessage(`$(terminal) ${l10n.t('Exported CUDA_VISIBLE_DEVICES={0}', ids)}`, 3000);
        }
        break;
      }
    }
  }

  /** "0,3,5" for indexes that exist right now, or undefined. */
  private validGpus(v: unknown): string | undefined {
    if (!Array.isArray(v) || !v.length || v.length > 64) return undefined;
    const known = new Set((this.m.gpu.latest?.gpus ?? []).map((g) => g.index));
    if (!v.every((i) => isInt(i) && known.has(i))) return undefined;
    return [...new Set(v as number[])].sort((a, b) => a - b).join(',');
  }

  // ------------------------------------------------------------ attention cards

  private scheduleAttn(): void {
    if (!this.visible || !this.ready || this.attnTimer) return;
    this.attnTimer = setTimeout(() => {
      this.attnTimer = undefined;
      const msg = this.attnMsg();
      const key = JSON.stringify(msg.items);
      if (key === this.lastAttn) return;
      this.lastAttn = key;
      this.post(() => msg);
    }, ATTN_DEBOUNCE_MS);
  }

  /** Over the limit, or still within HYST points of it while the card is already shown. */
  private over(id: string, v: number, limit: number): boolean {
    return v >= limit || (this.shown.has(id) && v >= limit - HYST);
  }

  attnMsg(): OvAttn {
    const m = this.m;
    const cfg = m.cfg;
    const out: Attn[] = [];
    const myUid = m.names.myUid;
    const core = m.core.latest;
    const memTotal = core?.mem.total || os.totalmem();
    const mine = (m.procs.latest?.procs ?? []).filter((p) => p.uid === myUid);

    // 1. the current user's heaviest process
    const heavy = mine.filter((p) => p.cpu >= HEAVY_CPU || p.rss >= HEAVY_RSS * memTotal);
    if (heavy.length) {
      const score = (p: { cpu: number; rss: number }) => Math.max(p.cpu / HEAVY_CPU, p.rss / (HEAVY_RSS * memTotal));
      const w = heavy.reduce((a, b) => (score(b) > score(a) ? b : a));
      const parts = [shortCmd(m.procC.cmdline(w)) || w.comm, `${Math.round(w.cpu)}% CPU`, size(w.rss)];
      if (heavy.length > 1) parts.push(l10n.t('+{0} more', heavy.length - 1));
      out.push({ id: `proc:${w.pid}`, sev: w.rss >= 0.25 * memTotal ? 'crit' : 'warn', title: l10n.t('High-usage process PID {0}', w.pid), detail: parts.join(' · '), loc: { kind: 'proc', pid: w.pid } });
    }

    // 2. GPUs the current user runs on that are nearly full or hot
    const myGpu = new Map<number, string>();
    for (const a of m.gpuApps.latest ?? []) if (a.uid === myUid && a.gpuIndex >= 0 && !myGpu.has(a.gpuIndex)) myGpu.set(a.gpuIndex, shortCmd(a.cmd) || a.name);
    for (const g of m.gpu.latest?.gpus ?? []) {
      const cmd = myGpu.get(g.index);
      if (cmd === undefined) continue;
      const id = `gpu:${g.index}`;
      const mp = g.memTotal ? (g.memUsed / g.memTotal) * 100 : NaN;
      const detail = l10n.t('Your process: {0}', cmd);
      if (this.over(id, mp, GPU_MEM_PCT)) {
        out.push({ id, sev: mp >= 98 ? 'crit' : 'warn', title: l10n.t('GPU {0} memory {1}', g.index, fmt.pct(mp)), detail: `${detail} · ${size(g.memUsed * 1048576)} / ${size(g.memTotal * 1048576)}`, loc: { kind: 'gpu', index: g.index } });
      } else if (this.over(id, g.temp, GPU_TEMP)) {
        out.push({ id, sev: g.temp >= 90 ? 'crit' : 'warn', title: l10n.t('GPU {0} temperature {1}', g.index, `${g.temp} °C`), detail, loc: { kind: 'gpu', index: g.index } });
      }
    }

    // 3. system memory or swap
    if (core) {
      const mem = core.mem;
      const sp = mem.swapTotal ? (mem.swapUsed / mem.swapTotal) * 100 : 0;
      if (this.over('mem', mem.percent, cfg.alertMemoryPercent)) {
        out.push({ id: 'mem', sev: mem.percent >= cfg.critPercent ? 'crit' : 'warn', title: l10n.t('Memory {0} used', fmt.pct(mem.percent)), detail: `${size(mem.used)} / ${size(mem.total)}`, loc: { kind: 'mem' } });
      } else if (this.over('swap', sp, SWAP_PCT)) {
        out.push({ id: 'swap', sev: 'warn', title: l10n.t('Swap {0} used', fmt.pct(sp)), detail: `${size(mem.swapUsed)} / ${size(mem.swapTotal)}`, loc: { kind: 'mem' } });
      }
    }

    // 4. disks that matter to this user, and any mount that stopped answering
    const mounts = m.disks.latest?.mounts ?? [];
    const rel = this.relevantMounts(mounts);
    for (const d of mounts) {
      const id = `disk:${d.mount}`;
      const loc: Locate = { kind: 'disk', mount: d.mount };
      if (d.status === 'timeout') out.push({ id, sev: 'crit', title: l10n.t('Disk {0} is not responding', d.mount), detail: `${d.fstype} · ${d.device}`, loc });
      else if (d.status === 'ok' && d.percent !== undefined && (d.home || rel.has(d.mount)) && this.over(id, d.percent, cfg.alertDiskPercent)) {
        out.push({ id, sev: d.percent >= 99 ? 'crit' : 'warn', title: l10n.t('Disk {0} is {1} full', d.mount, fmt.pct(d.percent)), detail: l10n.t('{0} free', size(d.avail)), loc });
      }
    }

    // 5. zombie and stopped processes
    for (const st of ['Z', 'T'] as const) {
      const list = mine.filter((p) => p.state === st);
      if (!list.length) continue;
      const p = list[0];
      const parts = st === 'Z' ? [p.comm, l10n.t('parent PID {0}', p.ppid)] : [shortCmd(m.procC.cmdline(p)) || p.comm];
      if (list.length > 1) parts.push(l10n.t('+{0} more', list.length - 1));
      out.push({ id: `${st}:${p.pid}`, sev: 'warn', title: st === 'Z' ? l10n.t('Zombie process PID {0}', p.pid) : l10n.t('Stopped process PID {0}', p.pid), detail: parts.join(' · '), loc: { kind: 'proc', pid: p.pid } });
    }

    out.sort((a, b) => Number(b.sev === 'crit') - Number(a.sev === 'crit'));
    this.shown = new Set(out.map((a) => a.id));
    return { type: 'attn', items: out };
  }

  /** The deepest mount holding each open workspace folder (string work only — never touches the filesystem). */
  private relevantMounts(mounts: MountUsage[]): Set<string> {
    const key = mounts.map((d) => d.mount).join('\n');
    if (this.relevant?.key === key) return this.relevant.mounts;
    const set = new Set<string>();
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      if (f.uri.scheme !== 'file') continue;
      const p = f.uri.fsPath;
      let best = '';
      for (const d of mounts) if ((p === d.mount || p.startsWith(d.mount === '/' ? '/' : d.mount + '/')) && d.mount.length > best.length) best = d.mount;
      if (best) set.add(best);
    }
    this.relevant = { key, mounts: set };
    return set;
  }

  // ------------------------------------------------------------ payloads

  private init(page: Page, goto?: Goto): OvInit {
    const m = this.m;
    const attn = this.attnMsg();
    this.lastAttn = JSON.stringify(attn.items);
    return {
      type: 'init',
      strings: strings(),
      sess: SESSION,
      page,
      goto,
      me: m.names.myName,
      procScope: m.cfg.processScope,
      procLimit: m.cfg.processLimit,
      docker: !!m.dockerC.socketPath,
      gpuAvailable: m.gpuC.available ?? null,
      sys: this.sysMsg(),
      cfg: this.cfgMsg(),
      watch: this.watchMsg(),
      attn,
    };
  }

  private sysMsg(): OvSys {
    const s = getSysInfo();
    return { hostname: s.hostname, conn: remoteLabel(), os: s.os, kernel: s.kernel, arch: s.arch, cpuCount: s.cpuCount, boot: Math.round(Date.now() - s.uptime * 1000) };
  }

  private cfgMsg(): OvCfg {
    const c = this.m.cfg;
    return { type: 'cfg', warn: c.warnPercent, crit: c.critPercent, quick: c.quickCommands.map((q) => ({ name: q.name, command: q.command })) };
  }

  private watchMsg(): OvWatch {
    let n = 0;
    for (const w of this.alerts.watches) if (w.kind === 'gpuFree') n = Math.max(n, w.count);
    return { type: 'watch', gpuFree: n, n: this.alerts.watches.length };
  }

  private hist(): OvHist {
    const since = Date.now() - SPARK_MS;
    const c = this.m.coreHistory.snapshot(since);
    const g = this.m.gpuHistory.snapshot(since);
    const delta = (t: number[]) => t.map((v, i) => (i ? v - t[i - 1] : 0));
    const ser = (k: string, d: number) => (c.series[k] ?? []).map((v) => rnd(v, d));
    const ukeys = Object.keys(g.series).filter((k) => k[0] === 'u');
    const avg = g.t.map((_, i) => {
      let s = 0;
      let n = 0;
      for (const k of ukeys) {
        const v = g.series[k][i];
        if (isFinite(v)) (s += v), n++;
      }
      return n ? rnd(s / n) : null;
    });
    return { type: 'hist', t0: c.t[0] ?? 0, dt: delta(c.t), cpu: ser('cpu', 1), mem: ser('mem', 1), rx: ser('rx', 0), tx: ser('tx', 0), g: { t0: g.t[0] ?? 0, dt: delta(g.t), u: avg } };
  }

  private coreMsg(c: CoreSample): OvCore {
    const mem = c.mem;
    return {
      type: 'core',
      t: c.t,
      cpu: rnd(c.cpu, 1),
      load: c.load.map((v) => Math.round(v * 100) / 100),
      mem: { used: mem.used, total: mem.total, percent: rnd(mem.percent, 1), cache: mem.cache, swapUsed: mem.swapUsed, swapTotal: mem.swapTotal },
      rx: rnd(c.rx),
      tx: rnd(c.tx),
      dr: rnd(c.diskRead),
      dw: rnd(c.diskWrite),
    };
  }

  private gpuMsg(g: GpuSample): OvGpu {
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

  private diskMsg(mounts: MountUsage[]): OvDisk {
    const d = mounts.find((x) => x.home) ?? mounts.find((x) => x.mount === '/');
    return { type: 'disk', home: d ? { mount: d.mount, used: rnd(d.used), total: rnd(d.total), percent: rnd(d.percent, 1), status: d.status } : null };
  }

  // ------------------------------------------------------------ html

  private html(w: vscode.Webview): string {
    const nonce = randomBytes(16).toString('base64');
    const ext = this.ctx.extensionUri;
    const js = w.asWebviewUri(vscode.Uri.joinPath(ext, 'dist', 'overview.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(ext, 'media', 'overview.css'));
    const csp = [`default-src 'none'`, `img-src ${w.cspSource} data:`, `style-src ${w.cspSource}`, `script-src 'nonce-${nonce}'`, `font-src ${w.cspSource}`].join('; ');
    return `<!DOCTYPE html>
<html lang="${esc(vscode.env.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>${esc(l10n.t('Server Monitor'))}</title>
</head>
<body>
<main id="app" aria-busy="true"></main>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
