import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as P from '../src/collectors/parsers';
import { History } from '../src/history';
import { aggregateUsers } from '../src/collectors/users';
import * as F from '../src/util/forecast';

const fx = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', name), 'utf8');

test('proc/stat: aggregate and per-core times', () => {
  const s = P.parseProcStat(fx('proc_stat.txt'));
  assert.ok(s.all.total > 0 && s.all.idle > 0);
  assert.ok(s.cores.length >= 1);
  assert.ok(s.btime > 1_500_000_000);
  const a = { idle: 100, total: 200 };
  const b = { idle: 150, total: 400 };
  assert.equal(P.cpuPercent(a, b), 75);
  assert.equal(P.cpuPercent(undefined, b), 0);
  assert.equal(P.cpuPercent(b, b), 0);
});

test('meminfo: used = total - available', () => {
  const m = P.memFromMeminfo(P.parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\nBuffers: 50 kB\nCached: 300 kB\nSReclaimable: 50 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n'));
  assert.equal(m.total, 1000 * 1024);
  assert.equal(m.used, 400 * 1024);
  assert.equal(m.cache, 400 * 1024);
  assert.equal(m.swapUsed, 50 * 1024);
  assert.equal(m.percent, 40);
  const real = P.memFromMeminfo(P.parseMeminfo(fx('meminfo.txt')));
  assert.ok(real.total > 0 && real.used > 0 && real.used < real.total);
});

test('net/dev and diskstats', () => {
  const n = P.parseNetDev(fx('net_dev.txt'));
  assert.ok(n.some((x) => x.iface === 'lo'));
  assert.ok(n.every((x) => x.rx >= 0 && x.tx >= 0));
  const devs = P.physicalBlockDevices(['sda', 'nvme0n1', 'loop0', 'dm-0', 'md127', 'sr0', 'zram0']);
  assert.deepEqual([...devs].sort(), ['nvme0n1', 'sda']);
  const d = P.parseDiskstats(fx('diskstats.txt'), devs);
  assert.ok(d.length >= 1);
  assert.ok(d.every((x) => devs.has(x.dev)));
});

test('pid stat: comm with spaces and parentheses', () => {
  const line = '1234 (tmux: server (x)) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 3 0 98765 123456789 2048 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 5 0 0 0 0 0';
  const s = P.parsePidStat(line)!;
  assert.equal(s.pid, 1234);
  assert.equal(s.comm, 'tmux: server (x)');
  assert.equal(s.state, 'S');
  assert.equal(s.ppid, 1);
  assert.equal(s.ticks, 300);
  assert.equal(s.threads, 3);
  assert.equal(s.startTicks, 98765);
  assert.equal(s.rssPages, 2048);
  assert.equal(P.parsePidStat('garbage'), undefined);
  const self = P.parsePidStat(fs.readFileSync('/proc/self/stat', 'utf8'))!;
  assert.equal(self.pid, process.pid);
  assert.equal(P.parseCmdline('python\0train.py\0--lr\x000.1\0'), 'python train.py --lr 0.1');
});

test('ss -tlnHe listening sockets', () => {
  const s = P.parseSsListen(fx('ss.txt'));
  assert.ok(s.length > 0);
  assert.ok(s.every((x) => x.port > 0 && x.inode > 0));
  const synth = P.parseSsListen(
    [
      'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* ino:1000 sk:1 <->',
      'LISTEN 0 128 [::]:8888 [::]:* uid:1024 ino:2000 sk:2 v6only:1 <->',
      'LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* uid:101 ino:3000 sk:3 <->',
      'LISTEN 0 4096 *:6006 *:* uid:1024 ino:4000 sk:4 <->',
    ].join('\n'),
  );
  assert.deepEqual(
    synth.map((x) => [x.host, x.port, x.uid, x.inode, x.family]),
    [
      ['0.0.0.0', 22, 0, 1000, 4],
      ['::', 8888, 1024, 2000, 6],
      ['127.0.0.53', 53, 101, 3000, 4],
      ['0.0.0.0', 6006, 1024, 4000, 4],
    ],
  );
});

test('/proc/net/tcp{,6} fallback', () => {
  const v4 = P.parseProcNetTcp('  sl  local_address rem_address   st\n   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1024        0 555 1\n   1: 0100007F:1F91 0100007F:0001 01 00000000:00000000 00:00000000 00000000  1024        0 556 1\n', 4);
  assert.deepEqual(v4, [{ host: '127.0.0.1', port: 8080, uid: 1024, inode: 555, family: 4 }]);
  const v6 = P.parseProcNetTcp(fx('net_tcp6.txt'), 6);
  assert.ok(v6.length > 0);
  assert.equal(v6[0].host, '::ffff:127.0.0.1');
  const any = P.parseProcNetTcp('h\n 0: 00000000000000000000000000000000:22B8 00000000000000000000000000000000:0000 0A 0:0 0:0 0 1000 0 77 1\n', 6);
  assert.equal(any[0].host, '::');
  assert.equal(any[0].port, 8888);
});

test('mounts and statfs math', () => {
  const m = P.parseMounts(fx('mounts.txt'));
  assert.ok(m.some((x) => x.mount === '/'));
  assert.deepEqual(P.parseMounts('/dev/sdb1 /mnt/my\\040disk ext4 rw 0 0')[0], { device: '/dev/sdb1', mount: '/mnt/my disk', fstype: 'ext4' });
  const u = P.parseStatF('4096 1000 400 300\n')!;
  assert.equal(u.total, 4096 * 1000);
  assert.equal(u.used, 4096 * 600);
  assert.equal(u.avail, 4096 * 300);
  assert.ok(Math.abs(u.percent - (600 / 900) * 100) < 1e-9);
  assert.equal(P.parseStatF(''), undefined);
});

test('nvidia-smi gpu and compute apps CSV', () => {
  const gpus = fx('nvidia_gpu.txt').split('\n').map((l) => P.parseGpuLine(l)).filter(Boolean) as P.GpuInfo[];
  assert.ok(gpus.length >= 1);
  assert.equal(gpus[0].index, 0);
  assert.ok(gpus[0].memTotal > 0);
  assert.ok(!gpus[0].name.startsWith('NVIDIA '));
  const na = P.parseGpuLine('0, GPU-x, NVIDIA GeForce RTX 3090, 5, 1, 300, 24576, 40, [N/A], [N/A], [Not Supported]')!;
  assert.ok(isNaN(na.power) && isNaN(na.fan));
  assert.equal(na.util, 5);
  const apps = P.parseGpuApps(fx('nvidia_apps.txt'));
  assert.ok(apps.every((a) => a.pid > 0 && a.uuid.startsWith('GPU-')));
  assert.deepEqual(P.parseGpuApps('123, GPU-a, 1000, python, with comma\n'), [{ pid: 123, uuid: 'GPU-a', memMiB: 1000, name: 'python, with comma' }]);
});

test('tmux list-panes', () => {
  const real = P.parseTmuxPanes(fx('tmux.txt'));
  assert.ok(real.length >= 1);
  const text = ['exp\t$1\t1\t1700000000\t0\ttrain\t1\t0\t%1\t100\tpython\t/home/u/a\t1\t0', 'exp\t$1\t1\t1700000000\t0\ttrain\t1\t1\t%2\t101\tbash\t/home/u\t0\t0', 'exp\t$1\t1\t1700000000\t1\tlogs\t0\t0\t%3\t102\ttail\t/var/log\t1\t0', 'other\t$2\t0\t1700000100\t0\tbash\t1\t0\t%4\t103\tbash\t/tmp\t1\t1'].join('\n');
  const s = P.parseTmuxPanes(text);
  assert.equal(s.length, 2);
  assert.equal(s[0].windows.length, 2);
  assert.equal(s[0].windows[0].panes.length, 2);
  assert.equal(s[0].created, 1700000000000);
  assert.equal(s[1].windows[0].panes[0].dead, true);
  assert.equal(P.TMUX_FORMAT.split('\t').length, P.TMUX_FIELDS.length);
});

test('passwd, du, os-release, cgroup', () => {
  assert.equal(P.parsePasswd('root:x:0:0::/root:/bin/bash\nalice:x:1001:1001::/home/alice:/bin/zsh\n').get(1001), 'alice');
  const du = P.parseDu('100\t/data/a\n300\t/data/b/\n50\t/data/c.txt\n450\t/data\n', '/data/');
  assert.equal(du.total, 450);
  assert.deepEqual(du.entries.map((e) => e.path), ['/data/b/', '/data/a', '/data/c.txt']);
  assert.equal(P.parseOsRelease('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 22.04.5 LTS"\n'), 'Ubuntu 22.04.5 LTS');
  assert.equal(P.parseCgroupLimit('max\n'), undefined);
  assert.equal(P.parseCgroupLimit('9223372036854771712'), undefined);
  assert.equal(P.parseCgroupLimit('4294967296\n'), 4294967296);
  assert.equal(P.parseCpuMax('max 100000'), undefined);
  assert.equal(P.parseCpuMax('200000 100000'), 2);
});

test('utmp user records', () => {
  const buf = new Uint8Array(384 * 3);
  const dv = new DataView(buf.buffer);
  const put = (i: number, type: number, user: string) => {
    dv.setInt16(i * 384, type, true);
    buf.set(new TextEncoder().encode(user), i * 384 + 44);
  };
  put(0, 2, 'reboot'); // BOOT_TIME
  put(1, 7, 'alice');
  put(2, 7, 'bob');
  assert.deepEqual(P.parseUtmpUsers(buf), ['alice', 'bob']);
});

test('history ring buffer back-fills late series', () => {
  const h = new History(3);
  h.push(1, { a: 1 });
  h.push(2, { a: 2, b: 20 });
  h.push(3, { a: 3, b: 30 });
  h.push(4, { a: 4, b: 40 });
  const s = h.snapshot();
  assert.deepEqual(s.t, [2, 3, 4]);
  assert.deepEqual(s.series.a, [2, 3, 4]);
  assert.deepEqual(s.series.b, [20, 30, 40]);
  assert.deepEqual(h.snapshot(3).t, [3, 4]);
  const h2 = new History(5);
  h2.push(1, { a: 1 });
  h2.push(2, { b: 2 });
  assert.ok(isNaN(h2.snapshot().series.b[0]));
  assert.ok(isNaN(h2.snapshot().series.a[1]));
});

test('per-user aggregation maps GPU pids to uids', () => {
  const procs = [
    { pid: 1, ppid: 0, uid: 1000, comm: 'a', state: 'R', cpu: 150, rss: 100, start: 0, threads: 1 },
    { pid: 2, ppid: 0, uid: 1000, comm: 'b', state: 'S', cpu: 50, rss: 50, start: 0, threads: 1 },
    { pid: 3, ppid: 0, uid: 2000, comm: 'c', state: 'S', cpu: 10, rss: 10, start: 0, threads: 1 },
  ];
  const gpus = [{ index: 0, uuid: 'G0' }, { index: 1, uuid: 'G1' }] as P.GpuInfo[];
  const apps = [{ pid: 1, uuid: 'G1', memMiB: 1000, name: 'a' }, { pid: 2, uuid: 'G0', memMiB: 500, name: 'b' }, { pid: 99, uuid: 'G0', memMiB: 1, name: '?' }];
  const u = aggregateUsers(procs, apps, gpus);
  const a = u.find((x) => x.uid === 1000)!;
  assert.equal(a.cpu, 200);
  assert.equal(a.procs, 2);
  assert.deepEqual(a.gpus, [0, 1]);
  assert.equal(a.gpuMem, 1500);
});

// Collector tests (live /proc, fake nvidia-smi/ss) ride along in this bundle so `npm test` needs no extra entry.
import './collectors.test';

test('GPU idle rule: desktop memory does not make a GPU busy once processes are known (or unknowable)', async () => {
  const { isGpuFree } = await import('../src/collectors/gpu');
  const g = { index: 0, uuid: 'G0', name: 'RTX', util: 1, memUtil: 0, memUsed: 1500, memTotal: 8192, temp: 40, power: 20, powerLimit: 200, fan: 30 } as P.GpuInfo;
  assert.equal(isGpuFree(g, 500, 5), false, 'strict when process info is supported but not loaded');
  assert.equal(isGpuFree(g, 500, 5, { noProcessInfo: true }), true, 'WSL: display memory is fine');
  assert.equal(isGpuFree(g, 500, 5, { busy: new Set() }), true, 'no compute process on it');
  assert.equal(isGpuFree(g, 500, 5, { busy: new Set([0]) }), false, 'a compute process holds it');
  assert.equal(isGpuFree({ ...g, memUsed: 6000 }, 500, 5, { noProcessInfo: true }), false, 'most of the memory is in use');
  assert.equal(isGpuFree({ ...g, util: 40 }, 500, 5, { busy: new Set() }), false, 'utilised');
  assert.equal(isGpuFree({ ...g, memUsed: 3, memTotal: 49140, util: 0 }, 500, 5), true, 'idle server GPU');
});

test('proc/stat: CPU time split (user, system, I/O wait, steal)', () => {
  const a = P.parseProcStat('cpu  100 0 50 800 40 5 5 0 0 0\ncpu0 100 0 50 800 40 5 5 0 0 0\nbtime 1700000000\n');
  const b = P.parseProcStat('cpu  160 10 70 890 90 5 15 10 0 0\ncpu0 160 10 70 890 90 5 15 10 0 0\nbtime 1700000000\n');
  const sp = P.cpuSplitPercent(a.split, b.split)!;
  // deltas: user 60+10, system 20+0+10, idle 100, iowait 50, steal 10 → total 250
  const near = (x: number, y: number) => assert.ok(Math.abs(x - y) < 1e-9, `${x} ≈ ${y}`);
  near(sp.user, 28);
  near(sp.system, 12);
  near(sp.iowait, 20);
  near(sp.steal, 4);
  assert.equal(P.cpuSplitPercent(undefined, b.split), undefined);
});

test('diskstats: per-device busy %, IOPS, throughput and latency', () => {
  const line = (r: number, rs: number, rms: number, w: number, ws: number, wms: number, io: number) => `   8       0 sda ${r} 0 ${rs} ${rms} ${w} 0 ${ws} ${wms} 0 ${io} ${rms + wms}`;
  const [a] = P.parseDiskstats(line(100, 2000, 300, 50, 1000, 200, 1000));
  const [b] = P.parseDiskstats(line(300, 6000, 700, 150, 3000, 800, 1500));
  assert.equal(a.reads, 100);
  assert.equal(a.ioMs, 1000);
  const r = P.diskRates(a, b, 1000);
  assert.equal(r.util, 50);
  assert.equal(r.rIops, 200);
  assert.equal(r.wIops, 100);
  assert.equal(r.rBps, 4000 * 512);
  assert.equal(r.awaitMs, (400 + 600) / 300);
  assert.ok(Number.isNaN(P.diskRates(a, a, 1000).awaitMs));
});

test('pressure, vmstat, /proc/<pid>/io', () => {
  const io = P.parsePressure('some avg10=12.50 avg60=3.00 avg300=1.00 total=123\nfull avg10=4.25 avg60=1.00 avg300=0.50 total=45\n')!;
  assert.deepEqual(io, { some: 12.5, full: 4.25, some60: 3 });
  assert.equal(P.parsePressure('some avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')!.full, undefined);
  assert.equal(P.parsePressure(''), undefined);
  assert.deepEqual(P.parseVmstat('nr_free_pages 10\npswpin 5\npswpout 7\noom_kill 1\n', ['pswpin', 'pswpout', 'oom_kill']), { pswpin: 5, pswpout: 7, oom_kill: 1 });
  assert.deepEqual(P.parsePidIo('rchar: 10\nwchar: 20\nsyscr: 1\nsyscw: 1\nread_bytes: 4096\nwrite_bytes: 8192\ncancelled_write_bytes: 0\n'), { read: 4096, write: 8192 });
});

test('statfs: inodes when the filesystem has a fixed number of them', () => {
  const s = P.parseStatF('4096 1000 400 300 1000 100')!;
  assert.equal(s.inodes!.percent, 90);
  assert.equal(P.parseStatF('4096 1000 400 300')!.inodes, undefined);
  assert.equal(P.statfsToUsage(4096, 1000, 400, 300, 0, 0).inodes, undefined); // btrfs, NFS: no fixed count
});

test('GPU health fields and slowdown reasons', () => {
  const g = P.parseGpuLine('0, GPU-x, NVIDIA RTX A6000, 100, 90, 8000, 46068, 83, 249, 250, 60, 0x0000000000000024, 1590, 2100, 4, 4, 8, 16, 0', true)!;
  assert.equal(g.name, 'RTX A6000');
  assert.equal(g.throttle, 0x24);
  assert.equal(g.smClock, 1590);
  assert.equal(g.pcieWidth, 8);
  assert.equal(g.pcieWidthMax, 16);
  assert.equal(g.ecc, 0);
  assert.deepEqual(P.slowdowns(g.throttle), ['power', 'thermal']);
  assert.deepEqual(P.slowdowns(0x1), []); // idle
  assert.deepEqual(P.slowdowns(0x8), ['hardware']);
  assert.deepEqual(P.slowdowns(0x48), ['thermal']); // hardware slowdown caused by heat
  // without health parsing (older drivers) the fields stay absent
  assert.equal(P.parseGpuLine('0, GPU-x, A6000, 1, 1, 1, 2, 30, 20, 250, 30')!.throttle, undefined);
  // "[N/A]" ECC on consumer cards
  assert.ok(Number.isNaN(P.parseGpuLine('0, GPU-x, A6000, 1, 1, 1, 2, 30, 20, 250, 30, 0x0, 1, 2, 4, 4, 16, 16, [N/A]', true)!.ecc!));
});

test('disk fill forecast', () => {
  const pts = (rate: number, minutes: number) => Array.from({ length: minutes * 2 + 1 }, (_, i) => ({ t: i * 30_000, v: 1e9 + rate * i * 30 }));
  const growing = F.fillEta(pts(10 * 1048576, 20), 3600 * 10 * 1048576)!; // 10 MiB/s, one hour of space left
  assert.ok(Math.abs(growing.seconds - 3600) < 1);
  assert.equal(F.fillEta(pts(10 * 1048576, 5), 1e12), undefined); // too short to tell
  assert.equal(F.fillEta(pts(-1048576, 20), 1e9), undefined); // shrinking
  assert.equal(F.fillEta(pts(1000, 20), 1e9), undefined); // a trickle
  assert.equal(F.fillEta(pts(10 * 1048576, 20), 1e15), undefined); // beyond a week
});
