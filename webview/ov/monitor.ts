// 监控 › 概览: attention cards, stat cards with sparklines, the mood cat and the free-up button.

import type { Attn, Locate, N, OvCore, OvDisk, OvGpu, OvHist, OvKey } from '../overview-protocol';

import { ChartData, fmtBytes, fmtPct, fmtRate, invalidate, LineChart, SeriesDef, view } from '../charts';
import { cat, Mood } from '../overview-art';
import { Bar, bar, big, button, clickable, cmd, dur, el, G, icon, iconBtn, mark, nav, num, onRender, PageDef, save, setBar, setText, setTitle, st, tr } from './core';

const SPARK_MS = 120_000;
view.range = SPARK_MS;

// ---------------------------------------------------------------- sparkline buffers

/** Time series with a shared time axis, trimmed to the sparkline window. */
class Buf {
  t: number[] = [];
  s: number[][];

  constructor(n: number) {
    this.s = Array.from({ length: n }, () => []);
  }

  load(t0: number, dt: number[], cols: N[][]): void {
    let acc = t0;
    this.t = dt.map((d, i) => (i ? (acc += d) : acc));
    this.s = cols.map((c) => c.map(num));
  }

  push(t: number, v: number[]): void {
    const n = this.t.length;
    if (n && t <= this.t[n - 1]) return;
    this.t.push(t);
    this.s.forEach((s, i) => s.push(v[i]));
    let drop = 0;
    while (drop < this.t.length - 1 && this.t[drop + 1] < t - SPARK_MS) drop++;
    if (drop) {
      this.t.splice(0, drop);
      for (const s of this.s) s.splice(0, drop);
    }
  }

  get(...i: number[]): ChartData {
    return { t: this.t, ys: i.map((k) => this.s[k]) };
  }
}

const cb = new Buf(5); // cpu, mem, rx, tx, busiest disk's busy %
const gb = new Buf(1); // average GPU utilization

let disk: OvDisk['home'] | undefined;
let expanded = false;
let mood: Mood = 'calm';
let moodNext: Mood | undefined;

export function onHist(h: OvHist): void {
  cb.load(h.t0, h.dt, [h.cpu, h.mem, h.rx, h.tx, h.io ?? []]);
  gb.load(h.g.t0, h.g.dt, [h.g.u]);
  mark('page:ov');
}

export function onCore(c: OvCore): void {
  G.core = c;
  cb.push(c.t, [num(c.cpu), num(c.mem.percent), num(c.rx), num(c.tx), num(c.disks[0]?.util)]);
  mark('page:ov', 'page:disk');
}

export function onGpu(g: OvGpu): void {
  if (g.none) G.gpuNone = true;
  if (g.gpus.length) G.gpuNone = false;
  G.gpus = g.gpus;
  let s = 0;
  let n = 0;
  for (const x of g.gpus) if (x.util != null) (s += x.util), n++;
  if (n) gb.push(g.t, [s / n]);
  mark('page:ov', 'page:gpu', 'page:tools', 'page:watch');
}

export function onDisk(d: OvDisk): void {
  disk = d.home;
  mark('page:ov');
}

/** Attention cards that are not dismissed (the 监控 badge counts these). */
export function visibleAttn(): Attn[] {
  return G.attn.filter((a) => !st.dis.includes(a.id));
}

export function onAttn(items: Attn[]): void {
  G.attn = items;
  // a condition that cleared may alert again later
  const ids = new Set(items.map((a) => a.id));
  const keep = st.dis.filter((id) => ids.has(id));
  if (keep.length !== st.dis.length) {
    st.dis = keep;
    save();
  }
  mark('page:ov', 'nav');
}

