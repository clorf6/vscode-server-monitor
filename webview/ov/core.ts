// Shared state and DOM helpers of the sidebar panel webview. Plain DOM, no frameworks; every data-derived string goes
// through textContent / title / setAttribute (never innerHTML).

import type { Attn, OvCfg, OvCore, OvGpuRow, OvKey, OvSys, OvViewMsg, Page, ProcSort, Scope, Seg } from '../overview-protocol';
import { icon, IconName } from '../overview-art';

declare function acquireVsCodeApi(): { postMessage(m: OvViewMsg): void; getState(): unknown; setState(s: unknown): void };
const api = acquireVsCodeApi();
export const post = (m: OvViewMsg): void => api.postMessage(m);
export const cmd = (id: string): void => post({ type: 'command', id });

// ---------------------------------------------------------------- global state

/** Data every page may read (set from `init` and the global messages). */
export const G = {
  S: {} as Record<OvKey, string>,
  me: '',
  sys: undefined as OvSys | undefined,
  cfg: { type: 'cfg', warn: 85, crit: 95, quick: [] } as OvCfg,
  gpuNone: false,
  docker: false,
  procScope: 'mine' as Scope,
  procLimit: 50,
  attn: [] as Attn[],
  watchGpu: 0,
  watchN: 0,
  /** Latest core sample and GPU rows (概览, GPU and 磁盘 pages). */
  core: undefined as OvCore | undefined,
  gpus: undefined as OvGpuRow[] | undefined,
};

export function tr(k: OvKey, ...a: (string | number)[]): string {
  return (G.S[k] || k).replace(/\{(\d+)\}/g, (m, i: string) => (a[+i] === undefined ? m : String(a[+i])));
}

/** Per-window view state (vscode.getState): survives the webview being destroyed while hidden. */
export interface ViewState {
  sess?: string;
  page: Page;
  sub: Partial<Record<Seg, Page>>;
  sel: number[];
  dis: string[];
  pq?: { scope: Scope; sort: ProcSort; q: string };
  others?: boolean;
}

function load(): ViewState {
  const s = (api.getState() ?? {}) as Partial<ViewState>;
  return {
    sess: typeof s.sess === 'string' ? s.sess : undefined,
    page: typeof s.page === 'string' ? s.page : 'ov',
    sub: s.sub && typeof s.sub === 'object' ? s.sub : {},
    sel: Array.isArray(s.sel) ? s.sel.filter((x) => typeof x === 'number') : [],
    dis: Array.isArray(s.dis) ? s.dis.filter((x) => typeof x === 'string') : [],
    pq: s.pq && typeof s.pq === 'object' && typeof s.pq.q === 'string' ? s.pq : undefined,
    others: s.others === true,
  };
}

export const st: ViewState = load();

export function resetState(sess: string): void {
  Object.assign(st, { sess, page: 'ov', sub: {}, sel: [], dis: [], pq: undefined, others: false });
  save();
}

export function save(): void {
  try {
    api.setState(st);
  } catch {
    /* state is a convenience */
  }
}

// ---------------------------------------------------------------- navigation + render scheduling

export interface PageDef {
  id: Page;
  seg: Seg;
  label: OvKey;
  build(root: HTMLElement): void;
  render(): void;
  /** The page became visible; `arg` comes from a goto / another page (e.g. a process filter). */
  show?(arg?: unknown): void;
  hide?(): void;
}

/** Filled in by the entry module. */
export const nav = {
  page: 'ov' as Page,
  go: (p: Page, arg?: unknown): void => void [p, arg],
};

const renderers = new Map<string, () => void>();
const dirty = new Set<string>();
let raf = 0;

export function onRender(key: string, fn: () => void): void {
  renderers.set(key, fn);
}

/** Re-render parts in the next frame. Page keys render only while that page is shown (it renders on show). */
export function mark(...keys: string[]): void {
  for (const k of keys) dirty.add(k);
  if (!raf) raf = requestAnimationFrame(flush);
}

export function flush(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  const keys = [...dirty];
  dirty.clear();
  for (const k of keys) {
    if (k.startsWith('page:') && k !== 'page:' + nav.page) continue;
    renderers.get(k)?.();
  }
}

// ---------------------------------------------------------------- DOM helpers

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: Element | null, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export function setText(e: Element, s: string): void {
  if (e.textContent !== s) e.textContent = s;
}

export function setTitle(e: HTMLElement, s: string): void {
  if (e.title !== s) e.title = s;
}

export function setCls(e: Element, cls: string): void {
  if (e.className !== cls) e.className = cls;
}

export function button(parent: Element | null, cls: string, text: string, onClick: (ev: MouseEvent) => void, ic?: IconName): HTMLButtonElement {
  const b = el('button', cls, parent);
  b.type = 'button';
  if (ic) b.appendChild(icon(ic));
  if (text) el('span', '', b, text);
  b.addEventListener('click', onClick);
  return b;
}

