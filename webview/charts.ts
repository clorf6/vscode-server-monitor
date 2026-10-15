// Hand-written canvas line charts, formatting helpers and the shared tooltip. No dependencies.

export interface Theme {
  s: string[];
  fg: string;
  muted: string;
  card: string;
  font: string;
}

/** Resolved colors for canvas drawing (canvas cannot read CSS variables). Refreshed on theme change. */
export const theme: Theme = { s: ['#2a78d6', '#eb6834'], fg: '#888', muted: '#888', card: '#fff', font: 'sans-serif' };

export function readTheme(): void {
  const cs = getComputedStyle(document.body);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  theme.s = [v('--s1', '#2a78d6'), v('--s2', '#eb6834')];
  theme.fg = v('--vscode-foreground', '#888');
  theme.muted = v('--vscode-descriptionForeground', theme.fg);
  theme.card = v('--card', '#fff');
  theme.font = cs.fontFamily || 'sans-serif';
}

/** The time-range filter, shared by every chart (ms). */
export const view = { range: 5 * 60_000 };

// ---------------------------------------------------------------- formatting

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const ok = (n: number | null | undefined): n is number => n != null && isFinite(n);

/** 1024-based compact size: "1.5 GB", "312 MB". */
export function fmtBytes(n: number | null | undefined): string {
  if (!ok(n) || n < 0) return '–';
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)} ${UNITS[i]}`;
}

export const fmtRate = (n: number | null | undefined): string => (ok(n) ? fmtBytes(n) + '/s' : '–');

export const fmtPct = (n: number | null | undefined, d = 0): string => (ok(n) ? n.toFixed(d) + '%' : '–');

const fmts: Record<string, Intl.DateTimeFormat> = {};
export function fmtTime(t: number, sec = true): string {
  const k = sec ? 's' : 'm';
  if (!fmts[k]) {
    const o: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: sec ? '2-digit' : undefined, hourCycle: 'h23' };
    try {
      fmts[k] = new Intl.DateTimeFormat(document.documentElement.lang || undefined, o);
    } catch {
      fmts[k] = new Intl.DateTimeFormat(undefined, o);
    }
  }
  return fmts[k].format(t);
}

// ---------------------------------------------------------------- tooltip

export interface TipRow {
  /** Series color index (0 = series-1, 1 = series-2). */
  c: number;
  v: string;
  l: string;
}

let tipEl: HTMLDivElement | undefined;

/** One tooltip for the whole page: value first (bold), series name second, keyed by a short line in the series color. */
export function showTip(x: number, y: number, head: string, rows: TipRow[]): void {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  const e = tipEl;
  e.replaceChildren();
  if (head) {
    const h = document.createElement('div');
    h.className = 'th';
    h.textContent = head;
    e.appendChild(h);
  }
  for (const r of rows) {
    const d = document.createElement('div');
    d.className = 'tr';
    const k = document.createElement('span');
    k.className = `lk k${r.c + 1}`;
    const b = document.createElement('b');
    b.textContent = r.v;
    const l = document.createElement('span');
    l.textContent = r.l;
    d.append(k, b, l);
    e.appendChild(d);
  }
  e.hidden = false;
  const w = e.offsetWidth;
  const h = e.offsetHeight;
  let left = x + 14;
  let top = y + 14;
  if (left + w > innerWidth - 4) left = Math.max(4, x - w - 14);
  if (top + h > innerHeight - 4) top = Math.max(4, y - h - 14);
  e.style.left = left + 'px';
  e.style.top = top + 'px';
}

export function hideTip(): void {
  if (tipEl) tipEl.hidden = true;
}

// ---------------------------------------------------------------- redraw scheduling

export interface Drawable {
  draw(): void;
}

const dirty = new Set<Drawable>();
let raf = 0;

/** Coalesce redraws into one animation frame. */
export function invalidate(d: Drawable): void {
  dirty.add(d);
  if (!raf) raf = requestAnimationFrame(flush);
}

function flush(): void {
  raf = 0;
  const list = [...dirty];
  dirty.clear();
  for (const d of list) d.draw();
}

const observed = new Map<Element, Drawable>();
const ro = new ResizeObserver((entries) => {
  for (const e of entries) {
    const d = observed.get(e.target);
    if (d) invalidate(d);
  }
});

/** Redraw `d` whenever `el` changes size. */
export function observe(el: Element, d: Drawable): void {
  observed.set(el, d);
  ro.observe(el);
}

export function unobserve(el: Element): void {
  observed.delete(el);
  ro.unobserve(el);
}

/** Theme change: every chart redraws with fresh colors. */
export function redrawAll(): void {
  for (const d of observed.values()) invalidate(d);
}

// ---------------------------------------------------------------- line chart

export interface SeriesDef {
  l: string;
  c: number;
}

export interface ChartData {
  t: number[];
  ys: number[][];
}

export interface ChartOpts {
  series: SeriesDef[];
  /** 'pct': fixed 0–100 axis. 'rate': bytes/s with clean 1024-based ticks. */
  kind: 'pct' | 'rate';
  h: number;
  get: () => ChartData;
  label: string;
  /** Sparkline: no axes, no hover. */
  spark?: boolean;
}

const X_STEPS = [5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5];

function lowerBound(t: number[], x: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Median sampling interval of the visible part; a gap of more than 3× this breaks the line. */
function medianStep(t: number[], lo: number): number {
  const d: number[] = [];
  for (let i = lo + 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
  if (!d.length) return Infinity;
  d.sort((a, b) => a - b);
  return Math.max(d[d.length >> 1], 200);
}

/** Clean bytes/s axis: the step is 1, 2, 2.5 or 5 × 10^n of a 1024-based unit. */
function niceRate(max: number, n: number): { top: number; step: number; k: number } {
  max = Math.max(max, 1024);
  const raw = max / n;
  // unit from the maximum, so the top label reads "1.5 MB/s" rather than "1500 KB/s"
  let k = Math.max(0, Math.min(UNITS.length - 1, Math.floor(Math.log(max) / Math.log(1024))));
  const r = raw / 1024 ** k;
  const mag = 10 ** Math.floor(Math.log10(r));
  const f = r / mag;
  let s = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  if (s >= 1000 && k < UNITS.length - 1) {
    k++;
    s = 1;
  }
  if (k === 0) s = Math.max(1, s);
  const step = s * 1024 ** k;
  return { top: Math.max(step, Math.ceil(max / step - 1e-9) * step), step, k };
}

const rateTick = (v: number, k: number) => (v ? `${+(v / 1024 ** k).toFixed(2)} ${UNITS[k]}/s` : '0');

export class LineChart implements Drawable {
  readonly el: HTMLCanvasElement;
  /** Hovered time (snaps to the nearest sample on draw), pointer position for the tooltip. */
  private hoverT: number | null = null;
  private px = 0;
  private py = 0;
  private kb = false;
  private lay = { l: 0, pw: 1, t0: 0, t1: 1 };

  constructor(parent: HTMLElement, private readonly o: ChartOpts) {
    const c = (this.el = document.createElement('canvas'));
    c.className = o.spark ? 'spark' : 'chart';
    c.style.height = o.h + 'px';
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', o.label);
    parent.appendChild(c);
    observe(c, this);
    if (o.spark) return;
    c.tabIndex = 0;
    c.addEventListener('pointermove', (e) => {
      this.kb = false;
      this.px = e.clientX;
      this.py = e.clientY;
      const { l, pw, t0, t1 } = this.lay;
      this.hoverT = t0 + ((e.clientX - c.getBoundingClientRect().left - l) / pw) * (t1 - t0);
      invalidate(this);
    });
    const clear = () => {
      this.hoverT = null;
      hideTip();
      invalidate(this);
    };
    c.addEventListener('pointerleave', clear);
    c.addEventListener('blur', clear);
    // Keyboard: same readout as hover; arrows step through samples.
    c.addEventListener('focus', () => {
      const { t } = this.o.get();
      if (!t.length) return;
      this.kb = true;
      this.hoverT = t[t.length - 1];
      invalidate(this);
    });
    c.addEventListener('keydown', (e) => {
      const { t } = this.o.get();
      if (!t.length || this.hoverT === null) return;
      let i = lowerBound(t, this.hoverT);
      if (e.key === 'ArrowLeft') i--;
      else if (e.key === 'ArrowRight') i++;
      else if (e.key === 'Home') i = lowerBound(t, t[t.length - 1] - view.range);
      else if (e.key === 'End') i = t.length - 1;
      else if (e.key === 'Escape') return clear();
      else return;
      e.preventDefault();
      this.kb = true;
      this.hoverT = t[Math.max(lowerBound(t, t[t.length - 1] - view.range), Math.min(t.length - 1, i))];
      invalidate(this);
    });
  }

  destroy(): void {
    unobserve(this.el);
    this.el.remove();
  }

  draw(): void {
    const c = this.el;
    const o = this.o;
    const W = c.clientWidth;
    const H = o.h;
    if (!W) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(W * dpr);
    const bh = Math.round(H * dpr);
    if (c.width !== bw || c.height !== bh) {
      c.width = bw;
      c.height = bh;
    }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);

    const { t, ys } = o.get();
    const n = t.length;
    const sp = !!o.spark;
    const t1 = n ? t[n - 1] : Date.now();
    const t0 = t1 - view.range;
    let lo = lowerBound(t, t0);
    if (lo > 0) lo--; // one point beyond the left edge so the line enters the plot

    // y scale: percentages always 0–100; rates get clean ticks over the visible maximum
    let top = 100;
    let step = H < 90 ? 50 : 25;
    let k = 0;
    if (o.kind === 'rate') {
      let mx = 0;
      for (const y of ys) for (let i = lo; i < n; i++) if (y[i] > mx) mx = y[i];
      ({ top, step, k } = niceRate(mx, sp ? 1 : H < 90 ? 2 : 4));
    }
    g.font = `11px ${theme.font}`;
    const ticks: number[] = [];
    for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
    const labels = sp ? [] : ticks.map((v) => (o.kind === 'pct' ? v + '%' : rateTick(v, k)));
    let left = 0;
    for (const s of labels) left = Math.max(left, g.measureText(s).width);
    left = sp ? 0 : Math.ceil(left) + 8;
    const pt = sp ? 3 : 7;
    const pb = sp ? 3 : 20;
    const pw = Math.max(1, W - left - (sp ? 0 : 6));
    const ph = Math.max(1, H - pt - pb);
    const X = (v: number) => left + ((v - t0) / (t1 - t0)) * pw;
    const Y = (v: number) => pt + ph - (Math.max(0, Math.min(v, top)) / top) * ph;
    this.lay = { l: left, pw, t0, t1 };

    if (!sp) {
      // recessive 1px solid gridlines + y labels in text color
      g.lineWidth = 1;
      g.textAlign = 'right';
      g.textBaseline = 'middle';
      ticks.forEach((v, i) => {
        const y = Math.round(Y(v)) + 0.5;
        g.globalAlpha = i === 0 ? 0.28 : 0.12;
        g.strokeStyle = theme.fg;
        g.beginPath();
        g.moveTo(left, y);
        g.lineTo(left + pw, y);
        g.stroke();
        g.globalAlpha = 1;
        g.fillStyle = theme.muted;
        g.fillText(labels[i], left - 6, y);
      });
      // x labels at clean wall-clock times
      const span = t1 - t0;
      const stepT = X_STEPS.find((s) => (s / span) * pw >= (s < 6e4 ? 72 : 52)) ?? X_STEPS[X_STEPS.length - 1];
      g.textAlign = 'center';
      g.textBaseline = 'top';
      for (let tt = Math.ceil(t0 / stepT) * stepT; tt <= t1; tt += stepT) {
        const x = X(tt);
        const s = fmtTime(tt, stepT < 6e4);
        const hw = g.measureText(s).width / 2;
        if (x - hw < left - 2 || x + hw > W) continue;
        g.fillText(s, x, pt + ph + 5);
      }
    }

    g.save();
    g.beginPath();
    g.rect(left, 0, pw + 2, H);
    g.clip();
    const gap = 3 * medianStep(t, lo);
    const base = pt + ph;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    g.lineCap = 'round';
    ys.forEach((y, si) => {
      g.strokeStyle = g.fillStyle = theme.s[o.series[si]?.c ?? si] ?? theme.fg;
      let s = -1;
      for (let i = lo; i <= n; i++) {
        const valid = i < n && isFinite(y[i]);
        if (s >= 0 && (!valid || t[i] - t[i - 1] > gap)) {
          this.segment(g, t, y, s, i - 1, X, Y, base);
          s = -1;
        }
        if (valid && s < 0) s = i;
      }
    });

    // hover: crosshair snapped to the nearest sample + one tooltip listing every series
    if (this.hoverT !== null && n && !sp) {
      let i = lowerBound(t, this.hoverT);
      if (i >= n || (i > 0 && this.hoverT - t[i - 1] < t[i] - this.hoverT)) i--;
      i = Math.max(i, Math.min(n - 1, lowerBound(t, t0)));
      const x = Math.round(X(t[i])) + 0.5;
      g.globalAlpha = 0.45;
      g.strokeStyle = theme.fg;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, pt);
      g.lineTo(x, base);
      g.stroke();
      g.globalAlpha = 1;
      const rows: TipRow[] = [];
      ys.forEach((y, si) => {
        const v = y[i];
        const ci = o.series[si]?.c ?? si;
        if (isFinite(v)) {
          g.beginPath();
          g.arc(x, Y(v), 5, 0, 7);
          g.fillStyle = theme.s[ci];
          g.fill();
          g.lineWidth = 2;
          g.strokeStyle = theme.card;
          g.stroke();
        }
        rows.push({ c: ci, v: o.kind === 'pct' ? fmtPct(v, Number.isInteger(v) ? 0 : 1) : fmtRate(v), l: o.series[si]?.l ?? '' });
      });
      let tx = this.px;
      let ty = this.py;
      if (this.kb) {
        const r = c.getBoundingClientRect();
        tx = r.left + x;
        ty = r.top + pt;
      }
      showTip(tx, ty, fmtTime(t[i]), rows);
    }
    g.restore();
  }

  private segment(g: CanvasRenderingContext2D, t: number[], y: number[], a: number, b: number, X: (v: number) => number, Y: (v: number) => number, base: number): void {
    if (a === b) {
      g.beginPath();
      g.arc(X(t[a]), Y(y[a]), 1.5, 0, 7);
      g.fill();
      return;
    }
    const line = new Path2D();
    line.moveTo(X(t[a]), Y(y[a]));
    for (let i = a + 1; i <= b; i++) line.lineTo(X(t[i]), Y(y[i]));
    const area = new Path2D(line);
    area.lineTo(X(t[b]), base);
    area.lineTo(X(t[a]), base);
    area.closePath();
    g.globalAlpha = 0.1;
    g.fill(area);
    g.globalAlpha = 1;
    g.stroke(line);
  }
}