/** Where an attention card's "Locate" goes: a page of this panel. */
export function locate(l: Locate): void {
  if (l.kind === 'proc') nav.go('proc', { q: String(l.pid), scope: 'mine' });
  else if (l.kind === 'mem') nav.go('proc', { q: '', sort: 'mem' });
  else if (l.kind === 'cpu') nav.go('proc', { q: '', sort: 'cpu' });
  else if (l.kind === 'disk') nav.go('disk', { mount: l.mount });
  else nav.go('gpu', { index: l.index });
}

// ---------------------------------------------------------------- building blocks

interface Card {
  root: HTMLElement;
  v: HTMLElement;
  s: HTMLElement;
  /** Second detail line. */
  s2: HTMLElement;
  /** Stall-pressure chip on the label row. */
  stall?: HTMLElement;
  bar?: Bar;
  chart?: LineChart;
}

function statCard(parent: Element, label: string, tip: string, onClick: () => void, o: { bar?: boolean; spark?: () => ChartData; series?: SeriesDef[]; rate?: boolean; pair?: boolean; stall?: boolean } = {}): Card {
  const root = el('div', 'sc', parent);
  clickable(root, onClick);
  root.title = tip;
  const sl = el('div', 'sl', root);
  el('span', 'slt', sl, label);
  const v = el('div', o.pair ? 'sv pair' : 'sv', root, '–');
  const s = el('div', 'ss', root);
  const s2 = el('div', 'ss s2', root);
  const c: Card = { root, v, s, s2 };
  if (o.stall) c.stall = el('span', 'stall', sl);
  const foot = el('div', 'sf', root);
  if (o.bar) c.bar = bar(foot);
  if (o.spark) c.chart = new LineChart(foot, { series: o.series ?? [{ l: label, c: 0 }], kind: o.rate ? 'rate' : 'pct', h: 24, get: o.spark, label, spark: true });
  return c;
}

const fmtLoad = (v: number) => v.toFixed(v >= 100 ? 0 : 1);

let U: ReturnType<typeof build> | undefined;

function build(p: HTMLElement) {
  // attention cards
  const at = el('section', 'attn', p);
  at.setAttribute('aria-live', 'polite');
  const amore = button(at, 'amore', '', () => {
    expanded = !expanded;
    mark('page:ov');
  });

  const cards = el('div', 'cards', p);
  const cCpu = statCard(cards, tr('cpu'), tr('openProcs'), () => nav.go('proc', { sort: 'cpu' }), { bar: true, spark: () => cb.get(0), stall: true });
  const cMem = statCard(cards, tr('mem'), tr('showMem'), () => nav.go('proc', { q: '', sort: 'mem' }), { bar: true, spark: () => cb.get(1), stall: true });
  const cGpu = statCard(cards, tr('gpu'), tr('showGpus'), () => nav.go('gpu'), { bar: true, spark: () => gb.get(0) });
  const cDisk = statCard(cards, tr('disk'), tr('showDisks'), () => nav.go('disk', { mount: disk?.mount }), { bar: true });
  const diskM = el('div', 'ss', cDisk.root);
  cDisk.root.insertBefore(diskM, cDisk.s.nextSibling);
  const cIo = statCard(cards, tr('io'), tr('ioTip'), () => nav.go('disk', { mount: G.core?.disks[0]?.mounts[0] }), { bar: true, spark: () => cb.get(4), stall: true });
  const netS: SeriesDef[] = [
    { l: tr('down'), c: 0 },
    { l: tr('up'), c: 1 },
  ];
  const cNet = statCard(cards, tr('net'), tr('openDash'), () => cmd('serverMonitor.openDashboard'), { spark: () => cb.get(2, 3), series: netS, rate: true, pair: true });
  cNet.v.textContent = '';
  const netV = netS.map((s, i) => {
    const r = el('div', 'pr', cNet.v);
    r.title = s.l;
    el('span', `lk k${s.c + 1}`, r);
    el('span', 'ar', r, i ? '↑' : '↓');
    return el('b', '', r, '–');
  });
  const cUp = statCard(cards, tr('uptimeL'), tr('openDash'), () => cmd('serverMonitor.openDashboard'));
  cUp.root.classList.add('wide');
  const upOs = el('div', 'ss', cUp.root);
  cUp.root.insertBefore(upOs, cUp.s.nextSibling);

  const moodEl = el('div', 'mood', p);
  moodEl.dataset.mood = mood;
  moodEl.appendChild(cat());
  const mt = el('div', 'mt', moodEl);
  el('div', 'mn', mt, tr('cat'));
  const ms = el('div', 'ms', mt);

  const fu = el('div', 'fu', p);
  button(fu, 'primary', tr('freeUp'), () => cmd('serverMonitor.freeUp'), 'spark');
  el('div', 'note', fu, tr('freeUpNote'));

  return { at, amore, cCpu, cMem, cGpu, cDisk, diskM, cIo, cNet, netV, cUp, upOs, moodEl, ms };
}

