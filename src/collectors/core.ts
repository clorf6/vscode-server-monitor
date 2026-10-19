import * as fs from 'fs';
import * as os from 'os';
import { readProc } from '../util/procfs';
import { CpuSplit, cpuSplitPercent, CpuTimes, cpuPercent, DiskCounter, DiskRate, diskRates, memFromMeminfo, MemSample, parseDiskstats, parseMeminfo, parseNetDev, parsePressure, parseProcStat, parseVmstat, physicalBlockDevices, Pressure } from './parsers';
import { Sensors, Temps } from './sensors';

export const isLinux = process.platform === 'linux';

export interface CoreSample {
  t: number;
  cpu: number; // %
  cores: number[]; // % per logical core
  load: [number, number, number];
  mem: MemSample;
  /** Bytes/s summed over physical (non-virtual) interfaces. */
  rx: number;
  tx: number;
  /** Bytes/s summed over physical disks. */
  diskRead: number;
  diskWrite: number;
  /** Where CPU time went, % of all CPU time (from the second sample on). */
  split?: { user: number; system: number; iowait: number; steal: number };
  /** Per physical disk: busy %, throughput, IOPS, latency (from the second sample on). */
  disks: DiskRate[];
  /** Stall pressure (/proc/pressure, Linux 4.20+): % of the last 10 s that tasks waited for CPU, memory or I/O. */
  psi?: { cpu?: Pressure; mem?: Pressure; io?: Pressure };
  /** Swap-in / swap-out, bytes/s. */
  swapIn: number;
  swapOut: number;
  /** Processes the kernel's OOM killer has killed since boot (counter; absent on kernels before 4.13). */
  oomKills?: number;
  temps: Temps;
}

const PAGE = 4096;
const VMSTAT_KEYS = ['pswpin', 'pswpout', 'oom_kill'] as const;

/**
 * CPU / memory / network / disk-IO sampler. On Linux this reads four small /proc files per tick and spawns nothing;
 * elsewhere it degrades to Node's `os` module (no network or disk rates).
 */
export class CoreCollector {
  private prevAll?: CpuTimes;
  private prevCores: CpuTimes[] = [];
  private prevNet?: { t: number; rx: number; tx: number };
  private prevDisk?: { t: number; devs: Map<string, DiskCounter> };
  private prevSplit?: CpuSplit;
  private prevVm?: { t: number; in: number; out: number };
  /** /proc/pressure exists and is readable (false once a read failed: PSI disabled at boot). */
  private psi = true;
  private readonly sensors = new Sensors();
  private ifaceVirtual = new Map<string, boolean>();
  private blockDevs?: Set<string>;
  private blockDevsAt = 0;
  private sampledAt = 0;
  btime = 0;

  async sample(): Promise<CoreSample> {
    const s = isLinux ? this.sampleLinux() : this.sampleGeneric();
    this.sampledAt = Date.now();
    return s;
  }

  /**
   * A previous sample at most `maxAgeMs` old exists, so the next sample's rates are valid (averaged since then) and the
   * scheduler can publish it at once instead of taking a fresh baseline first.
   */
  hasBaseline(maxAgeMs = 60_000): boolean {
    return this.prevAll !== undefined && Date.now() - this.sampledAt <= maxAgeMs;
  }

