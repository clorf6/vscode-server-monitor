// Sidebar panel webview: a header, a segmented control (监控 / 算力 / 工具) with underline tabs for the pages of the
// selected section, and the pages themselves (webview/ov/*). Pages are built the first time they are shown; only the
// shown page renders, and the host only sends the shown page's data. The page survives the webview being destroyed
// while hidden through vscode.getState (per window: the host's session id tells a new window apart).

import type { Goto, OvHostMsg, OvInit, OvKey, Page, Seg } from './overview-protocol';
import { Drawable, invalidate, readTheme, redrawAll } from './charts';
import { button, cmd, el, G, iconBtn, mark, nav, onRender, PageDef, post, resetState, save, setText, setTitle, st, tr, dur } from './ov/core';
import { onAttn, onCore, onDisk, onGpu, onHist, overviewPage, visibleAttn } from './ov/monitor';
import { onProcs, procPage } from './ov/procs';
import { onPorts, portPage } from './ov/ports';
import { diskPage, onDisks } from './ov/disks';
import { gpuPage } from './ov/gpu';
import { onUsers, userPage } from './ov/users';
import { onTmux, tmuxPage } from './ov/tmux';
import { toolsPage } from './ov/tools';
import { duPage, onDu } from './ov/du';
import { onWatches, watchPage } from './ov/watches';
import { dockerPage, onDocker } from './ov/docker';

const SEGS: [Seg, OvKey][] = [
  ['mon', 'tabMon'],
  ['gpu', 'tabGpu'],
  ['tools', 'tabTools'],
];
const PAGES: PageDef[] = [overviewPage, procPage, portPage, diskPage, gpuPage, userPage, tmuxPage, toolsPage, duPage, watchPage, dockerPage];
const byId = new Map(PAGES.map((p) => [p.id, p]));
const allowed = (p: PageDef) => p.id !== 'docker' || G.docker;
const pagesOf = (seg: Seg) => PAGES.filter((p) => p.seg === seg && allowed(p));

let shell: ReturnType<typeof buildShell> | undefined;
const roots = new Map<Page, HTMLElement>();

/** Arrow keys move between the tabs of a tablist and activate them (automatic activation). */
function tablist(list: HTMLElement, tabs: () => HTMLButtonElement[], activate: (b: HTMLButtonElement) => void): void {
  list.addEventListener('keydown', (e) => {
    const all = tabs().filter((b) => !b.hidden);
    const i = all.indexOf(e.target as HTMLButtonElement);
    if (i < 0) return;
    const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : -2;
    if (n === -2) return;
    e.preventDefault();
    const b = all[(n + all.length) % all.length];
    activate(b);
    b.focus();
  });
}

function buildShell() {
  const app = document.getElementById('app') ?? el('main', '', document.body);
  app.replaceChildren();
  app.removeAttribute('aria-busy');

  // header
  const hdr = el('header', 'hdr', app);
  const ht = el('div', 'ht', hdr);
  el('h1', '', ht, tr('title'));
  const hs = el('div', 'hs', ht);
  const hConn = el('span', 'conn', hs);
  const hHost = el('span', 'host', hs);
  const hUp = el('div', 'up', ht);
  const hb = el('div', 'hb', hdr);
  iconBtn(hb, 'dash', tr('openDash'), () => cmd('serverMonitor.openDashboard'));
  iconBtn(hb, 'refresh', tr('refresh'), () => cmd('serverMonitor.refresh'));

  // navigation: segmented control + underline tabs (sticky)
  const navEl = el('nav', 'nav', app);
  const seg = el('div', 'seg', navEl);
  seg.setAttribute('role', 'tablist');
  seg.setAttribute('aria-label', tr('segs'));
  const segBtns = SEGS.map(([id, k]) => {
    const b = button(seg, '', tr(k), () => goSeg(id));
    b.setAttribute('role', 'tab');
    b.dataset.seg = id;
    el('span', 'nb', b).hidden = true;
    return b;
  });
  tablist(seg, () => segBtns, (b) => goSeg(b.dataset.seg as Seg));
  const sub = el('div', 'ptabs', navEl);
  sub.setAttribute('role', 'tablist');
  sub.setAttribute('aria-label', tr('pages'));
  const subBtns = PAGES.map((p) => {
    const b = button(sub, '', tr(p.label), () => go(p.id));
    b.id = 'tab-' + p.id;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', 'page-' + p.id);
    b.dataset.page = p.id;
    el('span', 'nb', b).hidden = true;
    return b;
  });
  tablist(sub, () => subBtns, (b) => go(b.dataset.page as Page));
  const pages = el('div', 'pages', app);
  return { hHost, hConn, hUp, segBtns, subBtns, pages };
}

function goSeg(seg: Seg): void {
  const list = pagesOf(seg);
  const want = st.sub[seg];
  go(list.find((p) => p.id === want)?.id ?? list[0].id);
}

