// Collects one snapshot of everything on this machine, then measures steady-state overhead of the always-on path.
// Usage: node out/smoke.js [seconds] [intervalMs]
// Overhead lines count this process AND its children (reaped ones via /proc/self/stat cutime+cstime, long-lived
// streams via their own /proc/<pid>/stat). For per-source numbers through the real scheduler see test/overhead.ts.
import { CoreCollector } from '../src/collectors/core';
import { ProcessCollector } from '../src/collectors/processes';
import { GpuCollector } from '../src/collectors/gpu';
import { PortCollector } from '../src/collectors/ports';
import { TmuxClient } from '../src/collectors/tmux';
import { DiskCollector } from '../src/collectors/disks';
import { DockerClient } from '../src/collectors/docker';
import { getSysInfo } from '../src/collectors/sysinfo';
import { aggregateUsers } from '../src/collectors/users';
import { UserNames } from '../src/util/users';
import * as fmt from '../src/util/format';
import * as fs from 'fs';

/** CPU ticks (1/100 s) of children: already reaped + still running. */
function childTicks(): number {
  const self = fs.readFileSync('/proc/self/stat', 'utf8');
  const f = self.slice(self.lastIndexOf(')') + 2).split(' ');
  let ticks = Number(f[13]) + Number(f[14]);
  for (const t of fs.readdirSync('/proc/self/task')) {
    let kids = '';
    try {
      kids = fs.readFileSync(`/proc/self/task/${t}/children`, 'utf8');
    } catch {
      continue;
    }
    for (const pid of kids.split(' ').filter((x) => x.trim())) {
      try {
        const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const g = s.slice(s.lastIndexOf(')') + 2).split(' ');
        ticks += Number(g[11]) + Number(g[12]);
      } catch {
        /* exited */
      }
    }
  }
  return ticks;
}

const seconds = Number(process.argv[2] ?? 30);
const interval = Number(process.argv[3] ?? 2000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  const v = await fn();
  const c = process.cpuUsage(c0);
  console.log(`  ${label.padEnd(26)} wall ${(performance.now() - t0).toFixed(1).padStart(7)} ms   cpu ${((c.user + c.system) / 1000).toFixed(1).padStart(6)} ms`);
  return v;
}

