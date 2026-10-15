import * as fs from 'fs';
import * as os from 'os';
import { isLinux } from './core';
import { MountEntry, parseMounts, parseStatF, StatFs, statfsToUsage } from './parsers';
import { runExclusive, which } from '../util/exec';

export type MountStatus = 'ok' | 'timeout' | 'error' | 'pending';

export interface MountUsage extends Partial<StatFs> {
  device: string;
  mount: string;
  fstype: string;
  status: MountStatus;
  network: boolean;
  /** Contains the user's home directory. */
  home: boolean;
}

const PSEUDO = new Set([
  'proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2', 'securityfs', 'pstore', 'bpf', 'debugfs', 'tracefs',
  'configfs', 'fusectl', 'hugetlbfs', 'mqueue', 'autofs', 'squashfs', 'overlay', 'nsfs', 'efivarfs', 'binfmt_misc', 'ramfs',
  'rpc_pipefs', 'nfsd', 'selinuxfs', 'fuse.portal', 'fuse.gvfsd-fuse', 'fuse.lxcfs', 'fuse.snapfuse', 'none', 'devfs', 'iso9660',
]);
const SKIP_PREFIX = ['/proc', '/sys', '/dev', '/run', '/snap', '/var/lib/docker', '/var/lib/containers', '/var/snap', '/boot/efi', '/usr/lib/wsl', '/mnt/wslg', '/mnt/wsl', '/init'];
// Anything that can block indefinitely is queried in a child process, never through libuv's shared thread pool.
const NETWORK = /^(nfs\d?|cifs|smb\d?|smbfs|9p|ceph|glusterfs|lustre|gpfs|beegfs|afs|davfs|fuse\..*|fuseblk|sshfs|ncpfs|drvfs)$/;

const FIRST_WAIT_MS = 400;
const BACKOFF_MIN = 60_000;
const BACKOFF_MAX = 600_000;

export class DiskCollector {
  private readonly stat = which('stat');
  private inflight = new Map<string, Promise<void>>();
  private last = new Map<string, MountUsage>();
  private backoff = new Map<string, { until: number; delay: number }>();
  private readonly home = os.homedir();

  constructor(private readonly opts: () => { excludeFsTypes: string[]; excludeMounts: string[]; networkTimeoutMs: number }) {}

  async collect(): Promise<{ mounts: MountUsage[]; supported: boolean }> {
    if (!isLinux) return { mounts: [], supported: false };
    const text = await fs.promises.readFile('/proc/mounts', 'utf8');
    const list = this.filter(parseMounts(text));
    const homeMount = list
      .filter((m) => this.home === m.mount || this.home.startsWith(m.mount === '/' ? '/' : m.mount + '/'))
      .sort((a, b) => b.mount.length - a.mount.length)[0]?.mount;

    // Wait briefly; anything slower (a hung NFS server) reports its previous state and finishes in the background
    // (the caller re-polls soon while something is pending). Local statfs and healthy NFS answer in a few ms.
    const waits = list.map((m) => this.refresh(m, NETWORK.test(m.fstype)));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(waits), new Promise((r) => (timer = setTimeout(r, FIRST_WAIT_MS)))]);
    clearTimeout(timer);

    const mounts = list.map((m) => {
      const u = this.last.get(m.mount) ?? { ...m, status: 'pending' as MountStatus, network: NETWORK.test(m.fstype), home: false };
      return { ...u, home: m.mount === homeMount };
    });
    return { mounts, supported: true };
  }

  /** Run one statfs for a mount unless one is still outstanding (e.g. stuck on a dead NFS server). */
  private refresh(m: MountEntry, network: boolean): Promise<void> {
    const existing = this.inflight.get(m.mount);
    if (existing) return existing;
    const b = this.backoff.get(m.mount);
    if (b && Date.now() < b.until) return Promise.resolve();

    const p = (async () => {
      let usage: StatFs | undefined;
      let status: MountStatus = 'ok';
      if (network && this.stat) {
        // One `stat` per mount at a time, even after a timeout: a hung mount leaves it in D state (unkillable).
        const r = await runExclusive(`statfs:${m.mount}`, this.stat, ['-f', '-c', '%S %b %f %a', '--', m.mount], { timeoutMs: this.opts().networkTimeoutMs });
        if (r.timedOut) status = 'timeout';
        else if (!(usage = parseStatF(r.stdout))) status = 'error';
      } else {
        try {
          const s = await fs.promises.statfs(m.mount);
          usage = statfsToUsage(s.bsize, s.blocks, s.bfree, s.bavail);
        } catch {
          status = 'error';
        }
      }
      if (status === 'ok') this.backoff.delete(m.mount);
      else {
        const delay = Math.min(BACKOFF_MAX, (b?.delay ?? BACKOFF_MIN / 2) * 2);
        this.backoff.set(m.mount, { until: Date.now() + delay, delay });
      }
      const prev = this.last.get(m.mount);
      // Keep the last known numbers when a refresh fails; the status tells the UI they are stale.
      this.last.set(m.mount, { ...prev, ...m, ...usage, status, network, home: false });
    })().finally(() => this.inflight.delete(m.mount));
    this.inflight.set(m.mount, p);
    return p;
  }

  private filter(all: MountEntry[]): MountEntry[] {
    const o = this.opts();
    const extraTypes = new Set(o.excludeFsTypes);
    const seenDev = new Set<string>();
    const out: MountEntry[] = [];
    for (const m of all) {
      const shm = m.mount === '/dev/shm' && m.fstype === 'tmpfs'; // full /dev/shm kills PyTorch dataloaders: worth showing
      const rootOverlay = m.mount === '/' && m.fstype === 'overlay'; // container root
      if (!shm && !rootOverlay && (PSEUDO.has(m.fstype) || SKIP_PREFIX.some((p) => m.mount === p || m.mount.startsWith(p + '/')))) continue;
      if (extraTypes.has(m.fstype) || o.excludeMounts.some((p) => m.mount === p || m.mount.startsWith(p.replace(/\/$/, '') + '/'))) continue;
      // Bind mounts of the same device: keep the first (usually shortest) path.
      const devKey = m.device.startsWith('/dev/') || NETWORK.test(m.fstype) ? `${m.device}|${m.fstype}` : `${m.device}|${m.mount}`;
      if (seenDev.has(devKey)) continue;
      seenDev.add(devKey);
      out.push(m);
    }
    return out;
  }
}
