import * as fs from 'fs';
import * as os from 'os';
import { parsePasswd } from '../collectors/parsers';
import { run, which } from './exec';

/** uid → user name. Reads /etc/passwd once, then asks `getent` (LDAP/SSSD users) for unknown uids in the background. */
export class UserNames {
  private map = new Map<number, string>();
  private pending = new Set<number>();
  private loadedAt = 0;
  readonly myUid: number;
  readonly myName: string;

  constructor() {
    let uid = -1;
    let name = '';
    try {
      const info = os.userInfo();
      uid = info.uid;
      name = info.username;
    } catch {
      /* no passwd entry for the current uid */
    }
    this.myUid = typeof process.getuid === 'function' ? process.getuid() : uid;
    this.myName = name || String(this.myUid);
    this.reload();
  }

  private reload(): void {
    this.loadedAt = Date.now();
    try {
      for (const [k, v] of parsePasswd(fs.readFileSync('/etc/passwd', 'utf8'))) this.map.set(k, v);
    } catch {
      /* non-Linux */
    }
    if (this.myUid >= 0) this.map.set(this.myUid, this.myName);
  }

  name(uid: number): string {
    const n = this.map.get(uid);
    if (n !== undefined) return n;
    this.resolve(uid);
    return String(uid);
  }

  private resolve(uid: number): void {
    if (this.pending.has(uid) || uid < 0) return;
    this.pending.add(uid);
    if (Date.now() - this.loadedAt > 60_000) this.reload();
    const getent = which('getent');
    if (!getent) return;
    void run(getent, ['passwd', String(uid)], { timeoutMs: 3000 }).then((r) => {
      const name = r.stdout.split(':')[0];
      // Remember failures too so we do not spawn getent on every refresh.
      this.map.set(uid, name || String(uid));
    });
  }
}