// ---------------------------------------------------------------- attention

interface ACard {
  root: HTMLElement;
  ic: HTMLElement;
  t1: HTMLElement;
  t2: HTMLElement;
  a?: Attn;
}
const acards = new Map<string, ACard>();

function attnCard(): ACard {
  const root = el('div', 'ac');
  const ic = el('span', 'aic', root);
  const tx = el('div', 'atx', root);
  const t1 = el('div', 't1', tx);
  const t2 = el('div', 't2', tx);
  const c: ACard = { root, ic, t1, t2 };
  const loc = button(root, 'loc', tr('locate'), () => c.a && locate(c.a.loc), 'chev');
  loc.title = tr('locate');
  loc.insertBefore(loc.lastChild!, loc.firstChild); // text, then chevron
  iconBtn(root, 'x', tr('dismiss'), () => {
    if (!c.a) return;
    st.dis.push(c.a.id);
    save();
    mark('page:ov', 'nav');
  });
  return c;
}

function renderAttn(): void {
  if (!U) return;
  const vis = visibleAttn();
  const shown = expanded ? vis : vis.slice(0, 3);
  const keep = new Set(shown.map((a) => a.id));
  for (const [id, c] of acards) if (!keep.has(id)) (c.root.remove(), acards.delete(id));
  shown.forEach((a, i) => {
    let c = acards.get(a.id);
    if (!c) acards.set(a.id, (c = attnCard()));
    if (c.a?.sev !== a.sev) {
      c.root.className = 'ac ' + a.sev;
      c.ic.replaceChildren(icon(a.sev === 'crit' ? 'crit' : 'warn'));
    }
    c.a = a;
    setText(c.t1, a.title);
    setText(c.t2, a.detail);
    c.t2.hidden = !a.detail;
    setTitle(c.root, a.detail ? `${a.title}\n${a.detail}` : a.title);
    if (U!.at.children[i] !== c.root) U!.at.insertBefore(c.root, U!.at.children[i]);
  });
  U.amore.hidden = vis.length <= 3;
  setText(U.amore, expanded ? tr('less') : tr('more', vis.length - shown.length));
  U.at.hidden = !vis.length;
}

// ---------------------------------------------------------------- render