  private sampleLinux(): CoreSample {
    const t = Date.now();
    const stat = readProc('/proc/stat');
    const meminfo = readProc('/proc/meminfo');
    if (stat === undefined || meminfo === undefined) throw new Error('/proc is not readable');
    const netdev = readProc('/proc/net/dev') ?? '';
    const diskstats = readProc('/proc/diskstats') ?? '';

    const ps = parseProcStat(stat);
    this.btime = ps.btime;
    const cpu = cpuPercent(this.prevAll, ps.all);
    const cores = ps.cores.map((c, i) => cpuPercent(this.prevCores[i], c));
    const split = cpuSplitPercent(this.prevSplit, ps.split);
    this.prevAll = ps.all;
    this.prevCores = ps.cores;
    this.prevSplit = ps.split;

    let rxSum = 0;
    let txSum = 0;
    const counters = parseNetDev(netdev).filter((c) => c.iface !== 'lo');
    const physical = counters.filter((c) => !this.isVirtualIface(c.iface));
    // In containers every interface is a veth; fall back to counting all of them.
    for (const c of physical.length ? physical : counters) {
      rxSum += c.rx;
      txSum += c.tx;
    }
    let rx = 0;
    let tx = 0;
    if (this.prevNet && t > this.prevNet.t) {
      const dt = (t - this.prevNet.t) / 1000;
      rx = Math.max(0, (rxSum - this.prevNet.rx) / dt);
      tx = Math.max(0, (txSum - this.prevNet.tx) / dt);
    }
    this.prevNet = { t, rx: rxSum, tx: txSum };

    const devs = new Map(parseDiskstats(diskstats, this.physicalDisks()).map((d) => [d.dev, d]));
    const disks: DiskRate[] = [];
    let diskRead = 0;
    let diskWrite = 0;
    if (this.prevDisk && t > this.prevDisk.t) {
      for (const [dev, cur] of devs) {
        const prev = this.prevDisk.devs.get(dev);
        if (!prev) continue;
        const r = diskRates(prev, cur, t - this.prevDisk.t);
        disks.push(r);
        diskRead += r.rBps;
        diskWrite += r.wBps;
      }
    }
    this.prevDisk = { t, devs };

    // swap traffic and OOM kills
    let swapIn = 0;
    let swapOut = 0;
    let oomKills: number | undefined;
    const vmText = readProc('/proc/vmstat');
    if (vmText) {
      const vm = parseVmstat(vmText, VMSTAT_KEYS);
      if (this.prevVm && t > this.prevVm.t) {
        const dt = (t - this.prevVm.t) / 1000;
        swapIn = Math.max(0, ((vm.pswpin ?? 0) - this.prevVm.in) / dt) * PAGE;
        swapOut = Math.max(0, ((vm.pswpout ?? 0) - this.prevVm.out) / dt) * PAGE;
      }
      this.prevVm = { t, in: vm.pswpin ?? 0, out: vm.pswpout ?? 0 };
      oomKills = vm.oom_kill;
    }

    let psi: CoreSample['psi'];
    if (this.psi) {
      const rd = (r: string) => {
        const txt = readProc(`/proc/pressure/${r}`);
        return txt === undefined ? undefined : parsePressure(txt);
      };
      psi = { cpu: rd('cpu'), mem: rd('memory'), io: rd('io') };
      if (!psi.cpu && !psi.mem && !psi.io) (this.psi = false), (psi = undefined);
    }

    return {
      t,
      cpu,
      cores,
      load: os.loadavg() as [number, number, number],
      mem: memFromMeminfo(parseMeminfo(meminfo)),
      rx,
      tx,
      diskRead,
      diskWrite,
      split,
      disks,
      psi,
      swapIn,
      swapOut,
      oomKills,
      temps: this.sensors.read(),
    };
  }

  private isVirtualIface(iface: string): boolean {
    let v = this.ifaceVirtual.get(iface);
    if (v === undefined) {
      try {
        v = fs.readlinkSync(`/sys/class/net/${iface}`).includes('/virtual/');
      } catch {
        v = false;
      }
      this.ifaceVirtual.set(iface, v);
    }
    return v;
  }

  /** Whole physical disks (names in /sys/block), refreshed every minute. */
  physicalDisks(): Set<string> {
    if (!this.blockDevs || Date.now() - this.blockDevsAt > 60_000) {
      try {
        this.blockDevs = physicalBlockDevices(fs.readdirSync('/sys/block'));
      } catch {
        this.blockDevs = new Set();
      }
      this.blockDevsAt = Date.now();
    }
    return this.blockDevs;
  }

  private sampleGeneric(): CoreSample {
    const t = Date.now();
    const cpus = os.cpus();
    const curCores: CpuTimes[] = cpus.map((c) => {
      const total = c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
      return { idle: c.times.idle, total };
    });
    const all = curCores.reduce((a, c) => ({ idle: a.idle + c.idle, total: a.total + c.total }), { idle: 0, total: 0 });
    const cpu = cpuPercent(this.prevAll, all);
    const cores = curCores.map((c, i) => cpuPercent(this.prevCores[i], c));
    this.prevAll = all;
    this.prevCores = curCores;
    const total = os.totalmem();
    const free = os.freemem();
    const mem: MemSample = { total, used: total - free, available: free, free, cache: 0, shared: 0, swapTotal: 0, swapUsed: 0, percent: total ? ((total - free) / total) * 100 : 0 };
    const load = (process.platform === 'win32' ? [0, 0, 0] : os.loadavg()) as [number, number, number];
    return { t, cpu, cores, load, mem, rx: 0, tx: 0, diskRead: 0, diskWrite: 0, disks: [], swapIn: 0, swapOut: 0, temps: { disks: {} } };
  }
}
