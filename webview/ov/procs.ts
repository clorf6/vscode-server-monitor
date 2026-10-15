// 监控 › 进程: my / all users' processes with search, sort chips and an action bar per row. The host sends only the
// rows shown (top N); each command line comes once per pid and is cached here.

import type { OvKey, OvProcs, ProcAction, ProcRow, ProcSort, Scope } from '../overview-protocol';
import { Act, actionBar, button, dur, el, emptyBox, flash, fmtB, fmtCpu, fmtMiB, G, icon, keyed, mark, onRender, PageDef, placeActs, post, rovingList, row, save, setCls, setEmpty, setText, setTitle, st, tr } from './core';

const SORTS: [ProcSort, OvKey][] = [
  ['cpu', 'sCpu'],
  ['mem', 'sMem'],
  ['gpu', 'sGpu'],
  ['time', 'sTime'],
];
const STATE: Record<string, OvKey> = { R: 'stR', S: 'stS', D: 'stD', Z: 'stZ', T: 'stT', t: 'stT', I: 'stI' };

const cmds = new Map<string, { cmd: string; sc: string }>();
let data: OvProcs | undefined;
let limit = 0;
let selKey: string | undefined;
/** Select this pid when it shows up (locate). */
let wantPid: number | undefined;
let acts: HTMLElement | undefined;
let U: ReturnType<typeof build> | undefined;

interface RowUi {
  root: HTMLElement;
  st: HTMLElement;
  t: HTMLElement;
  s: HTMLElement;
  sg: HTMLElement;
  c: HTMLElement;
  m: HTMLElement;
  g: HTMLElement;
  p?: ProcRow;
}
const rows = new Map<string, RowUi>();
const keyOf = (p: ProcRow) => `${p.pid}:${p.start}`;

function pq(): { scope: Scope; sort: ProcSort; q: string } {
  return (st.pq ??= { scope: G.procScope, sort: 'cpu', q: '' });
}

/** `user:NAME` for someone else needs the all-users scope. */
function needsAll(q: string): boolean {
  return q.split(/\s+/).some((t) => t.toLowerCase().startsWith('user:') && t.slice(5).toLowerCase() !== G.me.toLowerCase());
}

function query(): void {
  const s = pq();
  if (!limit) limit = G.procLimit;
  post({ type: 'procQuery', query: { scope: s.scope, q: s.q, sort: s.sort, limit } });
}

function setQuery(o: { q?: string; sort?: ProcSort; scope?: Scope }): void {
  const s = pq();
  if (o.q !== undefined) s.q = o.q.trim();
  if (o.sort) s.sort = o.sort;
  if (o.scope) s.scope = o.scope;
  if (o.q !== undefined && needsAll(s.q)) s.scope = 'all';
  limit = G.procLimit;
  save();
  query();
  mark('page:proc');
}

function build(p: HTMLElement) {
  const tb = el('div', 'tb', p);
  const sw = el('label', 'search', tb);
  sw.appendChild(icon('search'));
  const input = el('input', '', sw);
  input.type = 'search';
  input.placeholder = tr('searchPh');
  input.setAttribute('aria-label', tr('search'));
  input.spellcheck = false;
  let timer = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => setQuery({ q: input.value }), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(timer);
      setQuery({ q: input.value });
    } else if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      clearTimeout(timer);
      setQuery({ q: '' });
    }
  });
  const seg = el('div', 'seg2', tb);
  seg.setAttribute('role', 'radiogroup');
  seg.setAttribute('aria-label', tr('scope'));
  const scopeBtns = (['mine', 'all'] as Scope[]).map((sc) => {
    const b = button(seg, '', tr(sc === 'mine' ? 'mine' : 'allUsers'), () => setQuery({ scope: sc }));
    b.setAttribute('role', 'radio');
    b.dataset.v = sc;
    return b;
  });

  const chips = el('div', 'chips', p);
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', tr('sortBy'));
  el('span', 'chl', chips, tr('sortBy'));
  const sortBtns = SORTS.map(([k, label]) => {
    const b = button(chips, 'chip', tr(label), () => setQuery({ sort: k }));
    b.dataset.v = k;
    return b;
  });

  const lh = el('div', 'lh', p);
  const count = el('span', 'lhc', lh);
  const pend = el('span', 'lhp', lh);
  pend.appendChild(el('span', 'spin'));
  el('span', '', pend, tr('scanningAll'));

  const box = el('div', 'list procs', p);
  const head = el('div', 'lhd', box);
  head.setAttribute('aria-hidden', 'true');
  el('span', 'hcol', head, tr('colProc'));
  el('span', 'n c', head, tr('colCpu'));
  el('span', 'n m', head, tr('colMem'));
  el('span', 'n g', head, tr('colGpu'));
  const list = el('div', 'rows', box);
  const sync = rovingList(list, { onEscape: () => select(undefined) });
  const more = button(p, 'morebtn', '', () => {
    limit += G.procLimit;
    query();
  });
  const empty = emptyBox(p, 'pulse');
  return { input, scopeBtns, sortBtns, count, pend, box, list, sync, more, empty };
}

