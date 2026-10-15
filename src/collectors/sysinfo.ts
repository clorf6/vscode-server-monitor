import * as fs from 'fs';
import * as os from 'os';
import { isLinux } from './core';
import { parseCgroupLimit, parseCpuMax, parseOsRelease, parseUtmpUsers } from './parsers';

export interface SysInfo {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  memTotal: number;
  uptime: number; // seconds
  users: string[];
  wsl: boolean;
  container: boolean;
  cgroupMem?: number;
  cgroupCpus?: number;
}

let staticInfo: Omit<SysInfo, 'uptime' | 'users'> | undefined;

function readText(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}

function cgroupLimits(): { mem?: number; cpus?: number } {
  if (!isLinux) return {};
  const self = readText('/proc/self/cgroup') ?? '';
  const v2 = /^0::(.*)$/m.exec(self)?.[1];
  if (v2 !== undefined) {
    const dir = `/sys/fs/cgroup${v2 === '/' ? '' : v2}`;
    return { mem: parseCgroupLimit(readText(`${dir}/memory.max`) ?? ''), cpus: parseCpuMax(readText(`${dir}/cpu.max`) ?? '') };
  }
  const mem = parseCgroupLimit(readText('/sys/fs/cgroup/memory/memory.limit_in_bytes') ?? '');
  const quota = Number(readText('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'));
  const period = Number(readText('/sys/fs/cgroup/cpu/cpu.cfs_period_us')) || 100000;
  return { mem, cpus: quota > 0 ? quota / period : undefined };
}

export function getSysInfo(): SysInfo {
  if (!staticInfo) {
    const cpus = os.cpus();
    const release = os.release();
    const cg = cgroupLimits();
    const memTotal = os.totalmem();
    const cgroup = readText('/proc/1/cgroup') ?? '';
    staticInfo = {
      hostname: os.hostname(),
      os: (isLinux && parseOsRelease(readText('/etc/os-release') ?? '')) || `${os.type()} ${release}`,
      kernel: release,
      arch: os.arch(),
      cpuModel: (cpus[0]?.model ?? '').replace(/\s+/g, ' ').trim(),
      cpuCount: cpus.length,
      memTotal,
      wsl: /microsoft|wsl/i.test(release),
      container: fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv') || /docker|kubepods|containerd|lxc/.test(cgroup),
      cgroupMem: cg.mem && cg.mem < memTotal ? cg.mem : undefined,
      cgroupCpus: cg.cpus && cg.cpus < cpus.length ? cg.cpus : undefined,
    };
  }
  let users: string[] = [];
  if (isLinux) {
    try {
      users = parseUtmpUsers(fs.readFileSync('/var/run/utmp'));
    } catch {
      /* no utmp in containers */
    }
  }
  return { ...staticInfo, uptime: os.uptime(), users };
}
