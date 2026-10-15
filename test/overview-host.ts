// Host test for the sidebar panel (src/views/overview.ts): drives the real provider and Monitor (real collectors on
// this machine) through a fake webview view and checks which data sources each page acquires and releases, and that
// only the shown page's data is posted.
// Build + run: npm run test:host
import * as vscode from 'vscode';
import { registry } from './vscode-mock';
import { Monitor } from '../src/monitor';
import { registerOverview, OverviewProvider } from '../src/views/overview';
import { gotoPanel } from '../src/views/nav';
import type { Page } from '../webview/overview-protocol';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (name: string, c: unknown, extra = '') => {
  if (!c) fails++;
  console.log(`${c ? 'PASS' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
};

class Emitter<T> {
  private ls = new Set<(v: T) => void>();
  event = (l: (v: T) => void) => (this.ls.add(l), { dispose: () => this.ls.delete(l) });
  fire(v: T) {
    for (const l of [...this.ls]) l(v);
  }
}

/** Minimal WebviewView. */
class FakeView {
  visible = true;
  readonly vis = new Emitter<void>();
  readonly disp = new Emitter<void>();
  readonly recv = new Emitter<unknown>();
  onDidChangeVisibility = this.vis.event;
  onDidDispose = this.disp.event;
  posted: { type: string; [k: string]: unknown }[] = [];
  webview = {
    options: {} as unknown,
    html: '',
    cspSource: 'vscode-webview://x',
    asWebviewUri: (u: unknown) => u,
    postMessage: async (m: unknown) => (this.posted.push(JSON.parse(JSON.stringify(m))), true),
    onDidReceiveMessage: this.recv.event,
  };
  setVisible(v: boolean) {
    this.visible = v;
    this.vis.fire();
  }
  since(n: number) {
    return this.posted.slice(n);
  }
}

const SOURCES = ['core', 'gpu', 'gpuApps', 'procs', 'ports', 'tmux', 'disks', 'docker'] as const;

async function main() {
  const t0 = process.cpuUsage();
  const m = new Monitor();
  const gstate = new Map<string, unknown>();
  const ctx = {
    subscriptions: [] as { dispose(): void }[],
    extensionUri: vscode.Uri.file('/ext'),
    globalState: { get: (k: string, d?: unknown) => (gstate.has(k) ? gstate.get(k) : d), update: async (k: string, v: unknown) => void gstate.set(k, v) },
  } as unknown as vscode.ExtensionContext;
  // No AlertManager: its background demands on core/disks would hide whether the panel released its own.
  const alerts = { watches: [] as unknown[], onChange: new vscode.EventEmitter<void>() };
  registerOverview(ctx, m, alerts as never);
  const reg = registry.webviewViews.get('serverMonitor.overview');
  ok('provider registered, retainContextWhenHidden false', reg && reg.options.webviewOptions.retainContextWhenHidden === false);
  const p = reg!.provider as OverviewProvider;
  const src = m as unknown as Record<string, { active: boolean; demands: Map<string, unknown> }>;
  const active = () => SOURCES.filter((k) => src[k].active);
  const holders = (key: string) => SOURCES.filter((k) => src[k].demands.has(key));
  const allProcs = () => (m as unknown as { allProcsDemand: Set<string> }).allProcsDemand.has('overview');
  const gpuOk = await m.gpuC.detect();
  const baseline = gpuOk ? ['core', 'gpu', 'gpuApps', 'procs', 'disks'] : ['core', 'procs', 'disks'];
  const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

  const v = new FakeView();
  p.resolveWebviewView(v as unknown as vscode.WebviewView);
  ok('csp + nonce + bundle', /default-src 'none'/.test(v.webview.html) && v.webview.html.includes('/ext/dist/overview.js'));
  ok('visible → baseline demands only', same(holders('overview'), baseline) && holders('overview:page').length === 0, holders('overview').join(','));
  ok('nothing posted before ready', v.posted.length === 0);

  // a page saved by another window is not restored
  v.recv.fire({ type: 'ready', page: 'port', sess: 'another-window' });
  const init = v.posted.find((x) => x.type === 'init') as { page: Page; sess: string; strings: Record<string, string> } | undefined;
  ok('init lands on 概览 for a new window', init?.page === 'ov' && p.page === 'ov');
  ok('init carries the session id and strings', typeof init?.sess === 'string' && Object.keys(init!.strings).length > 200, `${Object.keys(init?.strings ?? {}).length} strings`);
  ok('概览 sends history + cards', v.posted.some((x) => x.type === 'hist'));
  ok('概览: no page demands, mine-only processes', holders('overview:page').length === 0 && !allProcs());
  const sess = init!.sess;

  // same window: the saved page is restored
  v.posted = [];
  v.recv.fire({ type: 'ready', page: 'port', sess });
  ok('same window restores its page', (v.posted.find((x) => x.type === 'init') as { page?: string } | undefined)?.page === 'port' && p.page === 'port');

  // ---- page by page
  const expect: Record<Page, string[]> = {
    ov: [],
    proc: [],
    port: ['ports'],
    disk: [],
    gpu: [],
    user: [],
    tmux: m.tmuxC.binary ? ['tmux'] : [],
    tools: [],
    du: [],
    watch: [],
    docker: m.dockerC.socketPath && m.cfg.dockerEnabled ? ['docker'] : [],
  };
  const table: string[] = [];
  for (const page of Object.keys(expect) as Page[]) {
    v.posted = [];
    v.recv.fire({ type: 'page', page });
    if (page === 'proc') v.recv.fire({ type: 'procQuery', query: { scope: 'mine', q: '', sort: 'cpu', limit: 50 } });
    await sleep(page === 'ov' || page === 'gpu' ? 2500 : 1500);
    const want = page === 'docker' && !m.dockerC.socketPath ? 'ov' : page;
    const pageHolders = holders('overview:page');
    const needsAll = page === 'user';
    ok(`${page}: page demands = [${expect[page].join(',')}]${needsAll ? ' + all users' : ''}`, p.page === want && same(pageHolders, expect[page]) && allProcs() === needsAll && same(holders('overview'), baseline));
    const types = [...new Set(v.posted.map((x) => x.type))].sort();
    const bytes = v.posted.reduce((a, x) => a + JSON.stringify(x).length, 0);
    table.push(`  ${want.padEnd(7)} demands: ${[...baseline, ...pageHolders].join(' ')}${allProcs() ? ' +procs(all users)' : ''}  | active: ${active().join(' ')}  | posted: ${types.join(' ')} (${bytes} B)`);
    const foreign = v.posted.filter((x) => !['attn', 'watch', 'cfg'].includes(x.type)).map((x) => x.type);
    const allowed: Record<string, string[]> = { ov: ['hist', 'core', 'gpu', 'disk'], gpu: ['gpu'], disk: ['core', 'disks'], proc: ['procs'], port: ['ports'], user: ['users'], tmux: ['tmux'], tools: [], du: ['du'], watch: ['watches'], docker: ['docker'] };
    ok(`${want}: posts only its own data`, foreign.every((t) => allowed[want].includes(t)), [...new Set(foreign)].join(','));
  }

  // ---- ports: other users' rows only while that section is expanded
  v.recv.fire({ type: 'page', page: 'port' });
  v.posted = [];
  v.recv.fire({ type: 'portOthers', on: false });
  await sleep(300);
  const folded = [...v.posted].reverse().find((x) => x.type === 'ports') as { rows: { mine: boolean }[]; othersN: number } | undefined;
  v.posted = [];
  v.recv.fire({ type: 'portOthers', on: true });
  await sleep(300);
  const open = [...v.posted].reverse().find((x) => x.type === 'ports') as { rows: { mine: boolean }[]; othersN: number } | undefined;
  const sz = (x: unknown) => JSON.stringify(x ?? '').length;
  ok('ports: folded section sends my ports + a count only', !!folded && folded.rows.every((r) => r.mine) && (open?.othersN ?? 0) === folded.othersN, `${folded?.rows.length} rows, ${folded?.othersN} others, ${sz(folded)} B`);
  ok('ports: expanded sends others (capped at 300)', !folded?.othersN || (!!open && open.rows.some((r) => !r.mine) && open.rows.filter((r) => !r.mine).length <= 300), `${open?.rows.length} rows, ${sz(open)} B`);
  v.recv.fire({ type: 'portOthers', on: false });

  // ---- processes: the all-users scope only while the page shows it
  v.recv.fire({ type: 'page', page: 'proc' });
  v.recv.fire({ type: 'procQuery', query: { scope: 'all', q: '', sort: 'mem', limit: 30 } });
  ok('proc all scope → all users demanded', allProcs());
  await sleep(7000);
  type PR = { pid: number; start: number; cmd?: string; u?: string };
  const procs = [...v.posted].reverse().find((x) => x.type === 'procs') as { scope: string; rows: PR[]; matched: number; pending: boolean } | undefined;
  ok('all-users rows arrive (≤ limit, owners named)', procs && procs.scope === 'all' && !procs.pending && procs.rows.length <= 30 && procs.rows.every((r) => typeof r.u === 'string'), `${procs?.rows.length}/${procs?.matched}`);
  m.procs.refresh();
  await sleep(6000);
  // every row's command line arrives exactly once (in whichever message first showed that process)
  const seen = new Map<string, number>();
  let rowsSent = 0;
  for (const x of v.posted)
    if (x.type === 'procs')
      for (const r of (x as unknown as { rows: PR[] }).rows) {
        rowsSent++;
        if (r.cmd !== undefined) seen.set(`${r.pid}:${r.start}`, (seen.get(`${r.pid}:${r.start}`) ?? 0) + 1);
      }
  ok('command lines are sent once per process', seen.size > 0 && [...seen.values()].every((n) => n === 1) && rowsSent > seen.size, `${seen.size} command lines for ${rowsSent} rows`);
  v.recv.fire({ type: 'procQuery', query: { scope: 'mine', q: '', sort: 'cpu', limit: 50 } });
  ok('back to mine → all users released', !allProcs());
  v.recv.fire({ type: 'procQuery', query: { scope: 'all', q: 'x'.repeat(400), sort: 'cpu', limit: 50 } });
  v.recv.fire({ type: 'procQuery', query: { scope: 'everyone', q: '', sort: 'cpu', limit: 50 } });
  v.recv.fire({ type: 'procQuery', query: { scope: 'all', q: '', sort: 'cpu', limit: 1e9 } });
  ok('invalid queries ignored', !allProcs() && p.query.scope === 'mine');
  v.recv.fire({ type: 'page', page: 'port' });
  ok('leaving 进程 releases its demands', !allProcs() && same(holders('overview:page'), ['ports']));

  // ---- actions are validated against current data
  const n0 = registry.executed.length;
  v.recv.fire({ type: 'proc', action: 'sigkill', pid: 1, start: 0 });
  v.recv.fire({ type: 'proc', action: 'sigterm', pid: -5, start: 0 });
  v.recv.fire({ type: 'port', action: 'kill', port: 22, uid: 0 });
  v.recv.fire({ type: 'tmux', action: 'kill', target: '$999' });
  v.recv.fire({ type: 'docker', action: 'stop', id: 'nope' });
  v.recv.fire({ type: 'du', action: 'term', path: '/etc' });
  v.recv.fire({ type: 'watchRemove', id: 'nope' });
  v.recv.fire({ type: 'command', id: 'workbench.action.terminal.sendSequence' });
  await sleep(50);
  ok('bad / foreign actions ignored', registry.executed.length === n0, registry.executed.slice(n0).join(','));
  const mine = m.procs.latest?.procs.find((x) => x.uid === m.names.myUid && x.pid !== process.pid);
  if (mine) {
    v.recv.fire({ type: 'proc', action: 'copyPid', pid: mine.pid, start: mine.start });
    await sleep(20);
    ok('valid process action runs the tree command', registry.executed[registry.executed.length - 1] === 'serverMonitor.proc.copyPid');
  }

  // ---- navigation from commands (serverMonitor.locate etc.)
  v.posted = [];
  const went = await gotoPanel({ page: 'proc', q: '1', scope: 'all' });
  ok('gotoPanel posts goto + focuses the view', went && v.posted.some((x) => x.type === 'goto') && registry.executed.includes('serverMonitor.overview.focus'));
  ok('goto applies the process query', p.query.q === '1' && p.query.scope === 'all');
  v.recv.fire({ type: 'page', page: 'du' });
  v.posted = [];
  await gotoPanel({ page: 'du', path: process.cwd() });
  await sleep(4000);
  const du = [...v.posted].reverse().find((x) => x.type === 'du') as { root?: string; entries: unknown[]; scanning?: number } | undefined;
  ok('goto du opens + scans the folder (child process)', du?.root === process.cwd() && du.entries.length > 0 && !du.scanning, `${du?.entries.length} entries`);

  // ---- hidden: everything released, nothing posted
  v.setVisible(false);
  const k = v.posted.length;
  ok('hidden → every demand released', active().length === 0 && holders('overview').length === 0 && holders('overview:page').length === 0 && !allProcs(), active().join(','));
  m.onConfig.fire(m.cfg);
  alerts.onChange.fire();
  await sleep(3000);
  ok('nothing posted while hidden', v.posted.length === k);
  // shown again: the webview is recreated and reports its saved page
  v.setVisible(true);
  ok('shown again → baseline only until ready', same(holders('overview'), baseline) && holders('overview:page').length === 0);
  v.recv.fire({ type: 'ready', page: 'tmux', sess });
  ok('ready restores the page and its demands', p.page === 'tmux' && same(holders('overview:page'), expect.tmux));
  v.disp.fire();
  ok('view disposed → released', active().length === 0);

  console.log('\nPer-page demands while the panel is visible (this machine):');
  console.log(table.join('\n'));
  const c = process.cpuUsage(t0);
  console.log(`\ncpu ${((c.user + c.system) / 1000).toFixed(0)} ms`);
  for (const d of ctx.subscriptions) d.dispose();
  m.dispose();
  console.log(fails ? `${fails} FAILURE(S)` : 'ALL PASS');
  setTimeout(() => process.exit(fails ? 1 : 0), 100);
}

void main();