function select(k: string | undefined): void {
  selKey = selKey === k ? undefined : k;
  mark('page:proc');
}

function makeRow(_p: ProcRow, k: string): RowUi {
  const root = row(null, 'prow', () => select(k));
  const stt = el('span', 'stt', root);
  const main = el('div', 'pm', root);
  const t = el('div', 'pt', main);
  const sl = el('div', 'ps', main);
  const s = el('span', '', sl);
  const sg = el('span', 'psg', sl);
  const c = el('span', 'n c', root);
  const m = el('span', 'n m', root);
  const g = el('span', 'n g', root);
  return { root, st: stt, t, s, sg, c, m, g };
}

function updateRow(r: RowUi, p: ProcRow): void {
  r.p = p;
  const k = keyOf(p);
  const c = cmds.get(k);
  const name = c?.sc ?? String(p.pid);
  setText(r.t, name);
  const age = dur(Math.max(0, (Date.now() - p.start) / 1000));
  setText(r.s, [tr('pidL', p.pid), p.u === undefined ? '' : p.mine ? tr('youTag') : p.u, tr('runFor', age)].filter(Boolean).join(' · '));
  // GPU memory also goes in the second line, for widths where its column is hidden (CSS picks one).
  setText(r.sg, p.g == null ? '' : ` · GPU ${fmtMiB(p.g)}`);
  setText(r.c, fmtCpu(p.cpu));
  setText(r.m, fmtB(p.rss));
  setText(r.g, p.g == null ? '' : fmtMiB(p.g));
  const sk = STATE[p.st] ?? 'stS';
  setCls(r.st, 'stt s-' + (p.st === 't' ? 'T' : STATE[p.st] ? p.st : 'S'));
  setTitle(r.st, tr(sk));
  setTitle(r.root, c ? c.cmd : name);
  r.root.classList.toggle('sel', selKey === k);
  r.root.classList.toggle('other', !p.mine);
  r.root.setAttribute('aria-expanded', String(selKey === k));
  r.root.setAttribute('aria-label', `${name} · ${tr('pidL', p.pid)} · CPU ${fmtCpu(p.cpu)} · ${tr('colMem')} ${fmtB(p.rss)}`);
}

function act(p: ProcRow, action: ProcAction): void {
  post({ type: 'proc', action, pid: p.pid, start: p.start });
}

function makeActs(p: ProcRow): HTMLElement {
  const c = cmds.get(keyOf(p));
  const line = el('code', 'cmdline', null, c?.cmd ?? String(p.pid));
  const kv = el('div', 'kv');
  kv.dataset.kv = '1';
  const note = !p.mine && el('div', 'anote', null, tr('otherUserNote', p.u ?? '?'));
  const list: (Act | false)[] = [
    { ic: 'bell', label: tr('aWatch'), run: () => act(p, 'watch') },
    p.mine && { ic: 'term', label: tr('aCwd'), run: () => act(p, 'cwd') },
    { ic: 'copy', label: tr('aCopyPid'), run: () => act(p, 'copyPid'), copy: true },
    { ic: 'copy', label: tr('aCopyCmd'), run: () => act(p, 'copyCmd'), copy: true },
    p.mine && { ic: 'stop', label: tr('aInt'), run: () => act(p, 'sigint') },
    p.mine && { ic: 'kill', label: tr('aTerm'), run: () => act(p, 'sigterm'), kind: 'danger' },
    p.mine && { ic: 'bolt', label: tr('aKill'), run: () => act(p, 'sigkill'), kind: 'danger' },
  ];
  return actionBar(list, line, kv, note);
}

