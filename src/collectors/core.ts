import * as fs from 'fs';
import * as os from 'os';
import { readProc } from '../util/procfs';
import { CpuTimes, cpuPercent, memFromMeminfo, MemSample, parseDiskstats, parseMeminfo, parseNetDev, parseProcStat, physicalBlockDevices } from './parsers';

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
}

/**
 * CPU / memory / network / disk-IO sampler. On Linux this reads four small /proc files per tick and spawns nothing;
 * elsewhere it degrades to Node's `os` module (no network or disk rates).
 */
export class CoreCollector {
  private prevAll?: CpuTimes;
  private prevCores: CpuTimes[] = [];
  private prevNet?: { t: number; rx: number; tx: number };
  private prevDisk?: { t: number; r: number; w: number };
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
    this.prevAll = ps.all;
    this.prevCores = ps.cores;

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

    let rSum = 0;
    let wSum = 0;
    for (const d of parseDiskstats(diskstats, this.physicalDisks())) {
      rSum += d.readBytes;
      wSum += d.writeBytes;
    }
    let diskRead = 0;
    let diskWrite = 0;
    if (this.prevDisk && t > this.prevDisk.t) {
      const dt = (t - this.prevDisk.t) / 1000;
      diskRead = Math.max(0, (rSum - this.prevDisk.r) / dt);
      diskWrite = Math.max(0, (wSum - this.prevDisk.w) / dt);
    }
    this.prevDisk = { t, r: rSum, w: wSum };

    return { t, cpu, cores, load: os.loadavg() as [number, number, number], mem: memFromMeminfo(parseMeminfo(meminfo)), rx, tx, diskRead, diskWrite };
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

  private physicalDisks(): Set<string> {
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
    return { t, cpu, cores, load, mem, rx: 0, tx: 0, diskRead: 0, diskWrite: 0 };
  }
}
