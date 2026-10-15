// Collector behaviour against this machine's /proc and fake `nvidia-smi` / `ss` binaries.
// Bundled into out/parsers.test.js (imported from parsers.test.ts), so `npm test` runs it without a separate entry.
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as P from '../src/collectors/parsers';
import { ProcessCollector } from '../src/collectors/processes';
import { GpuCollector } from '../src/collectors/gpu';
import { listenSignature, PortCollector } from '../src/collectors/ports';
import { listPids, resetPidList } from '../src/util/procfs';
import { run, runExclusive } from '../src/util/exec';

const linux = process.platform === 'linux';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeBin(name: string, script: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servermon-test-'));
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/bash\n' + script, { mode: 0o755 });
  return p;
}

/** The old split-based parser, as the reference for the in-place one. */
function refPidStat(text: string) {
  const l = text.indexOf('(');
  const r = text.lastIndexOf(')');
  const f = text.slice(r + 2).split(' ');
  return { pid: Number(text.slice(0, l)), comm: text.slice(l + 1, r), state: f[0], ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), threads: Number(f[17]), startTicks: Number(f[19]), rssPages: Number(f[21]) };
}

test('parsePidStat matches the reference parser on every live process', { skip: !linux }, () => {
  let n = 0;
  for (const e of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(e)) continue;
    let text: string;
    try {
      text = fs.readFileSync(`/proc/${e}/stat`, 'utf8');
    } catch {
      continue;
    }
    assert.deepEqual(P.parsePidStat(text), refPidStat(text), text);
    n++;
  }
  assert.ok(n > 10);
  assert.equal(P.parsePidStat('1 (x) S 1 2 3'), undefined, 'truncated');
});

test('listPids: one shared listing for concurrent and recent callers', { skip: !linux }, async () => {
  resetPidList();
  const [a, b] = await Promise.all([listPids(), listPids()]);
  assert.equal(a, b, 'concurrent callers share the listing in flight');
  assert.ok(a.includes(process.pid));
  assert.equal(await listPids(), a, 'recent listing reused');
  await sleep(20);
  assert.notEqual(await listPids(10), a, 'maxAge honoured');
});

test('process scan: CPU% stays right when baselines come from scans of different scopes', { skip: !linux }, async () => {
  const busy = spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' });
  try {
    await sleep(300);
    const pc = new ProcessCollector();
    const me = process.getuid!();
    resetPidList(); // the shared listing may predate the child
    await pc.scan(); // all users: baseline for everyone
    await sleep(900);
    await pc.scan(4_000_000_000); // a uid nobody has: our busy child is skipped, its baseline kept
    await sleep(400);
    const all = await pc.scan();
    const p = all.procs.find((x) => x.pid === busy.pid)!;
    assert.ok(p, 'busy child listed');
    // The child burns one core. Its baseline is 1.3 s old while the previous scan was 0.4 s ago: the old global-dt
    // computation reported ~300% here.
    assert.ok(p.cpu > 40 && p.cpu < 130, `busy child at ~100%, got ${p.cpu.toFixed(0)}%`);
    const mine = await pc.scan(me, false);
    assert.ok(mine.procs.every((x) => x.uid === me));
    assert.ok(pc.hasBaseline(me) && pc.hasBaseline(undefined), 'recent all-users scan covers both scopes');
    assert.deepEqual(pc.pidsOf(me, 10_000)?.includes(busy.pid!), true);
    // Kernel threads are re-read every third full scan only, but listed (with their last rate) every time.
    const kt = all.procs.filter((x) => x.ppid === 2).length;
    for (let i = 0; i < 3; i++) {
      const s = await pc.scan();
      const k = s.procs.filter((x) => x.ppid === 2);
      assert.ok(Math.abs(k.length - kt) < 20, 'kernel threads keep being listed');
      assert.ok(k.every((x) => isFinite(x.cpu) && x.cpu >= 0));
    }
  } finally {
    busy.kill('SIGKILL');
  }
});

const FAKE_SMI = `
args="$*"
ms=0
while [ $# -gt 0 ]; do [ "$1" = "-lms" ] && ms=$2; shift; done
if [[ "$args" == *--query-gpu=* ]]; then
  echo "0, GPU-aaa, NVIDIA Fake, 10, 5, 100, 1000, 40, 50.5, 300, 30, 555.1"
  echo "1, GPU-bbb, NVIDIA Fake, 0, 0, 1, 1000, 30, 20.0, 300, 30, 555.1"
  exit 0
fi
cycle=0
while true; do
  # cycles 0-1 and from 10 on: two apps; 2-9: none (an empty cycle prints nothing)
  if [ $cycle -lt 2 ] || [ $cycle -ge 10 ]; then
    echo "123, GPU-aaa, 500, python"
    echo "456, GPU-bbb, 700, train.py, with comma"
  fi
  cycle=$((cycle+1))
  [ "$ms" = 0 ] && exit 0
  sleep $(awk "BEGIN{print $ms/1000}")
done
`;

