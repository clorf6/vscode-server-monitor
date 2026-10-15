import * as fs from 'fs';
import { isLinux } from './core';
import { ListenSocket, parseProcNetTcp, parseSsListen } from './parsers';
import { run, which } from '../util/exec';
import { listPids, pidUid } from '../util/procfs';

export interface PortInfo {
  port: number;
  hosts: string[]; // bind addresses, e.g. ["0.0.0.0", "::"]
  uid: number;
  pid?: number;
  procName?: string;
}

/** Owners (uid/inode) are re-read at least this often even when the set of listening addresses looks unchanged. */
const OWNER_REFRESH_MS = 60_000;
/** A socket of ours whose owning process we could not find (other mount/pid namespace) is not searched again sooner. */
const UNRESOLVED_RETRY_MS = 60_000;

export interface PortCollectorDeps {
  /** pids owned by `uid` from a recent /proc listing, if the caller has one (saves listing + stat()ing all of /proc). */
  pidsOf?: (uid: number) => number[] | undefined;
  /** Cached owner of a pid, if known. */
  uidOf?: (pid: number) => number | undefined;
}

/**
 * Listening TCP ports. `ss -tlnH` uses netlink with a state filter, which is far cheaper than reading /proc/net/tcp6 on
 * busy hosts (thousands of sockets). Socket owners need `-e`, which also makes ss resolve every socket's cgroup by
 * walking the whole cgroup2 tree (~10k fstatat, 2/3 of its cost), so owners are fetched only when the set of listening
 * addresses changed, one of our owning processes went away, or once a minute.
 * Owning pids can only be resolved for our own processes (fd links of other users are unreadable), so we map socket
 * inodes → pid by scanning just our own /proc/<pid>/fd directories.
 */
export class PortCollector {
  private readonly ss = which('ss', ['/usr/sbin/ss', '/sbin/ss']);
  private inodeToPid = new Map<number, number>();
  /** Last `ss -e` result, and the address set it was taken for. */
  private owners?: { sockets: ListenSocket[]; sig: string; at: number };
  private unresolved = new Map<number, number>(); // inode → time we gave up on it
  /** Counters for the overhead script. */
  readonly stats = { cheap: 0, full: 0, inodeScans: 0 };

  constructor(
    private readonly myUid: number,
    private readonly deps: PortCollectorDeps = {},
  ) {}

  async collect(): Promise<{ ports: PortInfo[]; supported: boolean }> {
    if (!isLinux) return { ports: [], supported: false };
    const sockets = await this.listen();

    const now = Date.now();
    const mine = sockets.filter((s) => s.uid === this.myUid && s.inode);
    const missing = mine.filter((s) => !this.inodeToPid.has(s.inode) && !(now - (this.unresolved.get(s.inode) ?? -Infinity) < UNRESOLVED_RETRY_MS));
    if (missing.length) {
      await this.rebuildInodeMap();
      for (const s of missing) if (!this.inodeToPid.has(s.inode)) this.unresolved.set(s.inode, now);
    }
    if (this.unresolved.size > 256) for (const [ino, at] of this.unresolved) if (now - at >= UNRESOLVED_RETRY_MS) this.unresolved.delete(ino);

    const byKey = new Map<string, PortInfo>();
    for (const s of sockets) {
      const pid = s.uid === this.myUid ? this.inodeToPid.get(s.inode) : undefined;
      const key = `${s.port}/${s.uid}/${pid ?? ''}`;
      let p = byKey.get(key);
      if (!p) {
        p = { port: s.port, hosts: [], uid: s.uid, pid };
        byKey.set(key, p);
      }
      if (!p.hosts.includes(s.host)) p.hosts.push(s.host);
    }
    const ports = [...byKey.values()].sort((a, b) => a.port - b.port);
    for (const p of ports) if (p.pid) p.procName = readComm(p.pid);
    return { ports, supported: true };
  }

  private async listen(): Promise<ListenSocket[]> {
    if (this.ss) {
      const o = this.owners;
      if (o && Date.now() - o.at < OWNER_REFRESH_MS) {
        this.stats.cheap++;
        const r = await run(this.ss, ['-tlnH'], { timeoutMs: 5000 });
        if (r.code === 0 && listenSignature(parseSsListen(r.stdout)) === o.sig && this.ownersAlive(o.sockets)) return o.sockets;
      }
      this.stats.full++;
      const r = await run(this.ss, ['-tlnHe'], { timeoutMs: 5000 });
      if (r.code === 0 && r.stdout) {
        const sockets = parseSsListen(r.stdout);
        this.owners = { sockets, sig: listenSignature(sockets), at: Date.now() };
        return sockets;
      }
    }
    const [v4, v6] = await Promise.all([
      fs.promises.readFile('/proc/net/tcp', 'utf8').catch(() => ''),
      fs.promises.readFile('/proc/net/tcp6', 'utf8').catch(() => ''),
    ]);
    return [...parseProcNetTcp(v4, 4), ...parseProcNetTcp(v6, 6)];
  }

  /** Our sockets' owning processes still exist (a restarted server re-binding the same port has a new pid). */
  private ownersAlive(sockets: ListenSocket[]): boolean {
    for (const s of sockets) {
      if (s.uid !== this.myUid) continue;
      const pid = this.inodeToPid.get(s.inode);
      if (pid !== undefined && pidUid(pid) === undefined) return false;
    }
    return true;
  }

  private async rebuildInodeMap(): Promise<void> {
    this.stats.inodeScans++;
    const map = new Map<number, number>();
    let pids = this.deps.pidsOf?.(this.myUid);
    let filtered = !!pids;
    if (!pids) {
      pids = await listPids();
      filtered = false;
    }
    let n = 0;
    for (const pid of pids) {
      if (++n % 256 === 0) await new Promise((r) => setImmediate(r));
      if (!filtered) {
        const uid = this.deps.uidOf?.(pid) ?? pidUid(pid);
        if (uid !== this.myUid) continue;
      }
      let fds: string[];
      try {
        fds = fs.readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue; // exited or not ours
      }
      for (const fd of fds) {
        let link: string;
        try {
          link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue; // fd closed meanwhile
        }
        if (link.startsWith('socket:[')) {
          const inode = Number(link.slice(8, -1));
          if (!map.has(inode)) map.set(inode, pid);
        }
      }
    }
    this.inodeToPid = map;
  }
}

/** Identity of a listening set: the bound addresses, ignoring queue counters and ordering. */
export function listenSignature(sockets: ListenSocket[]): string {
  return sockets
    .map((s) => `${s.host}|${s.port}`)
    .sort()
    .join(',');
}

function readComm(pid: number): string | undefined {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** Host to put in a browser URL for a listening socket. */
export function browseHost(p: PortInfo): string {
  const h = p.hosts.find((x) => x === '0.0.0.0' || x === '::' || x.startsWith('127.') || x === '::1');
  return h || !p.hosts.length ? 'localhost' : p.hosts[0].includes(':') ? `[${p.hosts[0]}]` : p.hosts[0];
}
