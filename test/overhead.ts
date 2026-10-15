// Per-source overhead, measured through the real Monitor/Scheduler (vscode mocked) at the real intervals.
// Counts the extension process (process.cpuUsage: all threads, GC included) AND every child it spawns:
//   - short-lived children (ss, tmux, nvidia-smi one-shots, stat -f, getent) are reaped by libuv, so their CPU lands
//     in our own cutime/cstime (/proc/self/stat fields 16/17);
//   - long-lived children (nvidia-smi -lms streams) are sampled through /proc/<pid>/stat at the window edges.
// Build: npx esbuild test/overhead.ts --bundle --platform=node --alias:vscode=./test/vscode-mock.ts --outfile=out/overhead.js
// Usage: node out/overhead.js [seconds=30] [scenario,scenario,...]
//   ELD=1 also records event-loop delay (its 20 ms timer adds ~0.1% of a core to the ext column).
import * as fs from 'fs';
import { monitorEventLoopDelay } from 'perf_hooks';
import { registry } from './vscode-mock';
import { Monitor } from '../src/monitor';

const HZ = 100;
const SECS = Number(process.argv[2] ?? 30);
const ONLY = process.argv[3]?.split(',');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function statFields(path: string): string[] {
  const s = fs.readFileSync(path, 'utf8');
  return s.slice(s.lastIndexOf(')') + 2).split(' ');
}
/** utime+stime of children we already reaped (field 16+17). */
function reapedChildTicks(): number {
  const f = statFields('/proc/self/stat');
  return Number(f[13]) + Number(f[14]);
}
/** pid → utime+stime of children still alive. */
function liveChildren(): Map<number, number> {
  const out = new Map<number, number>();
  for (const t of fs.readdirSync('/proc/self/task')) {
    let txt = '';
    try {
      txt = fs.readFileSync(`/proc/self/task/${t}/children`, 'utf8');
    } catch {
      continue;
    }
    for (const p of txt.split(' ')) {
      if (!p.trim()) continue;
      try {
        const f = statFields(`/proc/${p}/stat`);
        out.set(Number(p), Number(f[11]) + Number(f[12]));
      } catch {
        /* gone */
      }
    }
  }
  return out;
}

interface Reading {
  ext: number; // % of one core
  child: number; // % of one core
  elapsed: number;
  eldMax: number; // ms
  eldP99: number; // ms
  liveChildren: number;
}

class Meter {
  private cpu0 = process.cpuUsage();
  private t0 = performance.now();
  private reaped0 = reapedChildTicks();
  private live0 = liveChildren();
  private eld = process.env.ELD ? monitorEventLoopDelay({ resolution: 20 }) : undefined;
  constructor() {
    this.eld?.enable();
  }
  stop(): Reading {
    const cpu = process.cpuUsage(this.cpu0);
    const elapsed = (performance.now() - this.t0) / 1000;
    const live1 = liveChildren();
    let ticks = reapedChildTicks() - this.reaped0;
    for (const [p, t] of live1) ticks += t - (this.live0.get(p) ?? 0);
    // Children alive at the start and reaped since: cutime holds their whole life, keep only the part in the window.
    for (const [p, t] of this.live0) if (!live1.has(p)) ticks -= t;
    this.eld?.disable();
    return {
      ext: ((cpu.user + cpu.system) / 1e6 / elapsed) * 100,
      child: (ticks / HZ / elapsed) * 100,
      elapsed,
      eldMax: this.eld ? this.eld.max / 1e6 : NaN,
      eldP99: this.eld ? this.eld.percentile(99) / 1e6 : NaN,
      liveChildren: live1.size,
    };
  }
}

type Key = 'core' | 'gpu' | 'gpuApps' | 'procs' | 'ports' | 'tmux' | 'disks' | 'docker';
interface Scenario {
  name: string;
  /** Sources whose first data we wait for. */
  keys: Key[];
  demand: (m: Monitor) => { dispose(): void }[];
  secs?: number;
}

const dem = (k: Key, key = 'bench', opts?: unknown) => (m: Monitor) => {
  const src = m[k] as unknown as { demand: (key: string, kind?: 'fg' | 'bg', opts?: unknown) => { dispose(): void } };
  return src.demand(key, 'fg', opts);
};

const scenarios: Scenario[] = [
  { name: 'idle (floor)', keys: [], demand: () => [] },
  { name: 'core 2s', keys: ['core'], demand: (m) => [dem('core')(m)] },
  { name: 'gpu stream 2s', keys: ['gpu'], demand: (m) => [dem('gpu')(m)] },
  { name: 'gpu view (gpu+gpuApps)', keys: ['gpu', 'gpuApps'], demand: (m) => [dem('gpu')(m), dem('gpuApps')(m)] },
  { name: 'procs mine 3s', keys: ['procs'], demand: (m) => [dem('procs')(m)] },
  {
    name: 'procs all 5s',
    keys: ['procs'],
    demand: (m) => {
      m.needAllProcesses('bench', true);
      return [dem('procs')(m), { dispose: () => m.needAllProcesses('bench', false) }];
    },
  },
  { name: 'ports 5s', keys: ['ports'], demand: (m) => [dem('ports')(m)] },
  { name: 'tmux 3s', keys: ['tmux'], demand: (m) => [dem('tmux')(m)] },
  { name: 'disks 30s', keys: ['disks'], demand: (m) => [dem('disks')(m)], secs: Math.max(SECS, 60) },
  { name: 'docker 5s', keys: ['docker'], demand: (m) => [dem('docker')(m)] },
  {
    // Sidebar open with the default-visible views (GPUs, processes, tmux) plus the status bar (cpu/mem/gpu/net).
    name: 'status bar + default views',
    keys: ['core', 'gpu', 'gpuApps', 'procs', 'tmux'],
    demand: (m) => [dem('core', 'statusBar')(m), dem('gpu', 'statusBar')(m), dem('gpu', 'gpuView')(m), dem('gpuApps', 'gpuView')(m), dem('procs', 'processView')(m), dem('tmux', 'tmuxView')(m)],
  },
  {
    name: 'status bar only',
    keys: ['core', 'gpu'],
    demand: (m) => [dem('core', 'statusBar')(m), dem('gpu', 'statusBar', { minInterval: 5000 })(m)],
  },
  {
    name: 'dashboard',
    keys: ['core', 'gpu', 'gpuApps', 'procs', 'disks'],
    demand: (m) => {
      m.needAllProcesses('dashboard', true);
      return [...(['core', 'gpu', 'gpuApps', 'procs', 'disks'] as Key[]).map((k) => dem(k, 'dashboard')(m)), { dispose: () => m.needAllProcesses('dashboard', false) }];
    },
  },
];