/** Icon-only button with a tooltip and accessible name. */
export function iconBtn(parent: Element | null, ic: IconName, label: string, onClick: (ev: MouseEvent) => void, cls = 'ib'): HTMLButtonElement {
  const b = button(parent, cls, '', onClick, ic);
  b.title = label;
  b.setAttribute('aria-label', label);
  return b;
}

/** Clickable non-button container (cards may hold block content). */
export function clickable(e: HTMLElement, onClick: () => void): void {
  e.tabIndex = 0;
  if (!e.getAttribute('role')) e.setAttribute('role', 'button');
  e.addEventListener('click', onClick);
  e.addEventListener('keydown', (ev) => {
    if (ev.target !== e) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      onClick();
    }
  });
}

/** Big numbers: digits large, units ("%", " GB", "天") in a smaller span. Rebuilt only when the text changes. */
export function big(e: HTMLElement, s: string): void {
  if (e.dataset.v === s) return;
  e.dataset.v = s;
  e.replaceChildren();
  e.classList.toggle('dim', !/\d/.test(s));
  for (const part of s.split(/(\d[\d.,]*)/)) {
    if (!part) continue;
    if (/^\d/.test(part)) e.append(part);
    else el('small', '', e, part);
  }
}

export interface Bar {
  root: HTMLElement;
  fill: HTMLElement;
}

export function bar(parent: Element, cls = 'bar'): Bar {
  const root = el('div', cls, parent);
  return { root, fill: el('div', '', root) };
}

/** Accent bar that turns yellow/red at the configured thresholds (the number is always shown next to it). */
export function setBar(b: Bar, p: number, title?: string, base = 'bar'): void {
  const v = isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
  setCls(b.root, base + (p >= G.cfg.crit ? ' bad' : p >= G.cfg.warn ? ' warn' : ''));
  const w = v.toFixed(1) + '%';
  if (b.fill.style.width !== w) b.fill.style.width = w;
  if (title !== undefined) setTitle(b.root, title);
}

/** Empty / status block with an icon, a title and a hint. */
export function emptyBox(parent: Element, ic: IconName): { root: HTMLElement; t: HTMLElement; h: HTMLElement; acts: HTMLElement } {
  const root = el('div', 'empty', parent);
  root.appendChild(icon(ic));
  const t = el('div', 'et', root);
  const h = el('div', 'eh', root);
  const acts = el('div', 'eacts', root);
  return { root, t, h, acts };
}

export function setEmpty(e: { root: HTMLElement; t: HTMLElement; h: HTMLElement }, show: boolean, title = '', hint = ''): void {
  e.root.hidden = !show;
  if (!show) return;
  setText(e.t, title);
  setText(e.h, hint);
  e.h.hidden = !hint;
}

// ---------------------------------------------------------------- toast

let toastEl: HTMLElement | undefined;
let toastTimer = 0;

export function toast(text: string): void {
  if (!toastEl) {
    toastEl = el('div', 'toast', document.body);
    toastEl.setAttribute('role', 'status');
  }
  toastEl.replaceChildren(icon('check'), document.createTextNode(text));
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove('on'), 1600);
}

// ---------------------------------------------------------------- lists: rows, roving focus, action bars

/**
 * Arrow-key navigation among the `.row` elements inside `list` (Up/Down/Home/End); only one row is in the tab order.
 * Right arrow / Shift+F10 / the context-menu key call `onMenu` (rows whose click does something else expose their
 * action bar that way); Escape calls `onEscape`.
 */
export function rovingList(list: HTMLElement, opts: { onMenu?(row: HTMLElement): void; onEscape?(): void } = {}): () => void {
  const rows = () => Array.from(list.querySelectorAll<HTMLElement>('.row')).filter((r) => !r.hidden);
  const sync = () => {
    const all = rows();
    let cur = all.find((r) => r.tabIndex === 0);
    if (!cur) cur = all.find((r) => r.classList.contains('sel')) ?? all[0];
    for (const r of all) if (r.tabIndex !== (r === cur ? 0 : -1)) r.tabIndex = r === cur ? 0 : -1;
  };
  list.addEventListener('focusin', (e) => {
    const r = (e.target as HTMLElement).closest<HTMLElement>('.row');
    if (!r || !list.contains(r)) return;
    for (const x of rows()) if (x !== r && x.tabIndex === 0) x.tabIndex = -1;
    r.tabIndex = 0;
  });
  list.addEventListener('keydown', (e) => {
    const r = e.target as HTMLElement;
    if (!r.classList?.contains('row')) {
      if (e.key === 'Escape') opts.onEscape?.();
      return;
    }
    const all = rows();
    const i = all.indexOf(r);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowDown') next = all[i + 1];
    else if (e.key === 'ArrowUp') next = all[i - 1];
    else if (e.key === 'Home') next = all[0];
    else if (e.key === 'End') next = all[all.length - 1];
    else if (e.key === 'ArrowRight' || e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      if (opts.onMenu) {
        e.preventDefault();
        opts.onMenu(r);
      }
      return;
    } else if (e.key === 'Escape') {
      opts.onEscape?.();
      return;
    } else return;
    e.preventDefault();
    if (next) next.focus();
  });
  return sync;
}

