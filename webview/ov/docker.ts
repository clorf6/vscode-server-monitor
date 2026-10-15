// 工具 › Docker (shown when a Docker socket exists): containers with start / stop / restart / logs / shell / copy id.

import type { DockerAction, DockerRow, OvDocker } from '../overview-protocol';
import { actionBar, ago, el, emptyBox, keyed, mark, onRender, PageDef, placeActs, post, rovingList, row, setCls, setEmpty, setText, setTitle, tr } from './core';

let data: OvDocker | undefined;
let selKey: string | undefined;
let acts: HTMLElement | undefined;
let U: ReturnType<typeof build> | undefined;

interface RowUi {
  root: HTMLElement;
  d: HTMLElement;
  n: HTMLElement;
  s: HTMLElement;
  c?: DockerRow;
}
const rows = new Map<string, RowUi>();

const send = (c: DockerRow, action: DockerAction) => post({ type: 'docker', action, id: c.id });

function build(p: HTMLElement) {
  const sh = el('div', 'sh', p);
  el('h2', '', sh, tr('pDocker'));
  const cnt = el('span', 'cnt', sh);
  const list = el('div', 'list rows docker', p);
  const sync = rovingList(list, { onEscape: () => select(undefined) });
  const empty = emptyBox(p, 'box');
  return { sh, cnt, list, sync, empty };
}

function select(k: string | undefined): void {
  selKey = selKey === k ? undefined : k;
  mark('page:docker');
}

function makeRow(_c: DockerRow, k: string): RowUi {
  const root = row(null, 'ct', () => select(k));
  const d = el('span', 'rd', root);
  const main = el('div', 'pm', root);
  const n = el('div', 'pt', main);
  const s = el('div', 'ps', main);
  return { root, d, n, s };
}

function updateRow(r: RowUi, c: DockerRow): void {
  r.c = c;
  setCls(r.d, 'rd' + (c.state === 'running' ? ' busy' : c.state === 'paused' ? ' warn' : ''));
  setTitle(r.d, c.state);
  setText(r.n, c.name);
  setText(r.s, [c.image, c.status, c.ports.join(' ')].filter(Boolean).join(' · '));
  setTitle(r.root, `${c.id.slice(0, 12)} · ${c.image}\n${c.status} · ${tr('created', ago(c.created))}`);
  r.root.classList.toggle('sel', selKey === c.id);
  r.root.setAttribute('aria-expanded', String(selKey === c.id));
}

function makeActs(c: DockerRow): HTMLElement {
  const running = c.state === 'running';
  return actionBar([
    running ? { ic: 'stop', label: tr('aStop'), run: () => send(c, 'stop') } : { ic: 'play', label: tr('aStart'), run: () => send(c, 'start'), kind: 'primary' },
    { ic: 'refresh', label: tr('aRestart'), run: () => send(c, 'restart') },
    { ic: 'logs', label: tr('aLogs'), run: () => send(c, 'logs') },
    running && { ic: 'term', label: tr('aExec'), run: () => send(c, 'exec') },
    { ic: 'copy', label: tr('aCopyId'), run: () => send(c, 'copyId'), copy: true },
  ]);
}

function render(): void {
  if (!U) return;
  const d = data;
  const items = d?.enabled && d.status === 'ok' ? d.containers : [];
  const msg = !d || d.status === 'loading' ? tr('loading') : !d.enabled ? tr('dkDisabled') : d.status === 'no-socket' ? tr('dkNoSocket') : d.status === 'no-permission' ? tr('dkNoPerm', d.socket ?? '') : d.status === 'error' ? tr('dkError', d.error ?? '') : tr('dkEmpty');
  setEmpty(U.empty, !items.length, msg);
  U.empty.root.classList.toggle('bad', !!d && (d.status === 'no-permission' || d.status === 'error'));
  U.sh.hidden = U.list.hidden = !items.length;
  setText(U.cnt, tr('dkRunning', items.filter((c) => c.state === 'running').length));
  keyed(U.list, rows, items, (c) => c.id, makeRow, updateRow);
  const sel = selKey ? rows.get(selKey) : undefined;
  if (selKey && !sel) selKey = undefined;
  acts = placeActs(U.list, acts, sel?.root, () => makeActs(sel!.c!), `${selKey}:${sel?.c?.state}`);
  U.sync();
}

export function onDocker(m: OvDocker): void {
  data = m;
  mark('page:docker');
}

export const dockerPage: PageDef = {
  id: 'docker',
  seg: 'tools',
  label: 'pDocker',
  build(root) {
    U = build(root);
    onRender('page:docker', render);
  },
  render,
};
