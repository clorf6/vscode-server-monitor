// 工具 › 常用: tool tiles and the user's quick commands.

import type { OvKey } from '../overview-protocol';
import { button, cmd, el, G, iconBtn, IconName, nav, onRender, PageDef, post, tr } from './core';

let U: ReturnType<typeof build> | undefined;

function build(p: HTMLElement) {
  const tiles = el('div', 'tiles', p);
  const tile = (ic: IconName, k: OvKey, run: () => void) => button(tiles, 'tile', tr(k), run, ic);
  tile('dash', 'dashboard', () => cmd('serverMonitor.openDashboard'));
  tile('spark', 'freeUp', () => cmd('serverMonitor.freeUp'));
  const gpuTiles = [tile('chip', 'pickGpus', () => cmd('serverMonitor.pickGpus')), tile('bell', 'watchFree', () => cmd('serverMonitor.watchFreeGpus'))];
  tile('term', 'newTmux', () => cmd('serverMonitor.tmux.new'));
  tile('folder', 'du', () => nav.go('du'));
  tile('refresh', 'refresh', () => cmd('serverMonitor.refresh'));
  tile('gear', 'settings', () => cmd('serverMonitor.openSettings'));
  const qh = el('div', 'sh', p);
  el('h2', '', qh, tr('quick'));
  el('span', 'sp', qh);
  button(qh, 'link', tr('add'), () => cmd('serverMonitor.quickCommands.add'), 'plus');
  const ql = el('div', 'list ql', p);
  return { gpuTiles, ql };
}

function render(): void {
  if (!U) return;
  for (const t of U.gpuTiles) t.hidden = G.gpuNone;
  const key = JSON.stringify(G.cfg.quick);
  if (U.ql.dataset.k === key) return;
  U.ql.dataset.k = key;
  U.ql.replaceChildren();
  if (!G.cfg.quick.length) el('div', 'qe', U.ql, tr('noQuick'));
  G.cfg.quick.forEach((q, index) => {
    const r = el('div', 'qr', U!.ql);
    iconBtn(r, 'play', `${tr('run')}: ${q.command}`, () => post({ type: 'quickRun', index, command: q.command }), 'ib run');
    const tx = el('div', 'qt', r);
    tx.title = q.command;
    el('div', 'qn', tx, q.name);
    el('code', 'qc', tx, q.command);
    iconBtn(r, 'x', `${tr('remove')}: ${q.name}`, () => post({ type: 'quickRemove', index, command: q.command }));
  });
}

export const toolsPage: PageDef = {
  id: 'tools',
  seg: 'tools',
  label: 'pTools',
  build(root) {
    U = build(root);
    onRender('page:tools', render);
  },
  render,
};