function go(p: Page, arg?: unknown, notify = true): void {
  if (!shell) return;
  let def = byId.get(p);
  if (!def || !allowed(def)) def = overviewPage;
  p = def.id;
  const prev = nav.page;
  let root = roots.get(p);
  if (!root) {
    root = el('section', 'page', shell.pages);
    root.id = 'page-' + p;
    root.setAttribute('role', 'tabpanel');
    root.setAttribute('aria-labelledby', 'tab-' + p);
    roots.set(p, root);
    def.build(root);
  }
  nav.page = p;
  st.page = p;
  st.sub[def.seg] = p;
  save();
  for (const [id, r] of roots) r.hidden = id !== p;
  if (prev !== p) {
    byId.get(prev)?.hide?.();
    if (notify) post({ type: 'page', page: p });
    window.scrollTo(0, 0);
  }
  def.show?.(arg);
  def.render();
  renderNav();
}
nav.go = (p, arg) => go(p, arg);

// ---------------------------------------------------------------- header & navigation

function renderHdr(): void {
  if (!shell || !G.sys) return;
  const sys = G.sys;
  const up = tr('uptime', dur((Date.now() - sys.boot) / 1000));
  setText(shell.hConn, sys.conn);
  setText(shell.hHost, sys.hostname);
  setText(shell.hUp, `${up} · ${sys.os}`);
  setTitle(shell.hHost, `${sys.hostname} · ${sys.conn} · ${sys.os} · ${sys.kernel} (${sys.arch}) · ${up}`);
}

function renderNav(): void {
  if (!shell) return;
  const cur = byId.get(nav.page)!;
  for (const b of shell.segBtns) {
    const on = b.dataset.seg === cur.seg;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  // attention count on 监控 when its cards are not in view
  const mon = shell.segBtns[0].querySelector<HTMLElement>('.nb')!;
  const vis = visibleAttn();
  mon.hidden = nav.page === 'ov' || !vis.length;
  mon.className = 'nb' + (vis.some((a) => a.sev === 'crit') ? ' crit' : ' warn');
  setText(mon, String(vis.length));
  const tip = vis.length && nav.page !== 'ov' ? tr('attnBadge', vis.length) : '';
  setTitle(shell.segBtns[0], tip);
  shell.segBtns[0].setAttribute('aria-description', tip);
  for (const b of shell.subBtns) {
    const def = byId.get(b.dataset.page as Page)!;
    b.hidden = def.seg !== cur.seg || !allowed(def);
    const on = def.id === cur.id;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    // narrow sidebars scroll the tab strip; keep the current tab in view
    if (on && b.parentElement!.scrollWidth > b.parentElement!.clientWidth) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const wb = shell.subBtns.find((b) => b.dataset.page === 'watch')!.querySelector<HTMLElement>('.nb')!;
  wb.hidden = !G.watchN;
  wb.className = 'nb neu';
  setText(wb, String(G.watchN));
}

onRender('hdr', renderHdr);
onRender('nav', renderNav);
setInterval(() => mark('hdr'), 60_000);

// ---------------------------------------------------------------- messages

function onInit(m: OvInit): void {
  G.S = m.strings;
  G.me = m.me;
  G.sys = m.sys;
  G.cfg = m.cfg;
  G.watchGpu = m.watch.gpuFree;
  G.watchN = m.watch.n;
  G.gpuNone = m.gpuAvailable === false;
  G.docker = m.docker;
  G.procScope = m.procScope;
  G.procLimit = m.procLimit;
  // a page saved by another window (or before a reload) is not restored: new windows open on 概览
  if (st.sess !== m.sess) resetState(m.sess);
  onAttn(m.attn.items);
  if (!shell) shell = buildShell();
  go(m.page, m.goto, false);
  mark('hdr', 'nav');
  readTheme();
  redrawAll();
}

function applyGoto(g: Goto): void {
  go(g.page, g);
}

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as OvHostMsg | undefined;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') return onInit(m);
  if (!shell) return;
  switch (m.type) {
    case 'cfg':
      G.cfg = m;
      return mark('page:ov', 'page:gpu', 'page:tools', 'page:disk', 'page:user');
    case 'attn':
      return onAttn(m.items);
    case 'watch':
      G.watchGpu = m.gpuFree;
      G.watchN = m.n;
      return mark('nav', 'page:gpu');
    case 'goto':
      return applyGoto(m.goto);
    case 'hist':
      return onHist(m);
    case 'core':
      return onCore(m);
    case 'gpu':
      return onGpu(m);
    case 'disk':
      return onDisk(m);
    case 'procs':
      return onProcs(m);
    case 'ports':
      return onPorts(m);
    case 'disks':
      return onDisks(m);
    case 'users':
      return onUsers(m);
    case 'tmux':
      return onTmux(m);
    case 'du':
      return onDu(m);
    case 'watches':
      return onWatches(m);
    case 'docker':
      return onDocker(m);
  }
});

// theme changes: VS Code swaps the body class and rewrites the --vscode-* variables on <html>
const retheme: Drawable = {
  draw() {
    readTheme();
    redrawAll();
  },
};
const mo = new MutationObserver(() => invalidate(retheme));
mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

const ready = () => post({ type: 'ready', page: st.page, sess: st.sess });
// A webview that survived being hidden (normally it is destroyed) asks for fresh state when shown again.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) ready();
});

readTheme();
ready();
