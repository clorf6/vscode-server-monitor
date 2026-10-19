// 算力 › GPU: one card per GPU with utilization / memory meters and users; select GPUs to copy or export
// CUDA_VISIBLE_DEVICES (default: every free GPU).

import type { OvGpuRow, OvKey } from '../overview-protocol';
import { fmtPct } from '../charts';
import { Bar, bar, button, clickable, cmd, dur, el, emptyBox, flash, flush, G, icon, mark, num, onRender, PageDef, post, save, setBar, setEmpty, setText, setTitle, st, tr } from './core';

const gib = (mib: number | null) => (mib == null ? '–' : (mib / 1024).toFixed(mib >= 102400 ? 0 : 1));

interface GpuRowUi {
  root: HTMLElement;
  model: HTMLElement;
  badge: HTMLElement;
  bt: HTMLElement;
  ub: Bar;
  uv: HTMLElement;
  mb: Bar;
  mv: HTMLElement;
  meta: HTMLElement;
  users: HTMLElement;
  /** Slowdowns, ECC errors, a degraded link, idle-but-held. */
  tags: HTMLElement;
}
const rows = new Map<number, GpuRowUi>();
let key = '';
let U: ReturnType<typeof build> | undefined;
const sel = () => new Set(st.sel);

function toggle(i: number): void {
  const s = sel();
  if (s.has(i)) s.delete(i);
  else s.add(i);
  st.sel = [...s];
  save();
  mark('page:gpu');
}

function build(p: HTMLElement) {
  const empty = emptyBox(p, 'chip');
  const box = el('div', 'gbox', p);
  const sum = el('div', 'gsum', box);
  const target = el('div', 'gtarget', sum);
  const clear = button(sum, 'link', tr('clear'), () => {
    st.sel = [];
    save();
    mark('page:gpu');
  });
  const act = el('div', 'gact', box);
  const bCopy = button(act, 'btn', tr('copyCuda'), () => send('copyGpus'), 'copy');
  const bExport = button(act, 'btn', tr('exportCuda'), () => send('exportGpus'), 'term');
  const links = el('div', 'glinks', box);
  const bWatch = button(links, 'link', tr('notifyFree'), () => cmd('serverMonitor.watchFreeGpus'), 'bell');
  button(links, 'link', tr('openDash'), () => cmd('serverMonitor.openDashboard'), 'dash');
  const list = el('div', 'glist', box);
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', tr('gpu'));
  return { empty, box, target, clear, bCopy, bExport, bWatch, list };
}

function gpuRow(parent: Element, i: number): GpuRowUi {
  const root = el('div', 'gr', parent);
  clickable(root, () => toggle(i));
  root.setAttribute('role', 'checkbox');
  const h = el('div', 'g1', root);
  el('span', 'cbx', h).appendChild(icon('check'));
  el('b', 'gname', h, `GPU ${i}`);
  const model = el('span', 'gmodel', h);
  const badge = el('span', 'badge', h);
  const bt = el('span', '', badge);
  const meters = el('div', 'g2', root);
  const meter = (k: OvKey) => {
    const w = el('div', 'gm', meters);
    el('span', 'gl', w, tr(k));
    const b = bar(w);
    return { b, v: el('span', 'gv', w) };
  };
  const u = meter('util');
  const m = meter('vram');
  const g3 = el('div', 'g3', root);
  const meta = el('span', 'gmeta', g3);
  const users = el('span', 'users', g3);
  const tags = el('div', 'g4', root);
  return { root, model, badge, bt, ub: u.b, uv: u.v, mb: m.b, mv: m.v, meta, users, tags };
}