/** Time until each source has fresh data: a publish, or (for de-duplicated sources) a poll that confirmed the latest. */
function firstData(m: Monitor, keys: Key[]): { done: Promise<void>; lat: Map<Key, number> } {
  const t0 = performance.now();
  const w0 = Date.now();
  const lat = new Map<Key, number>();
  const src = (k: Key) => m[k] as unknown as { updatedAt: number; onData: { event: (l: () => void) => { dispose(): void } } };
  const subs: { dispose(): void }[] = [];
  const done = new Promise<void>((resolve) => {
    const check = () => {
      for (const k of keys) if (!lat.has(k) && src(k).updatedAt >= w0) lat.set(k, performance.now() - t0);
      if (lat.size === keys.length) resolve();
    };
    for (const k of keys) subs.push(src(k).onData.event(check));
    const iv = setInterval(check, 5);
    subs.push({ dispose: () => clearInterval(iv) });
    check();
  });
  return { done: Promise.race([done, sleep(20000)]).then(() => subs.forEach((s) => s.dispose())), lat };
}

/** Count publishes and how many were identical to the previous one (wasted re-renders). */
function publishCounter(m: Monitor, keys: Key[]) {
  const counts = new Map<Key, { n: number; dup: number; last?: string }>();
  const subs = keys.map((k) => {
    const c = { n: 0, dup: 0 } as { n: number; dup: number; last?: string };
    counts.set(k, c);
    const src = m[k] as unknown as { onData: { event: (l: (v: unknown) => void) => { dispose(): void } } };
    return src.onData.event((v) => {
      c.n++;
      if (k === 'procs' || k === 'core' || k === 'gpu') return; // always change (timestamps / rates)
      const s = JSON.stringify(v);
      if (s === c.last) c.dup++;
      c.last = s;
    });
  });
  return { counts, dispose: () => subs.forEach((s) => s.dispose()) };
}

const fmtLat = (lat: Map<Key, number>, keys: Key[]) => keys.map((k) => `${k} ${lat.has(k) ? Math.round(lat.get(k)!) : '∞'}`).join(', ');

async function main() {
  registry.config['refreshInterval'] = 2000;
  const rows: string[] = [];
  console.log(`load ${fs.readFileSync('/proc/loadavg', 'utf8').trim()}  window ${SECS}s`);
  for (const sc of scenarios) {
    if (ONLY && !ONLY.some((o) => sc.name.startsWith(o))) continue;
    const m = new Monitor();
    await sleep(300); // getconf etc. from the constructor
    // Cold: fresh collectors, first demand.
    const coldMeter = new Meter();
    const cold = firstData(m, sc.keys);
    let held = sc.demand(m);
    await cold.done;
    const coldR = coldMeter.stop();
    // Steady state.
    const pub = publishCounter(m, sc.keys);
    const meter = new Meter();
    await sleep((sc.secs ?? SECS) * 1000);
    const r = meter.stop();
    pub.dispose();
    // Re-show after being hidden long enough for rate baselines to go stale.
    held.forEach((d) => d.dispose());
    await sleep(9000);
    const again = firstData(m, sc.keys);
    held = sc.demand(m);
    await again.done;
    held.forEach((d) => d.dispose());
    m.dispose();
    await sleep(500);

    const pubs = [...pub.counts].map(([k, c]) => `${k} ${c.n}${c.dup ? ` (${c.dup} dup)` : ''}`).join(', ');
    const line = `| ${sc.name.padEnd(28)} | ${r.ext.toFixed(2).padStart(5)} | ${r.child.toFixed(2).padStart(5)} | ${(r.ext + r.child).toFixed(2).padStart(5)} | ${r.eldP99.toFixed(0).padStart(3)}/${r.eldMax.toFixed(0).padStart(3)} | ${fmtLat(cold.lat, sc.keys)} | ${fmtLat(again.lat, sc.keys)} | ${pubs} |`;
    rows.push(line);
    console.log(line, `  [cold phase ext ${(coldR.ext * coldR.elapsed * 10).toFixed(0)} ms cpu, child ${(coldR.child * coldR.elapsed * 10).toFixed(0)} ms cpu]`);
  }
  console.log('\n| scenario | ext % | child % | total % | loop delay p99/max ms | first data cold (ms) | first data re-show (ms) | publishes |');
  console.log('|---|--:|--:|--:|--:|---|---|---|');
  for (const r of rows) console.log(r);
  console.log(`\nrss ${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MiB, load ${fs.readFileSync('/proc/loadavg', 'utf8').trim()}`);
  process.exit(0);
}

void main();