/** A focusable list row; Enter/Space activate it. */
export function row(parent: Element | null, cls: string, onActivate: () => void): HTMLElement {
  const r = el('div', 'row ' + cls, parent);
  r.tabIndex = -1;
  r.setAttribute('role', 'button');
  r.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button, a, input')) return;
    onActivate();
  });
  r.addEventListener('keydown', (e) => {
    if (e.target !== r || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    onActivate();
  });
  return r;
}

/**
 * Keep `list`'s rows in the order of `items`: rows are created once per key and updated in place, so focus and
 * selection survive updates. Rows are inserted before `end` (e.g. a "show more" button) when given.
 */
export function keyed<T, R extends { root: HTMLElement }>(list: HTMLElement, cache: Map<string, R>, items: T[], key: (t: T) => string, make: (t: T, k: string) => R, update: (r: R, t: T) => void, end: Node | null = null): void {
  const want = new Set<string>();
  let prev: Node | null = null;
  for (const t of items) {
    const k = key(t);
    want.add(k);
    let r = cache.get(k);
    if (!r) cache.set(k, (r = make(t, k)));
    update(r, t);
    const ref: Node | null = prev ? prev.nextSibling : list.firstChild;
    if (r.root !== ref) list.insertBefore(r.root, ref);
    prev = r.root;
    // keep an open action bar right below its row
    const next = r.root.nextSibling as HTMLElement | null;
    if (next?.classList?.contains('acts') && next.dataset.for === k) prev = next;
  }
  for (const [k, r] of cache) {
    if (want.has(k)) continue;
    r.root.remove();
    cache.delete(k);
  }
  if (end && end.parentNode === list && prev && prev.nextSibling !== end) list.insertBefore(end, prev.nextSibling);
}

/** Put (or move) an action bar right after its row; `null` removes it. */
export function placeActs(list: HTMLElement, cur: HTMLElement | undefined, rowEl: HTMLElement | undefined, make: () => HTMLElement, key: string): HTMLElement | undefined {
  if (!rowEl) {
    cur?.remove();
    return undefined;
  }
  let a = cur;
  if (!a || a.dataset.for !== key) {
    cur?.remove();
    a = make();
    a.dataset.for = key;
  }
  if (rowEl.nextSibling !== a) list.insertBefore(a, rowEl.nextSibling);
  return a;
}

export interface Act {
  ic: IconName;
  label: string;
  run: () => void;
  kind?: 'danger' | 'primary';
  /** Show "Copied" after running. */
  copy?: boolean;
}

/** Action bar under a selected row: labelled buttons, destructive ones last and marked. */
export function actionBar(acts: (Act | false | undefined)[], ...head: (Node | false | undefined)[]): HTMLElement {
  const box = el('div', 'acts');
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', tr('actions'));
  for (const h of head) if (h) box.appendChild(h);
  const btns = el('div', 'abtns', box);
  for (const a of acts) {
    if (!a) continue;
    button(btns, 'btn sm' + (a.kind ? ' ' + a.kind : ''), a.label, () => {
      a.run();
      if (a.copy) toast(tr('copied'));
    }, a.ic);
  }
  return box;
}

// ---------------------------------------------------------------- formatting

const UNITS = ['B', 'K', 'M', 'G', 'T', 'P'];

/** Compact size for list columns: "40.2G", "312M". */
export function fmtB(n: number | null | undefined): string {
  if (n == null || !isFinite(n) || n < 0) return '–';
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) (n /= 1024), i++;
  return (i === 0 ? String(Math.round(n)) : n >= 100 ? n.toFixed(0) : n.toFixed(1)) + UNITS[i];
}

export const fmtMiB = (mib: number | null | undefined): string => (mib == null ? '–' : fmtB(mib * 1048576));

export function fmtCpu(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '–';
  return (v >= 10 ? Math.round(v) : v.toFixed(1)) + '%';
}

export function dur(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? tr('dh', d, h) : h ? tr('hm', h, m) : tr('mm', Math.max(m, sec >= 60 ? m : 1));
}

/** "3 分钟前" */
export const ago = (t: number): string => tr('ago', dur(Math.max(0, (Date.now() - t) / 1000)));

/** Elapsed seconds as "12 s" / "3m" for running scans. */
export function elapsed(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : dur(s);
}

export const num = (v: number | null | undefined): number => (v == null ? NaN : v);

export function flash(e: HTMLElement): void {
  e.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  e.classList.remove('flash');
  void e.offsetWidth; // restart the animation
  e.classList.add('flash');
  setTimeout(() => e.classList.remove('flash'), 2000);
}

export { icon };
export type { IconName };