test('GPU compute apps stream: bursts are delimited, empty cycles report no apps', { skip: !linux }, async () => {
  const gc = new GpuCollector();
  (gc as unknown as { binary: string }).binary = fakeBin('nvidia-smi', FAKE_SMI);
  const got: { t: number; pids: number[] }[] = [];
  const t0 = Date.now();
  await gc.startApps(200, (apps) => got.push({ t: Date.now() - t0, pids: apps.map((a) => a.pid) }));
  await sleep(2700);
  gc.stopApps();
  assert.equal(gc.indexOf('GPU-bbb'), 1, 'uuid → index from detection');
  assert.ok(got.length >= 4, `emissions: ${JSON.stringify(got)}`);
  assert.deepEqual(got[0].pids, [123, 456], 'first cycle is one burst');
  assert.ok(got[0].t < 1000, `first data quickly, got ${got[0].t} ms`);
  const firstEmpty = got.findIndex((g) => !g.pids.length);
  assert.ok(firstEmpty > 0, 'silent cycles become an empty list');
  assert.ok(got.slice(firstEmpty).some((g) => g.pids.length === 2), 'apps come back');
  assert.ok(got.every((g) => g.pids.length === 0 || g.pids.length === 2), 'never a partial burst');
  // one-shot path (fetch/refresh, polling fallback) parses the same output
  const once = await gc.queryApps();
  assert.deepEqual(once.map((a) => a.name), ['python', 'train.py, with comma']);
});

test('GPU compute apps stream: a wedged nvidia-smi does not turn into "no apps"', { skip: !linux }, async () => {
  const gc = new GpuCollector();
  (gc as unknown as { binary: string }).binary = fakeBin('nvidia-smi', FAKE_SMI);
  const got: number[] = [];
  await gc.startApps(200, (apps) => got.push(apps.length));
  await sleep(250);
  const child = (gc as unknown as { appsChild: { pid: number } }).appsChild;
  process.kill(child.pid, 'SIGSTOP'); // no progress at all from here on
  await sleep(1300);
  gc.stopApps();
  try {
    process.kill(child.pid, 'SIGCONT');
  } catch {
    /* already killed */
  }
  assert.ok(got.length >= 1 && got[0] === 2);
  assert.ok(!got.includes(0), `no empty list while stalled: ${JSON.stringify(got)}`);
});

test('ports: owners (ss -e) re-read only when the listening set changes', { skip: !linux }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servermon-ss-'));
  const list = path.join(dir, 'listen.txt');
  const me = process.getuid!();
  const lines = [
    `LISTEN 0      4096            0.0.0.0:8080 0.0.0.0:* uid:4242 ino:111 sk:1 cgroup:/x <->`,
    `LISTEN 3      4096            127.0.0.1:6006 0.0.0.0:* uid:${me} ino:999999999 sk:2 cgroup:/x <->`,
  ];
  fs.writeFileSync(list, lines.join('\n') + '\n');
  // Without -e: no uid/ino, and a Recv-Q that changes between calls.
  const ss = fakeBin('ss', `if [[ "$1" == *e* ]]; then cat "${list}"; else sed -E "s/ uid:.*$//; s/^LISTEN [0-9]+/LISTEN $RANDOM/" "${list}"; fi\n`);
  const pc = new PortCollector(me);
  (pc as unknown as { ss: string }).ss = ss;
  const a = await pc.collect();
  assert.deepEqual(a.ports.map((p) => [p.port, p.uid]), [[6006, me], [8080, 4242]]);
  assert.deepEqual(pc.stats, { cheap: 0, full: 1, inodeScans: 1 });
  const b = await pc.collect();
  assert.deepEqual(b, a, 'same result from the cheap listing');
  assert.deepEqual(pc.stats, { cheap: 1, full: 1, inodeScans: 1 }, 'no ss -e, and the unresolvable inode is not searched again');
  fs.appendFileSync(list, `LISTEN 0      4096            [::]:9000 [::]:* uid:4242 ino:112 sk:3 cgroup:/x <->\n`);
  const c = await pc.collect();
  assert.equal(c.ports.length, 3);
  assert.deepEqual(pc.stats, { cheap: 2, full: 2, inodeScans: 1 }, 'changed set: owners re-read');
  assert.equal(listenSignature(P.parseSsListen([...lines].reverse().join('\n'))), listenSignature(P.parseSsListen(lines.join('\n'))), 'order-insensitive');
});

test('runExclusive: no second copy while a timed-out run has not exited', { skip: !linux }, async () => {
  const r = await run('sleep', ['5'], { timeoutMs: 50 });
  assert.equal(r.timedOut, true);
  await r.exited; // SIGKILLed: gone shortly after the timeout
  const a = await runExclusive('test:sleep', 'sleep', ['5'], { timeoutMs: 50 });
  assert.equal(a.timedOut, true);
  // The killed process has not been reaped yet at this point (a stuck NFS stat never would be): nothing is spawned.
  const b = await runExclusive('test:sleep', 'sleep', ['0']);
  assert.equal(b.stderr, 'previous run still has not exited');
  await a.exited;
  await sleep(10);
  const c = await runExclusive('test:sleep', 'sleep', ['0']);
  assert.equal(c.code, 0, 'runs again once the old one is gone');
});
