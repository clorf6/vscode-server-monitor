// Dashboard webview. Plain DOM + canvas, no frameworks. The skeleton is built once on `init` and updated in place.
// Every data-derived string goes through textContent (never innerHTML).

import type { CoreMsg, DisksMsg, GpuCard, GpuMsg, HistoryMsg, HostMsg, InitMsg, N, ProcsMsg, Snapshot, StringKey, SysMsg, ViewMsg } from './protocol';
import { ChartData, Drawable, fmtBytes, fmtPct, fmtRate, hideTip, invalidate, LineChart, observe, readTheme, redrawAll, SeriesDef, showTip, view } from './charts';

declare function acquireVsCodeApi(): { postMessage(m: ViewMsg): void; getState(): unknown; setState(s: unknown): void };
const api = acquireVsCodeApi();
const post = (m: ViewMsg) => api.postMessage(m);

let S = {} as Record<StringKey, string>;
function tr(k: StringKey, ...a: (string | number)[]): string {
  return (S[k] || k).replace(/\{(\d+)\}/g, (m, i: string) => (a[+i] === undefined ? m : String(a[+i])));
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: Element, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

function setText(e: Element, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}

const num = (v: N | undefined): number => (v == null ? NaN : v);
const MiB = 1048576;

// ---------------------------------------------------------------- time series buffers

class Buf {
  t: number[] = [];
  s: Record<string, number[]> = {};

  load(snap: Snapshot): void {
    this.t = [];
    let acc = snap.t0;
    snap.dt.forEach((d, i) => this.t.push(i ? (acc += d) : acc));
    this.s = {};
    for (const k of Object.keys(snap.series)) this.s[k] = snap.series[k].map(num);
  }

  push(t: number, v: Record<string, number>): void {
    const n = this.t.length;
    if (n && t <= this.t[n - 1]) return;
    for (const k of Object.keys(v)) if (!this.s[k]) this.s[k] = new Array<number>(n).fill(NaN);
    this.t.push(t);
    for (const k of Object.keys(this.s)) this.s[k].push(v[k] ?? NaN);
    // keep the selected range plus one point beyond its left edge
    let drop = 0;
    while (drop < this.t.length - 1 && this.t[drop + 1] < t - view.range) drop++;
    if (drop) {
      this.t.splice(0, drop);
      for (const k of Object.keys(this.s)) this.s[k].splice(0, drop);
    }
  }

  get(k: string): number[] {
    return this.s[k] ?? [];
  }
}

const core = new Buf();
const gpu = new Buf();

/** Average utilization over all GPUs, for the GPU stat tile sparkline. */
function gpuAvg(): void {
  const keys = Object.keys(gpu.s).filter((k) => k[0] === 'u');
  gpu.s.avg = gpu.t.map((_, i) => {
    let s = 0;
    let c = 0;
    for (const k of keys) {
      const v = gpu.s[k][i];
      if (isFinite(v)) (s += v), c++;
    }
    return c ? s / c : NaN;
  });
}

// ---------------------------------------------------------------- state

let ranges: number[] = [5];
let range = 5;
let gpuAvailable: boolean | null = null;
let lastCore: CoreMsg | undefined;
let lastProcs: ProcsMsg | undefined;
let gpuFilter: number | null = null;
/** pid → full command line (the host sends each one only once). */
let fullCmd = new Map<number, string>();

interface Tile {
  v: HTMLElement;
  s: HTMLElement;
  chart: LineChart;
  pair?: HTMLElement[];
}

interface GpuUi {
  root: HTMLElement;
  head: HTMLButtonElement;
  name: HTMLElement;
  badge: HTMLElement;
  bi: HTMLElement;
  bt: HTMLElement;
  stats: HTMLElement[];
  users: HTMLElement;
  chart: LineChart;
}

// UI references, filled by build()
let U: ReturnType<typeof build> | undefined;
const gpuCards = new Map<number, GpuUi>();
let gpuKey = '';
let cells: HTMLElement[] = [];

// ---------------------------------------------------------------- building blocks

function btn(parent: Element, k: StringKey, cmd: string, cls = 'btn'): HTMLButtonElement {
  const b = el('button', cls, parent, tr(k));
  b.type = 'button';
  b.addEventListener('click', () => post({ type: 'command', id: cmd }));
  return b;
}

function card(parent: Element, title: string, cls = ''): { root: HTMLElement; head: HTMLElement; sub: HTMLElement; body: HTMLElement } {
  const root = el('section', 'card ' + cls, parent);
  const head = el('div', 'ch', root);
  const h = el('h2', '', head, title);
  h.id = 'h' + Math.random().toString(36).slice(2, 8);
  root.setAttribute('aria-labelledby', h.id);
  const sub = el('span', 'sub', head);
  return { root, head, sub, body: root };
}

/** Legend for line charts: a short line key per series. Text stays in text colors. */
function lineLegend(parent: Element, series: SeriesDef[]): HTMLElement {
  const lg = el('div', 'legend', parent);
  for (const s of series) {
    const it = el('span', 'li', lg);
    el('span', `lk k${s.c + 1}`, it);
    el('span', '', it, s.l);
  }
  return lg;
}

function meter(parent: Element): { root: HTMLElement; fill: HTMLElement } {
  const root = el('div', 'meter', parent);
  return { root, fill: el('div', '', root) };
}

function setMeter(m: { root: HTMLElement; fill: HTMLElement }, p: number): void {
  const v = isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
  m.root.className = 'meter ' + (v >= 85 ? 'bad' : v >= 60 ? 'warn' : 'ok');
  m.fill.style.width = v.toFixed(1) + '%';
}

function tile(parent: Element, label: string, kind: 'pct' | 'rate', series: SeriesDef[], get: () => ChartData, pair = false): Tile {
  const root = el('div', 'tile', parent);
  el('div', 'tl', root, label);
  const v = el('div', pair ? 'tv pair' : 'tv', root, '–');
  let pairs: HTMLElement[] | undefined;
  if (pair) {
    v.textContent = '';
    pairs = series.map((s) => {
      const row = el('div', 'pr', v);
      el('span', `lk k${s.c + 1}`, row);
      const b = el('b', '', row, '–');
      el('span', '', row, s.l);
      return b;
    });
  }
  const s = el('div', 'ts', root);
  const chart = new LineChart(root, { series, kind, h: 30, get, label, spark: true });
  return { v, s, chart, pair: pairs };
}

class Table {
  readonly tb: HTMLTableSectionElement;
  private readonly num: boolean[];
  readonly empty: HTMLElement;

  constructor(parent: Element, label: string, cols: [StringKey, boolean][]) {
    const wrap = el('div', 'tw', parent);
    const t = el('table', '', wrap);
    t.setAttribute('aria-label', label);
    const hr = el('tr', '', el('thead', '', t));
    for (const [k, n] of cols) {
      const th = el('th', n ? 'n' : '', hr, tr(k));
      th.scope = 'col';
    }
    this.tb = el('tbody', '', t);
    this.num = cols.map((c) => c[1]);
    this.empty = el('div', 'empty', parent);
    this.empty.hidden = true;
  }

  rows(n: number): HTMLTableRowElement[] {
    while (this.tb.rows.length < n) {
      const row = this.tb.insertRow();
      for (const isNum of this.num) row.insertCell().className = isNum ? 'n' : '';
    }
    while (this.tb.rows.length > n) this.tb.deleteRow(-1);
    return Array.from(this.tb.rows);
  }
}

// ---------------------------------------------------------------- skeleton

function build() {
  const app = document.getElementById('app') ?? el('main', '', document.body);
  app.replaceChildren();
  app.removeAttribute('aria-busy');

  // 1. header
  const hdr = el('header', 'hdr', app);
  const host = el('h1', '', hdr);
  const chips = el('div', 'chips', hdr);

  // 2. one filter row that scopes every chart
  const bar = el('div', 'bar', app);
  bar.setAttribute('role', 'toolbar');
  el('span', 'bl', bar, tr('range'));
  const seg = el('div', 'seg', bar);
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', tr('range'));
  el('span', 'sp', bar);
  const gpuBtns = [btn(bar, 'copyFree', 'serverMonitor.copyFreeGpus'), btn(bar, 'watchFree', 'serverMonitor.watchFreeGpus')];
  btn(bar, 'refresh', 'serverMonitor.refresh');
  btn(bar, 'settings', 'serverMonitor.openSettings');

  // 3. stat tiles
  const tiles = el('section', 'tiles', app);
  const s1 = (l: string): SeriesDef[] => [{ l, c: 0 }];
  const tCpu = tile(tiles, tr('cpu'), 'pct', s1(tr('cpu')), () => ({ t: core.t, ys: [core.get('cpu')] }));
  const tMem = tile(tiles, tr('memory'), 'pct', s1(tr('memory')), () => ({ t: core.t, ys: [core.get('mem')] }));
  const tGpu = tile(tiles, tr('gpusFree'), 'pct', s1(tr('util')), () => ({ t: gpu.t, ys: [gpu.get('avg')] }));
  const netS: SeriesDef[] = [{ l: tr('down'), c: 0 }, { l: tr('up'), c: 1 }];
  const ioS: SeriesDef[] = [{ l: tr('read'), c: 0 }, { l: tr('write'), c: 1 }];
  const tNet = tile(tiles, tr('network'), 'rate', netS, () => ({ t: core.t, ys: [core.get('rx'), core.get('tx')] }), true);
  const tIo = tile(tiles, tr('diskIo'), 'rate', ioS, () => ({ t: core.t, ys: [core.get('dr'), core.get('dw')] }), true);
  const gpuTile = tiles.children[2] as HTMLElement;

  const grid = el('section', 'grid', app);

  // 4. CPU: total line + per-core heatmap
  const cc = card(grid, tr('cpuUsage'));
  const cpuChart = new LineChart(cc.body, { series: s1(tr('cpu')), kind: 'pct', h: 140, get: () => ({ t: core.t, ys: [core.get('cpu')] }), label: tr('cpuUsage') });
  const hh = el('div', 'subh', cc.body);
  el('span', '', hh, tr('perCore'));
  const scale = el('span', 'scale', hh);
  scale.setAttribute('aria-hidden', 'true');
  el('span', '', scale, '0%');
  el('span', 'ramp', scale);
  el('span', '', scale, '100%');
  const heat = el('div', 'heat', cc.body);
  heat.setAttribute('role', 'img');
  const busy = el('div', 'note', cc.body);
  heat.addEventListener('pointermove', (e) => {
    const i = (e.target as HTMLElement).dataset?.i;
    if (i === undefined) return hideTip();
    showTip(e.clientX, e.clientY, '', [{ c: 0, v: fmtPct(lastCore?.cores[+i]), l: tr('core', i) }]);
  });
  heat.addEventListener('pointerleave', hideTip);
  observe(heat, { draw: layoutHeat });

  // 5. memory: stacked bar, swap meter, usage line
  const mc = card(grid, tr('memory'));
  const stack = el('div', 'stack', mc.body);
  stack.setAttribute('role', 'img');
  const segs = ['k1', 'k2', 'kf'].map((k) => el('div', 'sg ' + k, stack));
  const lg = el('div', 'legend', mc.body);
  const memVals = (['used', 'cache', 'free'] as StringKey[]).map((k, i) => {
    const it = el('span', 'li', lg);
    el('span', 'sw ' + ['k1', 'k2', 'kf'][i], it);
    el('span', '', it, tr(k));
    return el('b', '', it, '–');
  });
  const sw = el('div', 'meterrow', mc.body);
  el('span', 'ml', sw, tr('swap'));
  const swapM = meter(sw);
  const swapT = el('span', 'mt', sw);
  el('div', 'subh', mc.body, tr('memUsage'));
  const memChart = new LineChart(mc.body, { series: s1(tr('memory')), kind: 'pct', h: 140, get: () => ({ t: core.t, ys: [core.get('mem')] }), label: tr('memUsage') });

  // 6. network and disk IO
  const nc = card(grid, tr('network'));
  lineLegend(nc.head, netS);
  const netChart = new LineChart(nc.body, { series: netS, kind: 'rate', h: 140, get: () => ({ t: core.t, ys: [core.get('rx'), core.get('tx')] }), label: tr('network') });
  const ic = card(grid, tr('diskIo'));
  lineLegend(ic.head, ioS);
  const ioChart = new LineChart(ic.body, { series: ioS, kind: 'rate', h: 140, get: () => ({ t: core.t, ys: [core.get('dr'), core.get('dw')] }), label: tr('diskIo') });

  // 7. GPU small multiples with one shared legend
  const gsec = el('section', 'gsec', app);
  gsec.hidden = true;
  const gh = el('div', 'gh', gsec);
  el('h2', '', gh, tr('gpus'));
  lineLegend(gh, [{ l: tr('util'), c: 0 }, { l: tr('memUsed'), c: 1 }]);
  el('span', 'hint', gh, tr('filterHint'));
  btn(gh, 'pickGpus', 'serverMonitor.pickGpus');
  const ggrid = el('div', 'ggrid', gsec);

  // 8. tables (also the accessible table view of the charts)
  const tg = el('section', 'tables', app);
  const pc = card(tg, tr('topProcs'), 'wide');
  const chip = el('button', 'fchip', pc.head);
  chip.type = 'button';
  chip.hidden = true;
  chip.title = tr('clearFilter');
  chip.addEventListener('click', () => setFilter(null));
  el('span', 'sp', pc.head);
  btn(pc.head, 'openProcs', 'serverMonitor.processes.focus', 'link');
  const procT = new Table(pc.body, tr('topProcs'), [['pid', true], ['user', false], ['cpuPct', true], ['memory', true], ['gpuMem', true], ['command', false]]);
  const uc = card(tg, tr('users'));
  const userT = new Table(uc.body, tr('users'), [['user', false], ['cpuPct', true], ['memory', true], ['gpus', false], ['gpuMem', true], ['procsCol', true]]);
  const dc = card(tg, tr('disks'));
  const diskT = new Table(dc.body, tr('disks'), [['mount', false], ['fstype', false], ['usage', false], ['usedTotal', true], ['status', false]]);

  return { host, chips, seg, gpuBtns, tCpu, tMem, tGpu, gpuTile, tNet, tIo, cpuLoad: cc.sub, cpuChart, heat, busy, stack, segs, memVals, swapM, swapT, memChart, netChart, ioChart, gsec, ggrid, chip, procNote: pc.sub, procT, userNote: uc.sub, userT, diskT };
}

// ---------------------------------------------------------------- rendering

function renderRanges(): void {
  if (!U) return;
  const seg = U.seg;
  if (seg.childElementCount !== ranges.length) {
    seg.replaceChildren();
    for (const r of ranges) {
      const b = el('button', '', seg, tr('min', r));
      b.type = 'button';
      b.dataset.r = String(r);
      b.addEventListener('click', () => setRange(r));
    }
  }
  for (const b of Array.from(seg.children) as HTMLElement[]) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.r) === range));
    b.textContent = tr('min', b.dataset.r ?? '');
  }
}

