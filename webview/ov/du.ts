// 工具 › 文件夹: an ncdu-like browser. The host runs one `du` level per folder (child process, cached, parallel);
// this page shows the current folder's entries with size share bars, a clickable path, and recent folders / places.

import type { DuEntryRow, DuPlace, OvDu } from '../overview-protocol';
import { actionBar, button, el, elapsed, emptyBox, fmtB, icon, IconName, iconBtn, keyed, mark, onRender, PageDef, placeActs, post, rovingList, row, setEmpty, setText, setTitle, tr, ago } from './core';

let data: OvDu | undefined;
let selKey: string | undefined;
let acts: HTMLElement | undefined;
let ticker = 0;
let shown = false;
let U: ReturnType<typeof build> | undefined;

interface RowUi {
  root: HTMLElement;
  ic: HTMLElement;
  n: HTMLElement;
  sz: HTMLElement;
  pc: HTMLElement;
  fill: HTMLElement;
  e?: DuEntryRow;
}
const rows = new Map<string, RowUi>();
let rowsRoot = '';

const open = (path: string) => post({ type: 'du', action: 'open', path });

function build(p: HTMLElement) {
  // ---- no folder yet: intro + places
  const intro = el('div', 'duintro', p);
  const empty = emptyBox(intro, 'folder');
  button(empty.acts, 'primary', tr('duChoose'), () => post({ type: 'du', action: 'choose' }), 'folder');
  const placesBox = el('div', 'places', intro);

  // ---- browsing a folder
  const browse = el('div', 'dubrowse', p);
  const crumbs = el('nav', 'crumbs', browse);
  crumbs.setAttribute('aria-label', tr('duCrumbs'));
  const tb = el('div', 'tb', browse);
  const up = button(tb, 'btn sm', tr('duUp'), () => post({ type: 'du', action: 'up' }), 'up');
  const rescan = button(tb, 'btn sm', tr('duRescan'), () => post({ type: 'du', action: 'rescan' }), 'refresh');
  const cancel = button(tb, 'btn sm danger', tr('duCancel'), () => post({ type: 'du', action: 'cancel' }), 'x');
  el('span', 'sp', tb);
  button(tb, 'btn sm', tr('duChoose'), () => post({ type: 'du', action: 'choose' }), 'folder');
  const sum = el('div', 'dusum', browse);
  const scan = el('div', 'duscan', browse);
  el('span', 'spin', scan);
  const scanT = el('span', '', scan);
  const warn = el('div', 'hint warn', browse);
  warn.appendChild(icon('warn'));
  el('span', '', warn, tr('duPartial'));
  const msg = emptyBox(browse, 'folder');
  const msgBtn = button(msg.acts, 'btn', tr('duRescan'), () => post({ type: 'du', action: 'rescan' }), 'refresh');
  const list = el('div', 'list rows du', browse);
  const sync = rovingList(list, {
    onMenu: (r) => {
      const k = r.dataset.k;
      if (k) select(k);
    },
    onEscape: () => select(undefined),
  });
  const rest = el('div', 'durest', browse);
  const busy = el('div', 'hint', browse);
  return { intro, empty, placesBox, browse, crumbs, up, rescan, cancel, sum, scan, scanT, warn, msg, msgBtn, list, sync, rest, busy };
}

function select(k: string | undefined): void {
  selKey = selKey === k ? undefined : k;
  mark('page:du');
}

const PLACE_ICON: Record<DuPlace['kind'], IconName> = { recent: 'history', home: 'home', ws: 'folder', mount: 'db', net: 'cloud' };

function renderPlaces(box: HTMLElement, places: DuPlace[]): void {
  const k = JSON.stringify(places);
  if (box.dataset.k === k) return;
  box.dataset.k = k;
  box.replaceChildren();
  const groups: [string, DuPlace[]][] = [
    [tr('duRecent'), places.filter((x) => x.kind === 'recent')],
    [tr('duPlaces'), places.filter((x) => x.kind !== 'recent')],
  ];
  for (const [title, items] of groups) {
    if (!items.length) continue;
    const sh = el('div', 'sh', box);
    el('h2', '', sh, title);
    const list = el('div', 'list rows', box);
    for (const x of items) {
      const r = row(list, 'pl', () => open(x.path));
      el('span', 'ric', r).appendChild(icon(PLACE_ICON[x.kind]));
      const main = el('div', 'pm', r);
      el('div', 'pt', main, x.label);
      if (x.note) el('div', 'ps', main, x.note);
      r.title = x.path;
    }
    rovingList(list)();
  }
}

function makeRow(e: DuEntryRow, k: string): RowUi {
  const r = {} as RowUi;
  r.root = row(null, 'de', () => {
    if (r.e?.dir) open(r.e.path);
    else select(k);
  });
  r.root.dataset.k = k;
  r.ic = el('span', 'ric', r.root);
  const main = el('div', 'pm', r.root);
  const l1 = el('div', 'dl1', main);
  r.n = el('span', 'pt', l1);
  r.sz = el('b', 'dsz', l1);
  const l2 = el('div', 'dl2', main);
  const sb = el('div', 'sbar', l2);
  r.fill = el('div', '', sb);
  r.pc = el('span', 'dpc', l2);
  const more = iconBtn(r.root, 'more', tr('moreActions'), () => select(k), 'ib ra');
  more.tabIndex = -1;
  void e;
  return r;
}

