// 监控 › 端口: my listening ports (open in browser / editor, copy URL, end the process) and, folded, other users'.

import type { OvPorts, PortAction, PortRow } from '../overview-protocol';
import { actionBar, button, el, emptyBox, iconBtn, keyed, mark, onRender, PageDef, placeActs, post, rovingList, row, save, setEmpty, setText, setTitle, st, tr, icon } from './core';

let data: OvPorts | undefined;
let selKey: string | undefined;
let U: ReturnType<typeof build> | undefined;

interface RowUi {
  root: HTMLElement;
  ic: HTMLElement;
  t: HTMLElement;
  pp: HTMLElement;
  s: HTMLElement;
  p?: PortRow;
}
const mine = new Map<string, RowUi>();
const others = new Map<string, RowUi>();
const acts: { mine?: HTMLElement; others?: HTMLElement } = {};
const keyOf = (p: PortRow) => `${p.port}:${p.uid}:${p.pid ?? ''}`;

function send(p: PortRow, action: PortAction): void {
  post({ type: 'port', action, port: p.port, uid: p.uid, pid: p.pid });
}

function build(p: HTMLElement) {
  const sh = el('div', 'sh', p);
  el('h2', '', sh, tr('myPorts'));
  const nMine = el('span', 'cnt', sh);
  const listMine = el('div', 'list rows', p);
  const syncMine = rovingList(listMine, { onEscape: () => select(undefined) });
  const emptyMine = el('div', 'lempty', p, tr('noMyPorts'));
  const hint = el('div', 'hint', p, tr('portsHint'));
  const disc = button(p, 'disc', ' ', () => {
    st.others = !st.others;
    save();
    post({ type: 'portOthers', on: !!st.others });
    mark('page:port');
  }, 'chev');
  const listOthers = el('div', 'list rows', p);
  const capped = el('div', 'hint', p);
  const syncOthers = rovingList(listOthers, { onEscape: () => select(undefined) });
  const empty = emptyBox(p, 'plug');
  return { sh, nMine, listMine, syncMine, emptyMine, hint, disc, listOthers, capped, syncOthers, empty };
}

function select(k: string | undefined): void {
  selKey = selKey === k ? undefined : k;
  mark('page:port');
}

function makeRow(p: PortRow, k: string): RowUi {
  const root = row(null, 'po', () => select(k));
  const ic = el('span', 'ric', root);
  const main = el('div', 'pm', root);
  const l1 = el('div', 'pt', main);
  const t = el('b', 'pn', l1);
  const pp = el('span', 'pp', l1);
  const s = el('div', 'ps', main);
  const r: RowUi = { root, ic, t, pp, s };
  const open = iconBtn(root, 'ext', tr('aOpen'), () => r.p && send(r.p, 'open'), 'ib ra');
  open.tabIndex = -1;
  void p;
  return r;
}

function updateRow(r: RowUi, p: PortRow): void {
  if (r.p?.local !== p.local || !r.ic.firstChild) r.ic.replaceChildren(icon(p.local ? 'lock' : 'globe'));
  r.p = p;
  setText(r.t, `:${p.port}`);
  setText(r.pp, p.mine ? [p.proc ?? '?', p.pid ? tr('pidL', p.pid) : ''].filter(Boolean).join(' · ') : p.user);
  setText(r.s, p.local ? `${tr('loopback')} · ${p.hosts.join(', ')}` : p.hosts.some((h) => h === '0.0.0.0' || h === '::' || h === '*') ? `${tr('allIfaces')} · ${p.hosts.join(', ')}` : p.hosts.join(', '));
  setTitle(r.root, `:${p.port} · ${p.hosts.join(', ')}`);
  const k = keyOf(p);
  r.root.classList.toggle('sel', selKey === k);
  r.root.setAttribute('aria-expanded', String(selKey === k));
}

function makeActs(p: PortRow): HTMLElement {
  return actionBar([
    { ic: 'ext', label: tr('aOpen'), run: () => send(p, 'open'), kind: 'primary' },
    { ic: 'win', label: tr('aOpenEditor'), run: () => send(p, 'editor') },
    { ic: 'copy', label: tr('aCopyUrl'), run: () => send(p, 'copy'), copy: true },
    p.mine && !!p.pid && { ic: 'kill', label: tr('aKillPort'), run: () => send(p, 'kill'), kind: 'danger' },
  ]);
}

function render(): void {
  if (!U) return;
  const d = data;
  const ok = !!d && d.supported && !d.loading;
  for (const e of [U.sh, U.listMine, U.hint, U.disc]) e.hidden = !ok;
  if (!ok) {
    U.listOthers.hidden = U.emptyMine.hidden = true;
    setEmpty(U.empty, true, !d || d.loading ? tr('loading') : tr('linuxOnly'));
    return;
  }
  const m = d.rows.filter((p) => p.mine);
  const o = d.rows.filter((p) => !p.mine);
  const any = !!(d.rows.length || d.othersN);
  setEmpty(U.empty, !any, tr('noPorts'));
  U.sh.hidden = !any;
  setText(U.nMine, String(m.length));
  U.listMine.hidden = !m.length;
  U.emptyMine.hidden = !!m.length || !any;
  U.hint.hidden = !d.rows.some((p) => p.local);
  keyed(U.listMine, mine, m, keyOf, makeRow, updateRow);
  U.disc.hidden = !d.othersN;
  setText(U.disc.lastElementChild!, tr('otherPorts', d.othersN));
  U.disc.setAttribute('aria-expanded', String(!!st.others));
  U.listOthers.hidden = !st.others || !o.length;
  U.capped.hidden = !st.others || o.length >= d.othersN || !o.length;
  setText(U.capped, tr('portsCapped', o.length));
  keyed(U.listOthers, others, st.others ? o : [], keyOf, makeRow, updateRow);
  const sm = selKey ? mine.get(selKey) : undefined;
  const so = selKey ? others.get(selKey) : undefined;
  if (selKey && !sm && !so) selKey = undefined;
  acts.mine = placeActs(U.listMine, acts.mine, sm?.root, () => makeActs(sm!.p!), selKey ?? '');
  acts.others = placeActs(U.listOthers, acts.others, so?.root, () => makeActs(so!.p!), selKey ?? '');
  U.syncMine();
  U.syncOthers();
}

export function onPorts(m: OvPorts): void {
  data = m;
  mark('page:port');
}

export const portPage: PageDef = {
  id: 'port',
  seg: 'mon',
  label: 'pPort',
  build(root) {
    U = build(root);
    onRender('page:port', render);
  },
  render,
  show() {
    post({ type: 'portOthers', on: !!st.others });
  },
};
