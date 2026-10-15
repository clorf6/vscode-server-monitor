// Inline SVG for the overview: codicon-like line icons and the pixel cat. Built with DOM APIs (no innerHTML);
// every color comes from CSS classes in media/overview.css.

const NS = 'http://www.w3.org/2000/svg';

function svg(viewBox: string, cls: string): SVGSVGElement {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', viewBox);
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  return s;
}

function add<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  parent.appendChild(e);
  return e;
}

// 16×16 line icons (stroke = currentColor). `play` is filled; `more` and the db dots are zero-length round caps.
const ICONS = {
  dash: 'M2.5 11a5.5 5.5 0 0 1 11 0M8 11l2.6-3.2M4.5 13.5h7',
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M12.5 1.5v3h-3',
  spark: 'M7 1.5l1.3 4.2L12.5 7 8.3 8.3 7 12.5 5.7 8.3 1.5 7l4.2-1.3zM12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
  chip: 'M3.5 4.5h9v7h-9zM6 6.5h4v3H6zM5.5 2v2.5M8 2v2.5M10.5 2v2.5M5.5 11.5V14M8 11.5V14M10.5 11.5V14M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2',
  bell: 'M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11zM6.5 13.5a1.5 1.5 0 0 0 3 0',
  term: 'M1.5 3h13v10h-13zM4 6l2.5 2L4 10M8 10.5h4',
  folder: 'M1.5 3.5h4.5l1.5 1.5h7v8h-13zM1.5 7h13',
  gear: 'M2 4.5h1.5M6.5 4.5H14M2 8h7.5M12.5 8H14M2 11.5h2.5M7.5 11.5H14M5 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3zM11 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3zM6 10a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3z',
  play: 'M5 3.5v9l7.5-4.5z',
  x: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  plus: 'M8 3v10M3 8h10',
  warn: 'M8 1.8l6.7 12H1.3zM8 6.3v3.6M8 11.7v.1',
  crit: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13zM8 4.5v4.5M8 11.2v.1',
  chev: 'M6 3.5L10.5 8 6 12.5',
  check: 'M3 8.5l3 3 7-7',
  copy: 'M5.5 5.5h8v8h-8zM2.5 10.5v-8h8',
  search: 'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 1 0 0-9zM10.3 10.3l3.7 3.7',
  user: 'M8 2.5a2.75 2.75 0 1 0 0 5.5 2.75 2.75 0 1 0 0-5.5zM2.5 14c.6-2.7 2.9-4.3 5.5-4.3s4.9 1.6 5.5 4.3',
  users: 'M6 3a2.3 2.3 0 1 0 0 4.6A2.3 2.3 0 1 0 6 3zM1.5 13c.5-2.3 2.3-3.6 4.5-3.6s4 1.3 4.5 3.6M10.5 3.2a2.2 2.2 0 0 1 0 4.3M12 9.6c1.3.5 2.2 1.7 2.5 3.4',
  home: 'M2 7.5L8 2.5l6 5M3.5 6.5v7h9v-7M6.5 13.5v-4h3v4',
  db: 'M2.5 3.5h11v4h-11zM2.5 8.5h11v4h-11zM11 5.5h.01M11 10.5h.01',
  cloud: 'M4.5 12.5h7a3 3 0 0 0 .3-6A4 4 0 0 0 4.2 7a2.75 2.75 0 0 0 .3 5.5z',
  globe: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13zM1.5 8h13M8 1.5c-2 2.3-2 10.7 0 13M8 1.5c2 2.3 2 10.7 0 13',
  lock: 'M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5',
  ext: 'M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v4h-9v-9h4',
  win: 'M2 3h12v10H2zM2 6h12',
  eye: 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 1 0 0-4z',
  edit: 'M10.5 2.5l3 3L6 13H3v-3zM9 4l3 3',
  stop: 'M4.5 4.5h7v7h-7z',
  kill: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 1 0 0-13zM3.4 3.4l9.2 9.2',
  bolt: 'M9 1.5L3.5 9h4L7 14.5 12.5 7h-4z',
  pause: 'M5.5 3.5v9M10.5 3.5v9',
  logs: 'M2.5 4h11M2.5 8h11M2.5 12h7',
  up: 'M8 13.5V3M3.5 7.5L8 3l4.5 4.5',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  file: 'M4 1.5h5l3.5 3.5v9.5H4zM9 1.5V5h3.5',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5V5H5M8 5v3.3l2 1.2',
  box: 'M2.5 5L8 2.5 13.5 5v6.5L8 14l-5.5-2.5zM2.5 5L8 7.5 13.5 5M8 7.5V14',
  plug: 'M5.5 1.5v3M10.5 1.5v3M3.5 4.5h9v3a4.5 4.5 0 0 1-9 0zM8 12v2.5',
  attach: 'M2.5 8h8M7.5 4.5L11 8l-3.5 3.5M13.5 2.5v11',
  pulse: 'M1.5 8h3l2-4.5 3 9 2-4.5h3',
  mem: 'M2.5 5h11v6h-11zM5 11v2M8 11v2M11 11v2M5 7.5v1M8 7.5v1M11 7.5v1',
};
export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGSVGElement {
  const s = svg('0 0 16 16', name === 'play' ? 'ic f' : 'ic');
  add(s, 'path', { d: ICONS[name] });
  return s;
}