function updateRow(r: RowUi, e: DuEntryRow): void {
  if (r.e?.dir !== e.dir || !r.ic.firstChild) r.ic.replaceChildren(icon(e.dir ? 'folder' : 'file'));
  r.e = e;
  setText(r.n, e.name + (e.dir ? '/' : ''));
  setText(r.sz, fmtB(e.size));
  const total = data?.total || 0;
  const pct = total ? (e.size / total) * 100 : 0;
  setText(r.pc, pct.toFixed(1) + '%');
  const w = Math.min(100, pct).toFixed(1) + '%';
  if (r.fill.style.width !== w) r.fill.style.width = w;
  r.root.classList.toggle('big', pct >= 50);
  setTitle(r.root, `${e.path}\n${fmtB(e.size)} · ${pct.toFixed(1)}%`);
  r.root.classList.toggle('sel', selKey === e.path);
  r.root.setAttribute('aria-label', `${e.name} · ${fmtB(e.size)} · ${pct.toFixed(1)}%`);
}

function makeActs(e: DuEntryRow): HTMLElement {
  return actionBar([
    e.dir && { ic: 'chev', label: tr('duOpenIn'), run: () => open(e.path), kind: 'primary' },
    { ic: 'term', label: tr('aTermHere'), run: () => post({ type: 'du', action: 'term', path: e.path }) },
    { ic: 'copy', label: tr('aCopyPath'), run: () => post({ type: 'du', action: 'copy', path: e.path }), copy: true },
  ]);
}

function tick(): void {
  if (!U || !data?.scanning) return;
  setText(U.scanT, tr('duScanningFor', data.crumbs.map((c) => c.label).join('/').replace(/^\/\//, '/').replace(/^~\//, '~/'), elapsed(data.scanning)));
}

function syncTicker(): void {
  const want = shown && !!data?.scanning;
  if (want && !ticker) ticker = window.setInterval(tick, 1000);
  if (!want && ticker) (clearInterval(ticker), (ticker = 0));
}

function render(): void {
  if (!U) return;
  const d = data;
  const has = !!d?.root;
  U.intro.hidden = has;
  U.browse.hidden = !has;
  syncTicker();
  if (!d) {
    setEmpty(U.empty, true, tr('loading'));
    return;
  }
  if (!d.supported) {
    setEmpty(U.empty, true, tr('linuxOnly'));
    U.placesBox.hidden = true;
    return;
  }
  if (!has) {
    setEmpty(U.empty, true, tr('duEmptyTitle'), tr('duEmptyHint'));
    U.placesBox.hidden = false;
    renderPlaces(U.placesBox, d.places);
    return;
  }

  // path
  const ck = JSON.stringify(d.crumbs);
  if (U.crumbs.dataset.k !== ck) {
    U.crumbs.dataset.k = ck;
    U.crumbs.replaceChildren();
    d.crumbs.forEach((c, i) => {
      if (i) el('span', 'csep', U!.crumbs).appendChild(icon('chev'));
      if (i === d.crumbs.length - 1) {
        const cur = el('b', 'ccur', U!.crumbs, c.label);
        cur.setAttribute('aria-current', 'page');
        cur.title = c.path;
      } else {
        const b = button(U!.crumbs, 'clink', c.label, () => open(c.path));
        b.title = c.path;
      }
    });
  }
  U.up.disabled = d.root === '/';
  const scanning = !!d.scanning;
  U.rescan.hidden = scanning;
  U.cancel.hidden = !scanning;
  U.scan.hidden = !scanning;
  tick();
  U.sum.hidden = d.total === undefined;
  if (d.total !== undefined) setText(U.sum, [tr('duTotal', fmtB(d.total)), d.scannedAt ? tr('duScanned', ago(d.scannedAt)) : ''].filter(Boolean).join(' · '));
  U.warn.hidden = !d.partial;
  const failed = !scanning && (d.cancelled || !!d.error);
  setEmpty(U.msg, failed || (!scanning && d.total !== undefined && !d.entries.length), d.cancelled ? tr('duCancelled') : d.error ? tr('duFailed', d.error) : tr('duEmptyFolder'));
  U.msgBtn.hidden = !failed;

  if (rowsRoot !== d.root) {
    rowsRoot = d.root!;
    selKey = undefined;
    U.list.scrollTop = 0;
  }
  U.list.hidden = !d.entries.length;
  keyed(U.list, rows, d.entries, (e) => e.path, makeRow, updateRow);
  const sel = selKey ? rows.get(selKey) : undefined;
  if (selKey && !sel) selKey = undefined;
  acts = placeActs(U.list, acts, sel?.root, () => makeActs(sel!.e!), selKey ?? '');
  U.sync();
  U.rest.hidden = !d.rest;
  if (d.rest) setText(U.rest, `${tr('duSmaller', d.rest.n)} · ${fmtB(d.rest.size)}`);
  U.busy.hidden = !d.busy.length;
  setText(U.busy, tr('duAlsoScanning', d.busy.join(', ')));
}

export function onDu(m: OvDu): void {
  data = m;
  mark('page:du');
}

export const duPage: PageDef = {
  id: 'du',
  seg: 'tools',
  label: 'pDu',
  build(root) {
    U = build(root);
    onRender('page:du', render);
  },
  render,
  show() {
    shown = true;
    syncTicker();
  },
  hide() {
    shown = false;
    syncTicker();
  },
};
