// 算力 › 用户: per-user CPU / memory / GPUs / VRAM / process count on this machine; click a user for their processes.

import type { OvUsers, UserRow } from '../overview-protocol';
import { Bar, bar, el, emptyBox, fmtB, fmtMiB, G, keyed, mark, nav, onRender, PageDef, rovingList, row, setBar, setEmpty, setText, setTitle, tr } from './core';

let data: OvUsers | undefined;
let U: ReturnType<typeof build> | undefined;

interface RowUi {
  root: HTMLElement;
  av: HTMLElement;
  n: HTMLElement;
  you: HTMLElement;
  pc: HTMLElement;
  cb: Bar;
  cv: HTMLElement;
  mb: Bar;
  mv: HTMLElement;
  g: HTMLElement;
  u?: UserRow;
}
const rows = new Map<string, RowUi>();

function build(p: HTMLElement) {
  const hint = el('div', 'hint', p, tr('usersHint'));
  const list = el('div', 'list rows ulist', p);
  const sync = rovingList(list);
  const empty = emptyBox(p, 'users');
  return { hint, list, sync, empty };
}

function meter(parent: Element, label: string): { b: Bar; v: HTMLElement } {
  const w = el('div', 'gm', parent);
  el('span', 'gl', w, label);
  const b = bar(w);
  return { b, v: el('span', 'gv', w) };
}

function makeRow(u: UserRow): RowUi {
  const r = {} as RowUi;
  r.root = row(null, 'usr', () => r.u && nav.go('proc', { q: `user:${r.u.name}`, scope: 'all' }));
  const l1 = el('div', 'u1', r.root);
  r.av = el('span', 'av', l1);
  r.n = el('b', 'un', l1);
  r.you = el('span', 'tag acc', l1, tr('youTag'));
  r.pc = el('span', 'upc', l1);
  const l2 = el('div', 'g2', r.root);
  const c = meter(l2, tr('cpu'));
  const m = meter(l2, tr('mem'));
  r.cb = c.b;
  r.cv = c.v;
  r.mb = m.b;
  r.mv = m.v;
  r.g = el('div', 'ug', r.root);
  void u;
  return r;
}

function updateRow(r: RowUi, u: UserRow): void {
  r.u = u;
  setText(r.av, (u.name[0] ?? '?').toUpperCase());
  r.root.classList.toggle('me', u.me);
  setText(r.n, u.name);
  r.you.hidden = !u.me;
  setText(r.pc, tr('nProcsShort', u.procs));
  const cores = G.sys?.cpuCount || 1;
  setBar(r.cb, (u.cpu / (cores * 100)) * 100);
  setText(r.cv, tr('coresUsed', (u.cpu / 100).toFixed(u.cpu >= 1000 ? 0 : 1)));
  setBar(r.mb, data?.memTotal ? (u.rss / data.memTotal) * 100 : NaN);
  setText(r.mv, fmtB(u.rss));
  const gk = `${u.gpus.join(',')}|${u.gpuMem}`;
  if (r.g.dataset.k !== gk) {
    r.g.dataset.k = gk;
    r.g.replaceChildren();
    if (u.gpus.length) {
      el('span', 'gl', r.g, 'GPU');
      for (const i of u.gpus) el('span', 'uc', r.g, String(i));
      el('span', 'gmv', r.g, `${tr('vram')} ${fmtMiB(u.gpuMem)}`);
    }
  }
  r.g.hidden = !u.gpus.length;
  setTitle(r.root, tr('userProcsTip', u.name));
}

function render(): void {
  if (!U) return;
  const d = data;
  const items = d && !d.pending ? d.rows : [];
  U.list.hidden = U.hint.hidden = !items.length;
  setEmpty(U.empty, !items.length, !d ? tr('loading') : !d.supported ? tr('linuxOnly') : d.pending ? tr('scanningAll') : tr('noUsers'));
  U.empty.root.classList.toggle('busy', !!d?.pending);
  keyed(U.list, rows, items, (u) => String(u.uid), makeRow, updateRow);
  U.sync();
}

export function onUsers(m: OvUsers): void {
  data = m;
  mark('page:user');
}

export const userPage: PageDef = {
  id: 'user',
  seg: 'gpu',
  label: 'pUser',
  build(root) {
    U = build(root);
    onRender('page:user', render);
  },
  render,
};
