// Exercises the scheduler's demand/visibility logic with short real intervals.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { deepEqual, Scheduler } from '../src/scheduler';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test('scheduler: demand, focus, background, overlap, warmup', async () => {
  const s = new Scheduler();
  s.backgroundIntervalMs = 300;
  let polls = 0;
  const src = s.source('x', { interval: () => 50, poll: async () => ++polls });
  await sleep(200);
  assert.equal(polls, 0, 'no demand -> no polling');
  const d = src.demand('view');
  await sleep(230);
  const fgPolls = polls;
  assert.ok(fgPolls >= 3 && fgPolls <= 6, `focused fg polls ~4, got ${fgPolls}`);
  s.backgroundMode = 'pause';
  s.setFocused(false);
  const p0 = polls;
  await sleep(300);
  assert.equal(polls, p0, 'paused when unfocused');
  const bg = src.demand('alerts', 'bg');
  await sleep(700);
  assert.ok(polls - p0 >= 1 && polls - p0 <= 3, `bg runs at background interval, got ${polls - p0}`);
  bg.dispose();
  s.setFocused(true);
  const p1 = polls;
  await sleep(120);
  assert.ok(polls > p1, 'resumes when focused');
  d.dispose();
  const p2 = polls;
  await sleep(200);
  assert.ok(polls - p2 <= 1, 'stops after demand released');
  // no overlapping polls with slow poll fn
  let running = 0, maxRunning = 0;
  const slow = s.source('slow', { interval: () => 10, poll: async () => { running++; maxRunning = Math.max(maxRunning, running); await sleep(60); running--; return 1; } });
  const ds = slow.demand('v');
  slow.refresh(); slow.refresh();
  await sleep(300);
  ds.dispose();
  assert.equal(maxRunning, 1, 'polls never overlap');
  // warmup polls twice when stale
  let w = 0;
  const warm = s.source('warm', { interval: () => 1000, poll: async () => ++w, warmup: true });
  const dw = warm.demand('v');
  await sleep(900);
  assert.equal(w, 2, 'warmup: two polls on first demand');
  dw.dispose();
  s.dispose();
});

test('scheduler: per-demand minInterval — fastest active demand wins', () => {
  const s = new Scheduler();
  s.backgroundIntervalMs = 15000;
  const src = s.source('x', { interval: () => 2000, poll: async () => 1 });
  assert.equal(src.effectiveInterval(), undefined);
  const bar = src.demand('statusBar', 'fg', { minInterval: 5000 });
  assert.equal(src.effectiveInterval(), 5000, 'status bar alone: 5 s');
  const view = src.demand('gpuView');
  assert.equal(src.effectiveInterval(), 2000, 'visible view: base interval');
  view.dispose();
  assert.equal(src.effectiveInterval(), 5000, 'back to 5 s');
  // minInterval below the base never speeds a source up
  const fast = src.demand('fast', 'fg', { minInterval: 100 });
  assert.equal(src.effectiveInterval(), 2000);
  fast.dispose();
  // unfocused: fg demands slow to the background interval (or stop), bg demands keep running
  s.setFocused(false);
  assert.equal(src.effectiveInterval(), 15000);
  s.backgroundMode = 'pause';
  s.reconcileAll();
  assert.equal(src.effectiveInterval(), undefined);
  const alerts = src.demand('alerts', 'bg', { minInterval: 30000 });
  assert.equal(src.effectiveInterval(), 30000, 'bg demand honours its own minInterval');
  alerts.dispose();
  s.setFocused(true);
  assert.equal(src.effectiveInterval(), 5000);
  bar.dispose();
  assert.equal(src.effectiveInterval(), undefined);
  s.dispose();
});

test('scheduler: a stale handle does not remove a newer demand under the same key', () => {
  const s = new Scheduler();
  const src = s.source('x', { interval: () => 1000, poll: async () => 1 });
  const a = src.demand('k', 'fg', { minInterval: 5000 });
  const b = src.demand('k', 'fg'); // re-registered (e.g. config change) before the old one was released
  a.dispose();
  assert.equal(src.effectiveInterval(), 1000, 'newer demand survives');
  b.dispose();
  assert.equal(src.effectiveInterval(), undefined);
  s.dispose();
});