function render(): void {
  if (!U) return;
  const s = pq();
  if (U.input.value.trim() !== s.q && document.activeElement !== U.input) U.input.value = s.q;
  for (const b of U.scopeBtns) b.setAttribute('aria-checked', String(b.dataset.v === s.scope));
  for (const b of U.sortBtns) b.setAttribute('aria-pressed', String(b.dataset.v === s.sort));
  setCls(U.box, `list procs sort-${s.sort}${data?.gpuCol || s.sort === 'gpu' ? '' : ' nog'}`);

  const d = data;
  const ok = !!d && d.supported;
  U.pend.hidden = !(d?.pending && s.scope === 'all');
  if (!d || !d.supported) {
    U.box.hidden = U.more.hidden = true;
    setText(U.count, '');
    setEmpty(U.empty, true, d ? tr('linuxOnly') : tr('loading'));
    return;
  }
  const items = d.rows;
  if (wantPid !== undefined) {
    const hit = items.find((p) => p.pid === wantPid);
    if (hit) {
      selKey = keyOf(hit);
      wantPid = undefined;
      requestAnimationFrame(() => {
        const r = rows.get(selKey!)?.root;
        if (r) flash(r);
      });
    }
  }
  U.box.hidden = !items.length;
  setText(U.count, s.q || s.scope === 'all' ? tr('nMatched', d.matched, d.total) : tr('nProcs', d.matched));
  keyed(U.list, rows, items, keyOf, makeRow, updateRow);
  const sel = selKey ? rows.get(selKey) : undefined;
  if (selKey && !sel) selKey = undefined;
  acts = placeActs(U.list, acts, sel?.root, () => makeActs(sel!.p!), selKey + (sel?.p?.mine ? ':m' : ''));
  if (acts && sel?.p) {
    const p = sel.p;
    const kv = acts.querySelector<HTMLElement>('[data-kv]');
    if (kv) setText(kv, [tr('pidL', p.pid), tr('ppidL', p.ppid), tr('threadsL', p.threads), tr('startedAgo', dur((Date.now() - p.start) / 1000)), tr(STATE[p.st] ?? 'stS')].join(' · '));
  }
  U.sync();
  const rest = d.matched - items.length;
  U.more.hidden = rest <= 0;
  setText(U.more, tr('showMoreN', rest));
  setEmpty(U.empty, ok && !items.length, s.q ? tr('noMatch', s.q) : tr('noProcs'));
}

export function onProcs(m: OvProcs): void {
  data = m;
  // command lines come once per process: keep them as they arrive (several messages may land before a frame)
  // (no pruning: the host decides what was sent; this webview only lives while the panel is shown)
  for (const p of m.rows) if (p.cmd !== undefined) cmds.set(keyOf(p), { cmd: p.cmd, sc: p.sc ?? p.cmd });
  mark('page:proc');
}

export const procPage: PageDef = {
  id: 'proc',
  seg: 'mon',
  label: 'pProc',
  build(root) {
    U = build(root);
    onRender('page:proc', render);
  },
  render,
  show(arg) {
    const a = arg as { q?: string; sort?: ProcSort; scope?: Scope } | undefined;
    if (a && (a.q !== undefined || a.sort || a.scope)) {
      const s = pq();
      if (a.q !== undefined) s.q = a.q;
      if (a.sort) s.sort = a.sort;
      if (a.scope) s.scope = a.scope;
      if (needsAll(s.q)) s.scope = 'all';
      save();
      selKey = undefined;
      wantPid = /^\d+$/.test(s.q) ? +s.q : undefined;
      limit = G.procLimit;
      if (U) U.input.value = s.q;
    }
    query();
  },
};