function update(r: GpuRowUi, x: OvGpuRow, selected: boolean): void {
  setText(r.model, x.name);
  setTitle(r.model, x.name);
  const bc = 'badge ' + (x.free ? 'ok' : 'busy');
  if (r.badge.className !== bc) {
    r.badge.className = bc;
    if (r.badge.firstChild !== r.bt) r.badge.firstChild?.remove();
    if (x.free) r.badge.insertBefore(icon('check'), r.bt);
  }
  setText(r.bt, x.free ? tr('free') : tr('inUse'));
  setBar(r.ub, num(x.util));
  setText(r.uv, fmtPct(x.util));
  const mp = x.memTotal ? (num(x.memUsed) / x.memTotal) * 100 : NaN;
  setBar(r.mb, mp, fmtPct(mp));
  setText(r.mv, `${gib(x.memUsed)}/${gib(x.memTotal)} GB`);
  const pc = x.pcie;
  const meta = [
    x.temp == null ? '' : `${x.temp}°C`,
    x.power == null ? '' : x.powerLimit == null ? `${x.power} W` : `${x.power}/${x.powerLimit} W`,
    x.sm == null || x.smMax == null ? '' : tr('clock', x.sm, x.smMax),
    pc?.gen == null || pc.width == null ? '' : tr('pcie', pc.gen, pc.width),
  ]
    .filter(Boolean)
    .join(' · ');
  setText(r.meta, meta);
  // health and waste, as tags: [text, class, tooltip]
  const tags: [string, string, string][] = [];
  if (x.ecc != null && x.ecc > 0) tags.push([tr('ecc', x.ecc), 'crit', '']);
  if (pc?.width != null && pc.widthMax != null && pc.width < pc.widthMax) tags.push([tr('pcieDown', pc.width, pc.widthMax), 'warn', '']);
  for (const w of x.slow) tags.push([tr(w === 'power' ? 'slowPower' : w === 'thermal' ? 'slowThermal' : 'slowHw'), w === 'power' ? '' : 'warn', tr('slowTip')]);
  if (x.idle) tags.push([tr('idleHeld', dur((Date.now() - x.idle.since) / 1000), `${gib(x.idle.held)} GB`), x.idle.flagged ? 'warn' : '', tr('idleHeldTip')]);
  const tk = JSON.stringify(tags);
  if (r.tags.dataset.k !== tk) {
    r.tags.dataset.k = tk;
    r.tags.replaceChildren(
      ...tags.map(([text, cls, tip]) => {
        const t = el('span', 'tag ' + cls, undefined, text);
        if (tip) t.title = tip;
        return t;
      }),
    );
  }
  const k = x.users.join(',');
  if (r.users.dataset.k !== k) {
    r.users.dataset.k = k;
    r.users.replaceChildren(
      ...x.users.map((u) => {
        const c = el('span', u === G.me ? 'uc me' : 'uc', undefined, u);
        if (u === G.me) c.title = tr('you', u);
        return c;
      }),
    );
  }
  r.root.classList.toggle('sel', selected);
  r.root.setAttribute('aria-checked', String(selected));
  r.root.setAttribute('aria-label', `GPU ${x.i} ${x.name} · ${x.free ? tr('free') : tr('inUse')}`);
}

/** The GPUs an action applies to: the selection, or every free GPU when nothing is selected. */
function targets(): number[] {
  const gpus = G.gpus ?? [];
  const known = new Set(gpus.map((g) => g.i));
  const s = st.sel.filter((i) => known.has(i)).sort((a, b) => a - b);
  return s.length ? s : gpus.filter((g) => g.free).map((g) => g.i);
}

function send(type: 'copyGpus' | 'exportGpus'): void {
  const indexes = targets();
  if (indexes.length) post({ type, indexes });
}

function render(): void {
  if (!U) return;
  const g = G.gpus ?? [];
  const none = !g.length;
  setEmpty(U.empty, none, G.gpuNone ? tr('noGpuTitle') : tr('waiting'), G.gpuNone ? tr('noGpuHint') : '');
  U.box.hidden = none;
  if (none) return;
  const k = g.map((x) => x.i).join(',');
  if (k !== key) {
    key = k;
    rows.clear();
    U.list.replaceChildren();
    for (const x of g) rows.set(x.i, gpuRow(U.list, x.i));
    const keep = st.sel.filter((i) => rows.has(i));
    if (keep.length !== st.sel.length) (st.sel = keep), save();
  }
  const s = sel();
  for (const x of g) update(rows.get(x.i)!, x, s.has(x.i));

  const ids = targets();
  const list = ids.join(',');
  setText(U.target, s.size ? tr('selected', list) : ids.length ? tr('freeSel', list) : tr('noneFree'));
  U.clear.hidden = !s.size;
  U.bCopy.disabled = U.bExport.disabled = !ids.length;
  const cmdText = ids.length ? `CUDA_VISIBLE_DEVICES=${list}` : '';
  setTitle(U.bCopy, cmdText);
  setTitle(U.bExport, cmdText && 'export ' + cmdText);
  U.bWatch.classList.toggle('on', G.watchGpu > 0);
  setText(U.bWatch.lastElementChild!, G.watchGpu ? tr('watching', G.watchGpu) : tr('notifyFree'));
}

export const gpuPage: PageDef = {
  id: 'gpu',
  seg: 'gpu',
  label: 'pGpu',
  build(root) {
    U = build(root);
    onRender('page:gpu', render);
  },
  render,
  show(arg) {
    const index = (arg as { index?: number } | undefined)?.index;
    if (typeof index !== 'number') return;
    render();
    flush();
    const r = rows.get(index)?.root;
    if (r) flash(r);
  },
};