test('scheduler: streams restart only when the effective interval changes; slowing down is deferred', async () => {
  const s = new Scheduler();
  s.streamSlowdownMs = 150;
  const starts: number[] = [];
  let stops = 0;
  const src = s.source('g', { interval: () => 20, stream: { start: (ms) => void starts.push(ms), stop: () => void stops++ } });
  const bar = src.demand('statusBar', 'fg', { minInterval: 100 });
  assert.deepEqual(starts, [100]);
  const view = src.demand('view');
  assert.deepEqual(starts, [100, 20], 'speeding up restarts at once');
  const view2 = src.demand('view2');
  src.reconcile();
  s.reconcileAll();
  assert.deepEqual(starts, [100, 20], 'same interval: no restart');
  view.dispose();
  view2.dispose();
  assert.deepEqual(starts, [100, 20], 'slowing down waits');
  assert.equal(src.interval, 20);
  // the faster consumer comes back within the grace period: nothing restarts at all
  const back = src.demand('view');
  await sleep(200);
  assert.deepEqual(starts, [100, 20]);
  back.dispose();
  await sleep(250);
  assert.deepEqual(starts, [100, 20, 100], 'slowed down after the grace period');
  assert.equal(src.interval, 100);
  bar.dispose();
  assert.equal(stops, 1, 'last demand gone: stops immediately');
  assert.equal(src.active, false);
  s.dispose();
});

test('scheduler: identical values are not re-published, updatedAt still advances', async () => {
  const s = new Scheduler();
  let v = { a: [1, 2], b: 'x' };
  const src = s.source('t', { interval: () => 30, poll: async () => JSON.parse(JSON.stringify(v)), same: deepEqual });
  let fired = 0;
  src.onData.event(() => fired++);
  const d = src.demand('v');
  await sleep(140);
  assert.equal(fired, 1, 'published once');
  const u0 = src.updatedAt;
  await sleep(60);
  assert.ok(src.updatedAt > u0, 'still polled');
  v = { a: [1, 3], b: 'x' };
  await sleep(80);
  assert.equal(fired, 2, 'change published');
  assert.deepEqual(src.latest, v);
  d.dispose();
  s.dispose();
});

test('scheduler: warm-up gap, and no warm-up when the collector still has a baseline', async () => {
  const s = new Scheduler();
  let polls = 0;
  let baseline = false;
  const src = s.source('w', { interval: () => 1000, poll: async () => ++polls, warmup: true, warmupMs: 50, hasBaseline: () => baseline });
  const t0 = Date.now();
  let first = 0;
  const sub = src.onData.event(() => (first ||= Date.now() - t0));
  const d = src.demand('v');
  await sleep(150);
  assert.equal(polls, 2, 'baseline + published poll');
  assert.ok(first >= 45 && first < 140, `first data after the warm-up gap, got ${first} ms`);
  d.dispose();
  sub.dispose();
  // stale again, but the collector kept a usable baseline: one poll, published at once
  src.updatedAt = Date.now() - 10_000;
  baseline = true;
  const d2 = src.demand('v');
  await sleep(30);
  assert.equal(polls, 3);
  d2.dispose();
  s.dispose();
});

test('scheduler: stream sources with a poll serve fetch() and refresh() without scheduling polls', async () => {
  const s = new Scheduler();
  let polls = 0;
  let emit: ((v: number) => void) | undefined;
  const src = s.source('a', { interval: () => 50, poll: async () => 100 + ++polls, stream: { start: (_ms, e) => (emit = e), stop: () => (emit = undefined) } });
  assert.equal(await src.fetch(), 101, 'fetch without demand polls once');
  await sleep(120);
  assert.equal(polls, 1, 'no polling loop started');
  const d = src.demand('v');
  emit!(7);
  assert.equal(src.latest, 7);
  assert.equal(await src.fetch(), 7, 'fresh stream data is served');
  src.refresh();
  await sleep(20);
  assert.equal(polls, 2, 'refresh polls once');
  await sleep(150);
  assert.equal(polls, 2, 'and does not keep polling');
  d.dispose();
  assert.equal(emit, undefined);
  s.dispose();
});

test('deepEqual', () => {
  assert.ok(deepEqual({ a: [1, { b: NaN }], c: 'x' }, { c: 'x', a: [1, { b: NaN }] }));
  assert.ok(!deepEqual({ a: undefined }, { b: undefined }));
  assert.ok(!deepEqual([1, 2], [1, 2, 3]));
  assert.ok(!deepEqual({ a: [] }, { a: {} }));
  assert.ok(!deepEqual(0, '0'));
  assert.ok(deepEqual(undefined, undefined));
});