function setRange(r: number): void {
  if (r === range) return;
  range = r;
  view.range = r * 60_000;
  try {
    api.setState({ range: r });
  } catch {
    /* state is a convenience */
  }
  renderRanges();
  redrawAll();
  post({ type: 'range', minutes: r });
}

function applySys(s: SysMsg): void {
  if (!U) return;
  setText(U.host, s.hostname);
  const items: [string, string?, string?][] = [[s.conn, 'conn']];
  if (s.os) items.push([s.os]);
  if (s.kernel) items.push([s.kernel]);
  if (s.cpuModel || s.cpuCount) items.push([[s.cpuModel, tr('cores', s.cpuCount)].filter(Boolean).join(' × ')]);
  items.push([tr('ram', fmtBytes(s.memTotal))]);
  items.push([tr('uptime', dur(s.uptime))]);
  if (s.driver) items.push([[tr('driver', s.driver), s.cuda ? tr('cuda', s.cuda) : ''].filter(Boolean).join(' · ')]);
  if (s.users.length) items.push([tr('usersOnline', s.users.length), '', s.users.join(', ')]);
  if (s.cgroupMem != null) items.push([tr('cgMem', fmtBytes(s.cgroupMem))]);
  if (s.cgroupCpus != null) items.push([tr('cgCpu', +s.cgroupCpus.toFixed(2))]);
  U.chips.replaceChildren(
    ...items.map(([text, cls, title]) => {
      const c = el('span', 'chip' + (cls ? ' ' + cls : ''), undefined, text);
      c.title = title || text;
      return c;
    }),
  );
}