function render(): void {
  if (!U) return;
  renderAttn();
  const c = G.core;
  if (c) {
    big(U.cCpu.v, fmtPct(c.cpu, 1));
    setText(U.cCpu.s, tr('coresLoad', G.sys?.cpuCount ?? '–', c.load.map(fmtLoad).join(' / ')));
    setBar(U.cCpu.bar!, num(c.cpu));
    const m = c.mem;
    big(U.cMem.v, fmtPct(m.percent, 1));
    setText(U.cMem.s, tr('usedOfTotal', fmtBytes(m.used), fmtBytes(m.total)));
    setBar(U.cMem.bar!, num(m.percent));
    setTitle(U.cMem.root, `${tr('showMem')}\n${tr('memTip', fmtBytes(m.cache), m.swapTotal ? `${fmtBytes(m.swapUsed)} / ${fmtBytes(m.swapTotal)}` : tr('noSwap'))}`);
    setText(U.netV[0], fmtRate(c.rx));
    setText(U.netV[1], fmtRate(c.tx));
    // where CPU time goes, and how hot it runs
    const sp = c.split;
    const cpuBits = sp ? [tr('split', fmtPct(sp.u), fmtPct(sp.s), fmtPct(sp.w))] : [];
    if (sp && num(sp.st) >= 1) cpuBits.push(tr('steal', fmtPct(sp.st)));
    if (c.cpuTemp != null) cpuBits.push(tr('temp', c.cpuTemp));
    setText(U.cCpu.s2, cpuBits.join(' · '));
    U.cCpu.s2.classList.toggle('warn', num(sp?.w) >= 20 || num(c.cpuTemp) >= 90);
    // swap: how much, and whether it is moving right now
    const swapping = num(c.swapRate) >= 1048576;
    setText(U.cMem.s2, [m.swapTotal ? tr('swapLine', fmtBytes(m.swapUsed), fmtBytes(m.swapTotal)) : tr('noSwap'), swapping ? tr('swapping', fmtRate(c.swapRate)) : ''].filter(Boolean).join(' · '));
    U.cMem.s2.classList.toggle('warn', swapping);
    renderIo(c);
    stall(U.cCpu, c.psi?.cpu, 'psiCpu');
    stall(U.cMem, c.psi?.mem, 'psiMem');
    stall(U.cIo, c.psi?.io, 'psiIo');
    for (const card of [U.cCpu, U.cMem, U.cIo, U.cNet]) invalidate(card.chart!);
  }

  // GPU summary
  const g = G.gpus;
  const cg = U.cGpu;
  cg.bar!.root.hidden = cg.chart!.el.hidden = !g?.length;
  if (g?.length) {
    const free = g.filter((x) => x.free).length;
    let u = 0;
    let un = 0;
    let mp = 0;
    let mn = 0;
    for (const x of g) {
      if (x.util != null) (u += x.util), un++;
      if (x.memUsed != null && x.memTotal) (mp += (x.memUsed / x.memTotal) * 100), mn++;
    }
    const avgMem = mn ? mp / mn : NaN;
    big(cg.v, `${free}/${g.length}`);
    setText(cg.s, tr('gpuSub', fmtPct(un ? u / un : NaN)));
    setBar(cg.bar!, avgMem, tr('gpuMemTip', fmtPct(avgMem)));
    invalidate(cg.chart!);
  } else {
    big(cg.v, G.gpuNone ? tr('noGpu') : '–');
    setText(cg.s, G.gpuNone ? '' : tr('waiting'));
  }

  // home disk
  const d = disk;
  const cd = U.cDisk;
  if (d) {
    big(cd.v, d.status === 'ok' ? fmtPct(d.percent, 1) : '–');
    setText(cd.s, d.status === 'ok' ? tr('usedOfTotal', fmtBytes(d.used), fmtBytes(d.total)) : d.status === 'pending' ? tr('checking') : tr('notResp'));
    cd.s.classList.toggle('bad', d.status === 'timeout' || d.status === 'error');
    setBar(cd.bar!, d.status === 'ok' ? num(d.percent) : NaN);
    setTitle(cd.root, `${tr('showDisks')}\n${d.mount}`);
    setText(U.diskM, d.mount);
  }

  // uptime
  const sys = G.sys;
  if (sys) {
    big(U.cUp.v, dur((Date.now() - sys.boot) / 1000));
    setText(U.cUp.s, sys.os);
    setText(U.upOs, `${sys.kernel} (${sys.arch})`);
  }
  renderMood();
}

