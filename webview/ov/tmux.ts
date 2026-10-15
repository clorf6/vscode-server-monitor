// 算力 › tmux: one card per session (attach / rename / kill), its windows and panes as rows with an action bar
// (peek, attach there, notify when the command finishes, Ctrl-C, kill). tmux state changes rarely (the host only
// sends changes), so the list is rebuilt on change and focus is restored by key.

import type { OvTmux, TmuxAction, TmuxPaneRow, TmuxSessionRow } from '../overview-protocol';
import { Act, actionBar, ago, button, cmd, el, emptyBox, icon, iconBtn, mark, onRender, PageDef, post, rovingList, row, setEmpty, setText, tr } from './core';

let data: OvTmux | undefined;
let selKey: string | undefined;
let built = '';
let U: ReturnType<typeof build> | undefined;

type Win = TmuxSessionRow['windows'][number];

function send(target: string, action: TmuxAction): void {
  post({ type: 'tmux', action, target });
}

function build(p: HTMLElement) {
  const tb = el('div', 'tb', p);
  const add = button(tb, 'btn', tr('newSession'), () => cmd('serverMonitor.tmux.new'), 'plus');
  el('span', 'sp', tb);
  const cnt = el('span', 'cnt', tb);
  const wrap = el('div', 'tsess', p);
  const sync = rovingList(wrap, { onEscape: () => select(undefined) });
  const empty = emptyBox(p, 'term');
  const emptyAdd = button(empty.acts, 'btn', tr('newSession'), () => cmd('serverMonitor.tmux.new'), 'plus');
  return { tb, add, cnt, wrap, sync, empty, emptyAdd };
}

function select(k: string | undefined): void {
  selKey = selKey === k ? undefined : k;
  mark('page:tmux');
}

function dot(parent: Element, p: TmuxPaneRow): void {
  const d = el('span', 'rd' + (p.dead ? ' dead' : p.busy ? ' busy' : ''), parent);
  d.title = p.dead ? tr('deadTip') : p.busy ? tr('runningTip') : tr('idleTag');
}

function paneRow(list: HTMLElement, w: Win, p: TmuxPaneRow, sub: boolean): void {
  const r = row(list, 'tp' + (sub ? ' nest' : ''), () => select(p.id));
  r.dataset.k = p.id;
  dot(r, p);
  const main = el('div', 'pm', r);
  const t = el('div', 'pt' + ((sub ? p.active : w.active) ? ' act' : ''), main, sub ? `${p.index}: ${p.command}` : `${w.index}: ${w.name}`);
  t.title = t.textContent ?? '';
  const s = el('div', 'ps', main, sub ? p.path : `${p.command} · ${p.path}`);
  s.title = p.path;
  const peek = iconBtn(r, 'eye', tr('aPeek'), () => send(p.id, 'peek'), 'ib ra');
  peek.tabIndex = -1;
  const on = selKey === p.id;
  r.classList.toggle('sel', on);
  r.setAttribute('aria-expanded', String(on));
  if (!on) return;
  const acts: (Act | false)[] = [
    { ic: 'eye', label: tr('aPeek'), run: () => send(p.id, 'peek'), kind: 'primary' },
    { ic: 'attach', label: tr('aAttach'), run: () => send(p.id, 'attach') },
    p.busy && { ic: 'bell', label: tr('aWatchCmd'), run: () => send(p.id, 'watch') },
    p.busy && { ic: 'stop', label: tr('aCtrlC'), run: () => send(p.id, 'ctrlC') },
    { ic: 'x', label: sub ? tr('aKillPane') : tr('aKillWindow'), run: () => send(p.id, 'kill'), kind: 'danger' },
  ];
  list.appendChild(actionBar(acts));
}

function winRow(list: HTMLElement, s: TmuxSessionRow, w: Win): void {
  const k = `${s.id}:${w.index}`;
  const r = row(list, 'tw', () => select(k));
  r.dataset.k = k;
  el('span', 'ric', r).appendChild(icon('win'));
  const main = el('div', 'pm', r);
  el('div', 'pt' + (w.active ? ' act' : ''), main, `${w.index}: ${w.name}`);
  el('div', 'ps', main, tr('nPanes', w.panes.length));
  const on = selKey === k;
  r.classList.toggle('sel', on);
  r.setAttribute('aria-expanded', String(on));
  if (on)
    list.appendChild(
      actionBar([
        { ic: 'attach', label: tr('aAttach'), run: () => send(k, 'attach'), kind: 'primary' },
        { ic: 'x', label: tr('aKillWindow'), run: () => send(k, 'kill'), kind: 'danger' },
      ]),
    );
}

function sessionCard(parent: HTMLElement, s: TmuxSessionRow): void {
  const card = el('section', 'card ts', parent);
  card.setAttribute('aria-label', s.name);
  const h = el('div', 'tsh', card);
  el('span', 'ric', h).appendChild(icon('term'));
  const n = el('b', 'tn', h, s.name);
  n.title = s.name;
  const panes = s.windows.flatMap((w) => w.panes);
  const running = panes.filter((p) => p.busy).length;
  el('span', 'sp', h);
  iconBtn(h, 'attach', tr('aAttach'), () => send(s.id, 'attach'));
  iconBtn(h, 'edit', tr('aRename'), () => send(s.id, 'rename'));
  iconBtn(h, 'x', tr('aKillSession'), () => send(s.id, 'kill'), 'ib danger');
  const meta = el('div', 'tsm', card);
  if (s.attached) el('span', 'tag ok', meta, tr('attachedTag'));
  el('span', running ? 'tag acc' : 'tag', meta, running ? tr('nRunning', running) : tr('idleTag'));
  el('span', '', meta, [tr('nWindows', s.windows.length), tr('created', ago(s.created))].join(' · '));
  const list = el('div', 'rows', card);
  for (const w of s.windows) {
    if (w.panes.length === 1) paneRow(list, w, w.panes[0], false);
    else {
      winRow(list, s, w);
      for (const p of w.panes) paneRow(list, w, p, true);
    }
  }
}

function render(): void {
  if (!U) return;
  const d = data;
  const sessions = d?.installed ? d.sessions : [];
  U.tb.hidden = !sessions.length;
  U.wrap.hidden = !sessions.length;
  U.emptyAdd.hidden = !d?.installed || d.loading;
  setEmpty(U.empty, !sessions.length, !d || d.loading ? tr('loading') : !d.installed ? tr('tmuxMissing') : tr('tmuxEmpty'), d?.installed && !d.loading ? tr('tmuxEmptyHint') : '');
  setText(U.cnt, sessions.length ? String(sessions.length) : '');
  const all = new Set(sessions.flatMap((s) => [s.id, ...s.windows.flatMap((w) => [`${s.id}:${w.index}`, ...w.panes.map((p) => p.id)])]));
  if (selKey && !all.has(selKey)) selKey = undefined;
  const k = JSON.stringify(sessions) + '|' + selKey;
  if (k === built) return;
  built = k;
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-k]')?.dataset.k;
  U.wrap.replaceChildren();
  for (const s of sessions) sessionCard(U.wrap, s);
  U.sync();
  if (focused) {
    const r = U.wrap.querySelector<HTMLElement>(`[data-k="${CSS.escape(focused)}"]`);
    if (r) {
      r.tabIndex = 0;
      r.focus();
    }
  }
}

export function onTmux(m: OvTmux): void {
  data = m;
  mark('page:tmux');
}

export const tmuxPage: PageDef = {
  id: 'tmux',
  seg: 'gpu',
  label: 'pTmux',
  build(root) {
    U = build(root);
    onRender('page:tmux', render);
  },
  render,
};