function dur(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

function applyHistory(h: HistoryMsg): void {
  range = h.range;
  view.range = h.range * 60_000;
  core.load(h.core);
  gpu.load(h.gpu);
  gpuAvg();
  renderRanges();
  redrawAll();
}

function onCore(c: CoreMsg): void {
  if (!U) return;
  lastCore = c;
  core.push(c.t, { cpu: num(c.cpu), mem: num(c.mem.percent), rx: num(c.rx), tx: num(c.tx), dr: num(c.dr), dw: num(c.dw) });
  const m = c.mem;
  setText(U.tCpu.v, fmtPct(c.cpu));
  setText(U.tCpu.s, tr('load', c.load[0]?.toFixed(2) ?? '–'));
  setText(U.cpuLoad, tr('loadAvg', c.load.map((x) => x.toFixed(2)).join(' / ')));
  setText(U.tMem.v, fmtPct(m.percent));
  setText(U.tMem.s, tr('usedOfTotal', fmtBytes(m.used), fmtBytes(m.total)));
  const [rx, tx] = U.tNet.pair!;
  setText(rx, fmtRate(c.rx));
  setText(tx, fmtRate(c.tx));
  const [dr, dw] = U.tIo.pair!;
  setText(dr, fmtRate(c.dr));
  setText(dw, fmtRate(c.dw));

  // memory: used | cache | free, separated by 2px surface gaps
  // used = total - available; split the available part into never-used (MemFree) and reclaimable cache
  const free = Math.max(0, Math.min(m.free, m.total - m.used));
  const cache = Math.max(0, m.total - m.used - free);
  [m.used, cache, free].forEach((v, i) => {
    U!.segs[i].style.flexGrow = String(v);
    U!.segs[i].hidden = !(v > 0);
    setText(U!.memVals[i], fmtBytes(v));
  });
  U.stack.setAttribute('aria-label', `${tr('used')} ${fmtBytes(m.used)}, ${tr('cache')} ${fmtBytes(cache)}, ${tr('free')} ${fmtBytes(free)}`);
  U.swapM.root.hidden = !m.swapTotal;
  if (m.swapTotal) {
    const p = (m.swapUsed / m.swapTotal) * 100;
    setMeter(U.swapM, p);
    setText(U.swapT, `${fmtBytes(m.swapUsed)} / ${fmtBytes(m.swapTotal)} · ${fmtPct(p)}`);
  } else setText(U.swapT, tr('noSwap'));

  renderHeat(c.cores);
  for (const ch of [U.tCpu.chart, U.tMem.chart, U.tNet.chart, U.tIo.chart, U.cpuChart, U.memChart, U.netChart, U.ioChart]) invalidate(ch);
}

/** Pick a column count that divides the core count evenly (96 → 16/24/32/48) so the grid has no ragged last row. */
function layoutHeat(): void {
  if (!U || !cells.length) return;
  const n = cells.length;
  const maxCols = Math.max(1, Math.floor((U.heat.clientWidth + 2) / 14));
  let cols = Math.min(n, maxCols);
  for (let c = cols; c >= 1; c--) {
    if (n % c === 0) {
      if (c >= cols / 2) cols = c;
      break;
    }
  }
  const v = `repeat(${cols}, minmax(0, 1fr))`;
  if (U.heat.style.gridTemplateColumns !== v) U.heat.style.gridTemplateColumns = v;
}

function renderHeat(cores: N[]): void {
  if (!U) return;
  if (cells.length !== cores.length) {
    U.heat.replaceChildren();
    cells = cores.map((_, i) => {
      const d = el('div', 'cell', U!.heat);
      d.dataset.i = String(i);
      return d;
    });
    layoutHeat();
  }
  let sum = 0;
  let cnt = 0;
  let max = 0;
  cores.forEach((v, i) => {
    const u = v == null ? 0 : Math.max(0, Math.min(100, v));
    cells[i].style.setProperty('--u', (u / 100).toFixed(2));
    if (v != null) (sum += v), cnt++, (max = Math.max(max, v));
  });
  const top = cores
    .map((v, i) => [num(v), i] as const)
    .filter(([v]) => v > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 3);
  setText(U.busy, top.length ? tr('busiest', top.map(([v, i]) => `#${i} ${fmtPct(v)}`).join(' · ')) : '');
  U.heat.setAttribute('aria-label', tr('heatAria', cores.length, fmtPct(cnt ? sum / cnt : NaN), fmtPct(max)));
}

function onGpu(g: GpuMsg): void {
  if (!U) return;
  const v: Record<string, number> = {};
  let sum = 0;
  let cnt = 0;
  for (const x of g.gpus) {
    v['u' + x.i] = num(x.util);
    v['m' + x.i] = x.memTotal ? num(x.memUsed) / x.memTotal * 100 : NaN;
    if (x.util != null) (sum += x.util), cnt++;
  }
  v.avg = cnt ? sum / cnt : NaN;
  gpu.push(g.t, v);

  const has = g.gpus.length > 0;
  U.gsec.hidden = !has;
  U.gpuTile.hidden = !has;
  for (const b of U.gpuBtns) b.hidden = !has;
  if (!has) return;
  const free = g.gpus.filter((x) => x.free).length;
  setText(U.tGpu.v, `${free}/${g.gpus.length}`);
  setText(U.tGpu.s, tr('avgUtil', fmtPct(v.avg)));
  invalidate(U.tGpu.chart);

  const key = g.gpus.map((x) => x.i).join(',');
  if (key !== gpuKey) {
    gpuKey = key;
    for (const c of gpuCards.values()) c.chart.destroy();
    gpuCards.clear();
    U.ggrid.replaceChildren();
    for (const x of g.gpus) gpuCards.set(x.i, gpuCard(U.ggrid, x.i));
    if (gpuFilter !== null && !gpuCards.has(gpuFilter)) setFilter(null);
    else markFilter();
  }
  for (const x of g.gpus) updateGpuCard(gpuCards.get(x.i)!, x);
}

function gpuCard(parent: Element, i: number): GpuUi {
  const root = el('div', 'card gcard', parent);
  const head = el('button', 'gb', root);
  head.type = 'button';
  const name = el('span', 'gn', head);
  const badge = el('span', 'badge', head);
  const bi = el('span', 'bi', badge);
  bi.setAttribute('aria-hidden', 'true');
  const bt = el('span', '', badge);
  root.addEventListener('click', () => setFilter(gpuFilter === i ? null : i));
  const series: SeriesDef[] = [{ l: tr('util'), c: 0 }, { l: tr('memUsed'), c: 1 }];
  const chart = new LineChart(root, { series, kind: 'pct', h: 96, get: () => ({ t: gpu.t, ys: [gpu.get('u' + i), gpu.get('m' + i)] }), label: `GPU ${i}` });
  const sg = el('div', 'gs', root);
  const stats = (['util', 'memory', 'temp', 'power'] as StringKey[]).map((k) => {
    const d = el('div', '', sg);
    el('span', '', d, tr(k));
    return el('b', '', d, '–');
  });
  const users = el('div', 'gu', root);
  return { root, head, name, badge, bi, bt, stats, users, chart };
}

function updateGpuCard(c: GpuUi, x: GpuCard): void {
  setText(c.name, `GPU ${x.i} · ${x.name}`);
  c.name.title = x.name;
  c.badge.className = 'badge ' + (x.free ? 'ok' : 'busy');
  setText(c.bi, x.free ? '✓' : '●');
  setText(c.bt, tr(x.free ? 'free' : 'inUse'));
  const [u, m, t, p] = c.stats;
  setText(u, fmtPct(x.util));
  setText(m, `${fmtBytes(num(x.memUsed) * MiB)} / ${fmtBytes(num(x.memTotal) * MiB)}`);
  setText(t, x.temp == null ? '–' : `${x.temp} °C`);
  setText(p, x.power == null ? '–' : x.powerLimit == null ? `${x.power} W` : `${x.power} / ${x.powerLimit} W`);
  const us = x.users.length ? tr('gpuUsers', x.users.join(', ')) : tr('noGpuProcs');
  setText(c.users, us);
  c.users.title = us;
  invalidate(c.chart);
}

function setFilter(i: number | null): void {
  gpuFilter = i;
  markFilter();
  renderProcs();
}

function markFilter(): void {
  for (const [i, c] of gpuCards) {
    c.root.classList.toggle('sel', i === gpuFilter);
    c.head.setAttribute('aria-pressed', String(i === gpuFilter));
  }
  if (!U) return;
  U.chip.hidden = gpuFilter === null;
  if (gpuFilter !== null) setText(U.chip, `${tr('onlyGpu', gpuFilter)}  ✕`);
}

const pctCell = (v: N) => (v == null ? '–' : fmtPct(v, Math.abs(v) < 10 ? 1 : 0));

function renderProcs(): void {
  const p = lastProcs;
  if (!U || !p) return;
  const f = gpuFilter;
  const gmem = (r: { gpu: [number, number][] }) => r.gpu.reduce((s, [i, m]) => s + (f === null || i === f ? m : 0), 0);
  const rows = f === null ? p.procs : p.procs.filter((r) => r.gpu.some(([i]) => i === f)).sort((a, b) => gmem(b) - gmem(a));
  const trs = U.procT.rows(rows.length);
  rows.forEach((r, k) => {
    const c = trs[k].cells;
    trs[k].className = r.me ? 'me' : '';
    setText(c[0], String(r.pid));
    setText(c[1], r.user);
    setText(c[2], pctCell(r.cpu));
    setText(c[3], fmtBytes(r.rss));
    const gi = r.gpu.filter(([i]) => f === null || i === f).map(([i]) => i);
    setText(c[4], gi.length ? `${fmtBytes(gmem(r) * MiB)} (GPU ${gi.join(',')})` : '–');
    setText(c[5], r.cmd);
    c[5].className = 'cmd';
    const full = fullCmd.get(r.pid) ?? r.cmd;
    if (c[5].title !== full) c[5].title = full;
  });
  U.procT.empty.hidden = rows.length > 0;
  setText(U.procT.empty, !p.supported ? tr('noProcSupport') : f !== null ? tr('noProcsOnGpu', f) : tr('waiting'));
  setText(U.procNote, !p.supported ? '' : p.scope === 'mine' ? tr('scanning') : tr('totalProcs', p.total));
  setText(U.userNote, p.scope === 'mine' && p.supported ? tr('scanning') : '');

  const urs = U.userT.rows(p.users.length);
  p.users.forEach((u, k) => {
    const c = urs[k].cells;
    urs[k].className = u.me ? 'me' : '';
    setText(c[0], u.me ? tr('you', u.name) : u.name);
    setText(c[1], pctCell(u.cpu));
    setText(c[2], fmtBytes(u.rss));
    setText(c[3], u.gpus.length ? u.gpus.join(', ') : '–');
    setText(c[4], u.gpuMem ? fmtBytes(u.gpuMem * MiB) : '–');
    setText(c[5], String(u.procs));
  });
  U.userT.empty.hidden = p.users.length > 0;
  setText(U.userT.empty, p.supported ? tr('waiting') : tr('noProcSupport'));
}

const STATUS: Record<string, [StringKey, string, string]> = {
  ok: ['ok', 'ok', '✓'],
  timeout: ['timeout', 'bad', '⚠'],
  error: ['error', 'bad', '✕'],
  pending: ['pending', 'mut', '◌'],
};

function renderDisks(d: DisksMsg): void {
  if (!U) return;
  const trs = U.diskT.rows(d.mounts.length);
  d.mounts.forEach((r, k) => {
    const c = trs[k].cells;
    if (!c[0].firstChild) {
      el('span', '', c[0]);
      el('span', 'tag', c[0]);
      const um = el('div', 'um', c[2]);
      meter(um);
      el('span', '', um);
      el('span', 'si', c[4]).setAttribute('aria-hidden', 'true');
      el('span', '', c[4]);
    }
    const [mn, tag] = Array.from(c[0].children) as HTMLElement[];
    setText(mn, r.mount);
    c[0].title = r.device;
    const tags = [r.home ? tr('home') : '', r.network ? tr('network') : ''].filter(Boolean).join(' · ');
    setText(tag, tags);
    tag.hidden = !tags;
    setText(c[1], r.fstype);
    const um = c[2].firstElementChild as HTMLElement;
    const m = { root: um.children[0] as HTMLElement, fill: um.children[0].firstElementChild as HTMLElement };
    m.root.hidden = r.percent == null;
    if (r.percent != null) setMeter(m, r.percent);
    setText(um.children[1], fmtPct(r.percent));
    setText(c[3], r.total == null ? '–' : `${fmtBytes(r.used)} / ${fmtBytes(r.total)}`);
    const [key, cls, icon] = STATUS[r.status] ?? STATUS.error;
    c[4].className = 'st ' + cls;
    setText(c[4].children[0], icon);
    setText(c[4].children[1], tr(key));
  });
  U.diskT.empty.hidden = d.mounts.length > 0;
  setText(U.diskT.empty, tr('noDisks'));
}

// ---------------------------------------------------------------- messages

function onInit(m: InitMsg): void {
  S = m.strings;
  ranges = m.ranges;
  gpuAvailable = m.gpuAvailable;
  if (!U) {
    U = build();
    U.gsec.hidden = U.gpuTile.hidden = true;
    for (const b of U.gpuBtns) b.hidden = true;
  }
  applySys(m.sys);
  applyHistory(m.history);
  if (m.core) onCore(m.core);
  if (m.gpu) onGpu(m.gpu);
  if (m.procs) onProcs(m.procs);
  if (m.disks) renderDisks(m.disks);
  if (gpuAvailable === false) U.gsec.hidden = U.gpuTile.hidden = true;
}

function onProcs(p: ProcsMsg): void {
  const next = new Map<number, string>();
  for (const r of p.procs) {
    const f = r.full ?? fullCmd.get(r.pid);
    if (f !== undefined) next.set(r.pid, f);
  }
  fullCmd = next;
  lastProcs = p;
  renderProcs();
}

window.addEventListener('message', (e: MessageEvent) => {
  const m = e.data as HostMsg | undefined;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') return onInit(m);
  if (!U) return;
  switch (m.type) {
    case 'core':
      return onCore(m);
    case 'gpu':
      return onGpu(m);
    case 'procs':
      return onProcs(m);
    case 'disks':
      return renderDisks(m);
    case 'sys':
      return applySys(m);
    case 'history':
      return applyHistory(m);
  }
});

// theme changes: VS Code swaps the body class and rewrites the --vscode-* variables on <html>
const retheme: Drawable = {
  draw() {
    readTheme();
    redrawAll();
  },
};
const mo = new MutationObserver(() => invalidate(retheme));
mo.observe(document.body, { attributes: true, attributeFilter: ['class'] });
mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

// moving between monitors changes devicePixelRatio without resizing anything
const watchDpr = (): void =>
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      redrawAll();
      watchDpr();
    },
    { once: true },
  );
watchDpr();

readTheme();
const saved = api.getState() as { range?: unknown } | undefined;
if (typeof saved?.range === 'number') view.range = saved.range * 60_000;
post({ type: 'ready' });