/** The I/O card: the busiest disk's busy %, throughput, latency; every disk in the tooltip. */
function renderIo(c: OvCore): void {
  const k = U!.cIo;
  const top = c.disks[0];
  k.bar!.root.hidden = !top;
  if (!top) {
    big(k.v, '–');
    setText(k.s, tr('ioNone'));
    setText(k.s2, '');
    return;
  }
  big(k.v, fmtPct(top.util));
  setText(k.s, [top.dev, tr('ioRead', fmtRate(top.r)), tr('ioWrite', fmtRate(top.w))].join(' · '));
  const lat = top.await == null ? '' : tr('await', top.await.toFixed(top.await >= 10 ? 0 : 1));
  setText(k.s2, [lat, top.iops == null ? '' : tr('iops', Math.round(top.iops)), top.temp == null ? '' : tr('temp', top.temp)].filter(Boolean).join(' · '));
  setBar(k.bar!, num(top.util));
  const lines = c.disks.map((d) => `${d.dev}${d.mounts.length ? ` (${d.mounts.join(', ')})` : ''}: ${tr('busy', fmtPct(d.util))} · ${tr('ioRead', fmtRate(d.r))} · ${tr('ioWrite', fmtRate(d.w))}`);
  setTitle(k.root, [tr('ioTip'), ...lines].join('\n'));
}

/** Stall-pressure chip: shown from 1 %, coloured as it gets serious. */
function stall(card: Card, v: number | null | undefined, tip: OvKey): void {
  const ch = card.stall!;
  const x = num(v);
  ch.hidden = !(x >= 1);
  if (ch.hidden) return;
  setText(ch, tr('stall', fmtPct(x, x < 10 ? 1 : 0)));
  ch.className = 'stall' + (x >= 30 ? ' c' : x >= 10 ? ' w' : '');
  setTitle(ch, `${tr(tip, fmtPct(x, 1))}\n${tr('psiNote')}`);
}

const MOOD_TEXT: Record<Mood, OvKey> = { calm: 'moodCalm', busy: 'moodBusy', hot: 'moodHot', gpu: 'moodGpu' };

function renderMood(): void {
  if (!U) return;
  let want: Mood = mood;
  const core = G.core;
  if (core) {
    const cpu = num(core.cpu);
    const mem = num(core.mem.percent);
    // GPUs count as "full" when none is free and they are working on average; "calm" needs idle GPUs too.
    const gpus = G.gpus ?? [];
    const utils = gpus.map((x) => num(x.util)).filter((u) => !isNaN(u));
    const avgUtil = utils.length ? utils.reduce((a, b) => a + b, 0) / utils.length : 0;
    const gpuFull = gpus.length > 0 && gpus.every((x) => !x.free) && avgUtil >= 50;
    const gpuQuiet = !gpus.length || avgUtil < 30;
    // stalls on memory / disk count too: a machine waiting on a saturated disk is not "calm" at 10 % CPU
    const psiMem = num(core.psi?.mem);
    const strained = psiMem >= 10 || num(core.psi?.io) >= 30 || num(core.disks[0]?.util) >= 80;
    want = cpu >= G.cfg.warn || mem >= G.cfg.warn || psiMem >= 30 ? 'hot' : gpuFull ? 'gpu' : cpu < 30 && mem < 70 && gpuQuiet && !strained ? 'calm' : 'busy';
  }
  // switch only when two consecutive samples agree, so the cat does not flicker at a boundary
  if (want !== mood) {
    if (moodNext === want || !U.moodEl.dataset.init) mood = want;
    moodNext = want;
  } else moodNext = undefined;
  U.moodEl.dataset.init = '1';
  if (U.moodEl.dataset.mood !== mood) U.moodEl.dataset.mood = mood;
  setText(U.ms, tr(MOOD_TEXT[mood]));
}

export const overviewPage: PageDef = {
  id: 'ov',
  seg: 'mon',
  label: 'pOv',
  build(root) {
    U = build(root);
    onRender('page:ov', render);
  },
  render,
};
