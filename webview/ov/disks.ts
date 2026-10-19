// 监控 › 磁盘: every mount with a usage meter (home first, network last, hung mounts flagged), disk I/O rates on top.

import type { DiskRow, IoRow, OvDisks } from '../overview-protocol';
import { fmtBytes, fmtPct, fmtRate } from '../charts';
import { actionBar, Bar, bar, cmd, dur, el, emptyBox, flash, G, icon, iconBtn, keyed, mark, nav, num, onRender, PageDef, placeActs, post, rovingList, row, setBar, setEmpty, setText, setTitle, tr } from './core';

let data: OvDisks | undefined;
let selKey: string | undefined;
let want: string | undefined;
let acts: HTMLElement | undefined;
let U: ReturnType<typeof build> | undefined;

interface RowUi {
  root: HTMLElement;
  ic: HTMLElement;
  n: HTMLElement;
  tags: HTMLElement;
  pc: HTMLElement;
  b: Bar;
  s: HTMLElement;
  /** "Full in about …" while it is filling up. */
  eta: HTMLElement;
  d?: DiskRow;
}
const rows = new Map<string, RowUi>();

interface IoUi {
  root: HTMLElement;
  n: HTMLElement;
  m: HTMLElement;
  pc: HTMLElement;
  b: Bar;
  s: HTMLElement;
}
const ioRows = new Map<string, IoUi>();

function build(p: HTMLElement) {
  const io = el('div', 'iohdr', p);
  io.appendChild(icon('db'));
  const ioT = el('span', 'iot', io);
  el('span', 'sp', io);
  iconBtn(io, 'refresh', tr('refresh'), () => cmd('serverMonitor.disk.refresh'));
  // physical disks: how busy each one is (where the I/O load is)
  const ioList = el('div', 'iolist', p);
  const list = el('div', 'list rows disks', p);
  const sync = rovingList(list, { onEscape: () => select(undefined) });
  const empty = emptyBox(p, 'db');
  return { io, ioT, ioList, list, sync, empty };
}

function select(k: string | undefined): void {
  selKey = selKey === k ? undefined : k;
  mark('page:disk');
}

function makeRow(_d: DiskRow, k: string): RowUi {
  const root = row(null, 'dk', () => select(k));
  const l1 = el('div', 'd1', root);
  const ic = el('span', 'ric', l1);
  const n = el('b', 'dn', l1);
  const tags = el('span', 'tags', l1);
  const pc = el('span', 'dp', l1);
  const b = bar(root, 'bar dbar');
  const s = el('div', 'ps', root);
  const eta = el('div', 'ps warn', root);
  return { root, ic, n, tags, pc, b, s, eta };
}

function ioRow(parent: Element): IoUi {
  const root = el('div', 'io', parent);
  const l1 = el('div', 'd1', root);
  const n = el('b', 'dn', l1);
  const m = el('span', 'iom', l1);
  const pc = el('span', 'dp', l1);
  const b = bar(root, 'bar dbar');
  const s = el('div', 'ps', root);
  return { root, n, m, pc, b, s };
}

function updateIo(r: IoUi, d: IoRow): void {
  setText(r.n, d.dev);
  setText(r.m, d.mounts.join(' '));
  setText(r.pc, tr('busy', fmtPct(d.util)));
  setBar(r.b, num(d.util), undefined, 'bar dbar');
  const lat = d.await == null ? '' : tr('await', d.await.toFixed(d.await >= 10 ? 0 : 1));
  setText(r.s, [tr('ioRead', fmtRate(d.r)), tr('ioWrite', fmtRate(d.w)), d.iops == null ? '' : tr('iops', Math.round(d.iops)), lat, d.temp == null ? '' : tr('temp', d.temp)].filter(Boolean).join(' · '));
  setTitle(r.root, d.mounts.length ? `${d.dev}\n${d.mounts.join('\n')}` : d.dev);
}

