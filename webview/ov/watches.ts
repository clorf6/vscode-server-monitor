// 工具 › 提醒: active watches (process exit, tmux command done, GPUs free) with remove, plus how to add more.

import type { OvWatches, WatchRow } from '../overview-protocol';
import { button, cmd, dur, el, emptyBox, G, icon, IconName, iconBtn, mark, nav, onRender, PageDef, post, setEmpty, setText, tr } from './core';

let data: OvWatches | undefined;
let U: ReturnType<typeof build> | undefined;
const KIND_ICON: Record<WatchRow['kind'], IconName> = { pid: 'pulse', tmux: 'term', gpuFree: 'chip' };

function build(p: HTMLElement) {
  const tb = el('div', 'tb', p);
  const addGpu = button(tb, 'btn', tr('wAddGpu'), () => cmd('serverMonitor.watchFreeGpus'), 'bell');
  el('span', 'sp', tb);
  const clear = button(tb, 'link', tr('wClear'), () => cmd('serverMonitor.watch.clear'), 'x');
  const list = el('div', 'list wl', p);
  const empty = emptyBox(p, 'bell');
  const hints = el('div', 'hints', p);
  const hint = (text: string, label: string, run: () => void, ic: IconName) => {
    const h = el('div', 'hn', hints);
    h.appendChild(icon(ic));
    const t = el('div', 'hx', h);
    el('span', '', t, text + ' ');
    button(t, 'link', label, run, 'chev');
    return t;
  };
  hint(tr('wHintProc'), tr('wGoProc'), () => nav.go('proc'), 'pulse');
  hint(tr('wHintTmux'), tr('wGoTmux'), () => nav.go('tmux'), 'term');
  const alerts = hint('', tr('settings'), () => cmd('serverMonitor.openSettings'), 'warn');
  return { addGpu, clear, list, empty, alerts };
}

function render(): void {
  if (!U) return;
  const items = data?.items ?? [];
  U.addGpu.hidden = G.gpuNone;
  U.clear.hidden = !items.length;
  U.list.hidden = !items.length;
  setEmpty(U.empty, !items.length, data ? tr('wEmpty') : tr('loading'), data ? tr('wEmptyHint') : '');
  setText(U.alerts.firstElementChild!, (data?.alerts === false ? tr('wAlertsOff') : tr('wAlerts')) + ' ');
  const k = JSON.stringify(items) + Math.floor(Date.now() / 30_000);
  if (U.list.dataset.k === k) return;
  U.list.dataset.k = k;
  const focused = (document.activeElement as HTMLElement | null)?.dataset.id;
  U.list.replaceChildren();
  for (const w of items) {
    const r = el('div', 'wr', U.list);
    el('span', 'ric', r).appendChild(icon(KIND_ICON[w.kind]));
    const main = el('div', 'pm', r);
    el('div', 'pt', main, w.label).title = w.label;
    el('div', 'ps', main, `${w.detail} · ${tr('wSince', dur(Math.max(0, (Date.now() - w.since) / 1000)))}`);
    const b = iconBtn(r, 'x', `${tr('remove')}: ${w.label}`, () => post({ type: 'watchRemove', id: w.id }));
    b.dataset.id = w.id;
    if (focused === w.id) b.focus();
  }
}

export function onWatches(m: OvWatches): void {
  data = m;
  mark('page:watch');
}

export const watchPage: PageDef = {
  id: 'watch',
  seg: 'tools',
  label: 'pWatch',
  build(root) {
    U = build(root);
    onRender('page:watch', render);
  },
  render,
};