// ---------------------------------------------------------------- pixel cat (24×16 grid)

const BODY = [
  '...b.......b',
  '...bb.....bb',
  '...bbbbbbbbb',
  '..bbbbbbbbbbb',
  '..bbbbbbbbbbb',
  '..bbbbbbbbbbb',
  '..bbbbbbbbbbb',
  '...bbbbbbbbb',
  '....bbbbbbb',
  '...bbbbbbbbb.........b',
  '..bbbbbbbbbbb.......bb',
  '..bbbbbbbbbbb.......b',
  '.bbbbbbbbbbbbb.....bb',
  '.bbbbbbbbbbbbb....bb',
  '.bbbbbbbbbbbbbb.bbb',
  '.bbbbbbbbbbbbbbbbb',
];

type Px = [number, number, number, number, string];
/** Mood layers: [moods it shows in, pixels]. Class letters: e eye, n nose, d drop, l/s/o laptop, g/r GPU board. */
const LAYERS: [string, Px[]][] = [
  ['calm', [[4, 5, 2, 1, 'e'], [9, 5, 2, 1, 'e']]],
  ['busy gpu', [[4, 4, 2, 2, 'e'], [9, 4, 2, 2, 'e']]],
  ['hot', [[4, 4, 1, 1, 'e'], [5, 5, 1, 1, 'e'], [4, 6, 1, 1, 'e'], [10, 4, 1, 1, 'e'], [9, 5, 1, 1, 'e'], [10, 6, 1, 1, 'e'], [7, 7, 1, 1, 'e']]],
  ['calm busy gpu', [[7, 6, 1, 1, 'n']]],
  ['busy', [[3, 10, 10, 6, 'l'], [4, 11, 8, 4, 's'], [7, 12, 2, 2, 'o']]],
  ['gpu', [[4, 6, 1, 1, 'd'], [15, 3, 8, 5, 'g'], [16, 4, 1, 3, 'r'], [18, 4, 1, 3, 'r'], [20, 4, 1, 3, 'r'], [16, 8, 1, 1, 'g'], [18, 8, 1, 1, 'g'], [20, 8, 1, 1, 'g']]],
  ['hot', [[14, 1, 1, 1, 'd'], [13, 2, 2, 2, 'd']]],
];

export type Mood = 'calm' | 'busy' | 'hot' | 'gpu';

/** The cat; the parent's `data-mood` attribute decides which layers show (see overview.css). */
export function cat(): SVGSVGElement {
  const s = svg('0 0 24 16', 'cat');
  const body = add(s, 'g', { class: 'cb' });
  BODY.forEach((row, y) => {
    for (const m of row.matchAll(/b+/g)) add(body, 'rect', { x: m.index ?? 0, y, width: m[0].length, height: 1 });
  });
  for (const [moods, px] of LAYERS) {
    const g = add(s, 'g', { class: moods.split(' ').map((x) => 'm-' + x).join(' ') });
    for (const [x, y, w, h, c] of px) add(g, 'rect', { x, y, width: w, height: h, class: 'c' + c });
  }
  const z = add(s, 'g', { class: 'm-calm zz' });
  ([[15, 7, 3, 'z'], [18, 4, 4, 'Z']] as const).forEach(([x, y, size, ch], i) => {
    const t = add(z, 'text', { x, y, 'font-size': size, class: 'z z' + i });
    t.textContent = ch;
  });
  return s;
}