function updateRow(r: RowUi, d: DiskRow): void {
  const ic = d.home ? 'home' : d.network ? 'cloud' : 'db';
  if (r.ic.dataset.ic !== ic) {
    r.ic.dataset.ic = ic;
    r.ic.replaceChildren(icon(ic));
  }
  r.d = d;
  setText(r.n, d.mount);
  const tk = `${d.home}:${d.network}`;
  if (r.tags.dataset.k !== tk) {
    r.tags.dataset.k = tk;
    r.tags.replaceChildren();
    if (d.home) el('span', 'tag acc', r.tags, tr('homeTag'));
    if (d.network) el('span', 'tag', r.tags, tr('netTag'));
  }
  const bad = d.status === 'timeout' || d.status === 'error';
  r.root.classList.toggle('bad', bad);
  r.root.classList.toggle('pend', d.status === 'pending');
  if (d.status === 'ok' && d.percent != null) {
    setText(r.pc, fmtPct(d.percent, 1));
    setBar(r.b, num(d.percent), undefined, 'bar dbar');
    r.b.root.hidden = false;
    setText(r.s, [tr('usedOfTotal', fmtBytes(d.used), fmtBytes(d.total)), tr('freeOf', fmtBytes(d.avail)), d.fstype, d.inodes == null ? '' : tr('inodes', fmtPct(d.inodes)), d.disks.length ? tr('onDisk', d.disks.join(', ')) : ''].filter(Boolean).join(' · '));
  } else {
    setText(r.pc, d.status === 'pending' ? tr('checking') : bad ? tr('notResp') : '–');
    r.b.root.hidden = true;
    setText(r.s, bad ? tr('diskTimeoutHint') : `${d.fstype} · ${d.device}`);
  }
  setText(r.eta, d.eta != null && d.status === 'ok' ? `${tr('fillEta', dur(d.eta))} · ${tr('fillRate', fmtBytes((d.rate ?? 0) * 3600))}` : '');
  setTitle(r.root, `${d.mount}\n${d.device} · ${d.fstype}`);
  r.root.classList.toggle('sel', selKey === d.mount);
  r.root.setAttribute('aria-expanded', String(selKey === d.mount));
}

function makeActs(d: DiskRow): HTMLElement {
  const ok = d.status !== 'timeout';
  return actionBar([
    ok && {
      ic: 'folder',
      label: tr('aAnalyze'),
      kind: 'primary',
      run: () => {
        post({ type: 'du', action: 'open', path: d.mount });
        nav.go('du');
      },
    },
    { ic: 'term', label: tr('aTermHere'), run: () => post({ type: 'disk', action: 'term', mount: d.mount }) },
    { ic: 'copy', label: tr('aCopyPath'), run: () => post({ type: 'disk', action: 'copy', mount: d.mount }), copy: true },
  ]);
}

function render(): void {
  if (!U) return;
  const c = G.core;
  setText(U.ioT, `${tr('diskIo')}  ${tr('ioRead', fmtRate(c?.dr))} · ${tr('ioWrite', fmtRate(c?.dw))}`);
  const io = c?.disks ?? [];
  const seen = new Set<string>();
  io.forEach((d, i) => {
    seen.add(d.dev);
    let r = ioRows.get(d.dev);
    if (!r) ioRows.set(d.dev, (r = ioRow(U!.ioList)));
    updateIo(r, d);
    if (U!.ioList.children[i] !== r.root) U!.ioList.insertBefore(r.root, U!.ioList.children[i] ?? null);
  });
  for (const [k, r] of ioRows) if (!seen.has(k)) (r.root.remove(), ioRows.delete(k));
  U.ioList.hidden = !io.length;
  const d = data;
  const items = d?.mounts ?? [];
  U.list.hidden = !items.length;
  setEmpty(U.empty, !items.length, !d || d.loading ? tr('loading') : !d.supported ? tr('linuxOnly') : tr('noDisks'));
  keyed(U.list, rows, items, (x) => x.mount, makeRow, updateRow);
  if (want && rows.has(want)) {
    selKey = want;
    const r = rows.get(want)!.root;
    want = undefined;
    updateRow(rows.get(selKey)!, rows.get(selKey)!.d!);
    requestAnimationFrame(() => flash(r));
  }
  const sel = selKey ? rows.get(selKey) : undefined;
  if (selKey && !sel) selKey = undefined;
  acts = placeActs(U.list, acts, sel?.root, () => makeActs(sel!.d!), `${selKey}:${sel?.d?.status === 'timeout'}`);
  U.sync();
}

export function onDisks(m: OvDisks): void {
  data = m;
  mark('page:disk');
}

export const diskPage: PageDef = {
  id: 'disk',
  seg: 'mon',
  label: 'pDisk',
  build(root) {
    U = build(root);
    onRender('page:disk', render);
  },
  render,
  show(arg) {
    const mount = (arg as { mount?: string } | undefined)?.mount;
    if (typeof mount === 'string') want = mount;
  },
};