async function main() {
  const names = new UserNames();
  const core = new CoreCollector();
  const procs = new ProcessCollector();
  const gpu = new GpuCollector();
  const ports = new PortCollector(names.myUid);
  const tmux = new TmuxClient();
  const disks = new DiskCollector(() => ({ excludeFsTypes: [], excludeMounts: [], networkTimeoutMs: 3000 }));
  const docker = new DockerClient();

  console.log('== one-shot cost of each collector');
  await core.sample();
  await procs.scan();
  await sleep(1000);
  const c = await timed('core (/proc x4)', () => core.sample());
  const all = await timed('processes (all users)', () => procs.scan());
  const mine = await timed('processes (mine only)', () => procs.scan(names.myUid));
  await timed('gpu detect', () => gpu.detect());
  const g = await timed('gpu one-shot query', () => gpu.queryOnce());
  const apps = await timed('gpu compute apps', () => gpu.queryApps());
  const p = await timed('ports (ss + inode map)', () => ports.collect());
  await timed('ports (cached map)', () => ports.collect());
  const t = await timed('tmux', () => tmux.list());
  const d = await timed('disks (first)', () => disks.collect());
  await sleep(3500);
  const d2 = await timed('disks (after timeout)', () => disks.collect());
  const dk = await timed('docker', () => docker.list());
  const si = getSysInfo();

  console.log('\n== snapshot');
  console.log(`host ${si.hostname} | ${si.os} | kernel ${si.kernel} | ${si.cpuModel} x${si.cpuCount} | up ${fmt.duration(si.uptime * 1000)} | users ${si.users.length} | wsl=${si.wsl} container=${si.container}`);
  console.log(`cpu ${fmt.pct(c.cpu, 1)} (cores ${c.cores.length}) load ${c.load.map((x) => x.toFixed(2)).join(' ')}`);
  console.log(`mem ${fmt.bytes(c.mem.used)}/${fmt.bytes(c.mem.total)} (${fmt.pct(c.mem.percent, 1)}) cache ${fmt.bytes(c.mem.cache)} swap ${fmt.bytes(c.mem.swapUsed)}/${fmt.bytes(c.mem.swapTotal)}`);
  console.log(`net ↓${fmt.rate(c.rx)} ↑${fmt.rate(c.tx)}  disk r ${fmt.rate(c.diskRead)} w ${fmt.rate(c.diskWrite)}`);
  console.log(`processes: total ${all.total}, scanned ${all.procs.length}, mine ${mine.procs.length}`);
  const top = [...all.procs].sort((a, b) => b.cpu - a.cpu).slice(0, 5);
  for (const x of top) console.log(`  ${String(x.pid).padStart(8)} ${names.name(x.uid).padEnd(10)} ${fmt.pct(x.cpu).padStart(6)} ${fmt.bytes(x.rss).padStart(7)}  ${fmt.truncate(procs.cmdline(x), 70)}`);
  console.log(`gpus: ${g?.gpus.length ?? 0} driver ${gpu.driverVersion} cuda ${await gpu.fetchCudaVersion()}`);
  for (const x of g?.gpus ?? []) console.log(`  #${x.index} ${x.name} ${x.util}% ${fmt.mib(x.memUsed)}/${fmt.mib(x.memTotal)} ${x.temp}°C ${x.power}W`);
  console.log(`gpu apps: ${apps.length}`);
  const users = aggregateUsers(all.procs, apps, g?.gpus ?? []).sort((a, b) => b.cpu - a.cpu).slice(0, 5);
  for (const u of users) console.log(`  ${names.name(u.uid).padEnd(10)} cpu ${fmt.pct(u.cpu)} mem ${fmt.bytes(u.rss)} procs ${u.procs} gpus [${u.gpus}] ${fmt.mib(u.gpuMem)}`);
  const myPorts = p.ports.filter((x) => x.uid === names.myUid);
  console.log(`ports: ${p.ports.length} listening, mine ${myPorts.length}: ${myPorts.map((x) => `${x.port}${x.procName ? '(' + x.procName + ')' : ''}`).join(' ')}`);
  console.log(`tmux: installed=${t.installed} sessions=${t.sessions.map((s) => `${s.name}[${s.windows.length}w]`).join(' ')}`);
  console.log('disks (first pass):', d.mounts.map((m) => `${m.mount}:${m.status}`).join(' '));
  for (const m of d2.mounts) console.log(`  ${m.mount.padEnd(28)} ${m.fstype.padEnd(14)} ${m.status.padEnd(8)} ${m.percent !== undefined ? fmt.pct(m.percent) + ' ' + fmt.bytes(m.used!) + '/' + fmt.bytes(m.total!) : ''}${m.home ? ' (home)' : ''}`);
  console.log(`docker: ${dk.status} ${dk.containers.length} containers`);

  const loop = async (label: string, every: number, secs: number, fn: () => Promise<unknown>) => {
    const c0 = process.cpuUsage();
    const k0 = childTicks();
    const t0 = Date.now();
    while (Date.now() - t0 < secs * 1000) {
      await fn();
      await sleep(every);
    }
    const cu = process.cpuUsage(c0);
    const elapsed = (Date.now() - t0) / 1000;
    const ext = ((cu.user + cu.system) / 1e6 / elapsed) * 100;
    const child = ((childTicks() - k0) / 100 / elapsed) * 100;
    console.log(`  ${label.padEnd(40)} ext ${ext.toFixed(3)}%  children ${child.toFixed(3)}%  of one core`);
  };
  console.log(`\n== steady-state overhead (${seconds}s each)`);
  await loop(`core every ${interval} ms (status bar)`, interval, seconds, () => core.sample());
  let gpuSamples = 0;
  await gpu.start(interval, () => gpuSamples++);
  await loop(`gpu stream every ${interval} ms`, interval, seconds, async () => undefined);
  gpu.stop();
  console.log(`    (${gpuSamples} gpu samples received)`);
  await loop('processes mine-only every 3 s', 3000, seconds, () => procs.scan(names.myUid));
  await loop('processes all users every 5 s', 5000, seconds, () => procs.scan());
  await loop('gpu apps one-shot every 5 s', 5000, seconds, () => gpu.queryApps());
  let appSamples = 0;
  await gpu.startApps(5000, () => appSamples++);
  await loop('gpu apps stream every 5 s', 1000, seconds, async () => undefined);
  gpu.stopApps();
  console.log(`    (${appSamples} app lists received)`);
  await loop('ports every 5 s', 5000, seconds, () => ports.collect());
  await loop('tmux every 3 s', 3000, seconds, () => tmux.list());
  console.log(`  rss ${fmt.bytes(process.memoryUsage().rss)}  heap ${fmt.bytes(process.memoryUsage().heapUsed)}`);
  process.exit(0);
}

void main();
