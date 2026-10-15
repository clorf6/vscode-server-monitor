import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { Monitor } from './monitor';
import { SHELLS } from './collectors/tmux';
import { getSysInfo } from './collectors/sysinfo';
import * as fmt from './util/format';

export type Watch =
  | { id: string; kind: 'pid'; pid: number; start?: number; label: string; since: number }
  | { id: string; kind: 'tmux'; paneId: string; label: string; since: number }
  | { id: string; kind: 'gpuFree'; count: number; label: string; since: number };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type WatchInput = DistributiveOmit<Watch, 'id' | 'since'>;

const PID_CHECK_MS = 5000;
const HYSTERESIS = 3; // percentage points below the threshold before a metric can alert again

/**
 * Watchers (process exit, tmux job done, GPUs freed) and threshold alerts. These hold *background* demands so they
 * keep working at the background interval when the window is unfocused.
 */
export class AlertManager implements vscode.Disposable {
  watches: Watch[];
  readonly onChange = new vscode.EventEmitter<void>();
  private readonly key = `watches:${getSysInfo().hostname}`;
  private pidTimer?: NodeJS.Timeout;
  private demands = new Map<string, { dispose(): void }>();
  private subs: { dispose(): void }[] = [];
  private above = new Set<string>(); // threshold keys currently alerted
  private relevance = new Map<string, boolean>();

  constructor(
    private readonly m: Monitor,
    private readonly ctx: vscode.ExtensionContext,
  ) {
    this.watches = ctx.globalState.get<Watch[]>(this.key, []);
    this.subs.push(m.tmux.onData.event(() => this.checkTmux()), m.gpu.onData.event(() => this.checkGpu()), m.core.onData.event(() => this.checkMemory()), m.disks.onData.event(() => this.checkDisks()), m.onConfig.event(() => this.sync()));
    this.sync();
  }

  add(w: WatchInput): void {
    const watch = { ...w, id: `${w.kind}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`, since: Date.now() } as Watch;
    this.watches.push(watch);
    this.sync();
    vscode.window.setStatusBarMessage(`$(bell) ${l10n.t('Watching: {0}', watch.label)}`, 4000);
  }

  remove(id: string): void {
    this.watches = this.watches.filter((w) => w.id !== id);
    this.sync();
  }

  clear(): void {
    this.watches = [];
    this.sync();
  }

  /** Persist watches and hold exactly the background demands they need. */
  private sync(): void {
    void this.ctx.globalState.update(this.key, this.watches);
    const want = new Map<string, () => { dispose(): void }>();
    if (this.watches.some((w) => w.kind === 'tmux')) want.set('tmux', () => this.m.tmux.demand('alerts', 'bg'));
    if (this.watches.some((w) => w.kind === 'gpuFree')) want.set('gpu', () => this.m.gpu.demand('alerts', 'bg'));
    if (this.m.cfg.alertsEnabled) {
      want.set('core', () => this.m.core.demand('alerts', 'bg'));
      want.set('disks', () => this.m.disks.demand('alerts', 'bg'));
    }
    for (const [k, d] of this.demands) if (!want.has(k)) (d.dispose(), this.demands.delete(k));
    for (const [k, make] of want) if (!this.demands.has(k)) this.demands.set(k, make());

    const hasPid = this.watches.some((w) => w.kind === 'pid');
    if (hasPid && !this.pidTimer) this.pidTimer = setInterval(() => this.checkPids(), PID_CHECK_MS);
    if (!hasPid && this.pidTimer) (clearInterval(this.pidTimer), (this.pidTimer = undefined));
    this.onChange.fire();
  }

  private finish(w: Watch, message: string, ...actions: { title: string; run: () => void }[]): void {
    this.watches = this.watches.filter((x) => x.id !== w.id);
    this.sync();
    void vscode.window.showInformationMessage(message, ...actions.map((a) => a.title)).then((choice) => actions.find((a) => a.title === choice)?.run());
  }

  private checkPids(): void {
    for (const w of this.watches) {
      if (w.kind !== 'pid' || this.m.procC.isAlive(w.pid, w.start)) continue;
      const ran = w.start ? fmt.duration(Date.now() - w.start) : undefined;
      this.finish(w, ran ? l10n.t('Process finished: {0} (pid {1}) after {2}', w.label, w.pid, ran) : l10n.t('Process finished: {0} (pid {1})', w.label, w.pid));
    }
  }

  private checkTmux(): void {
    const state = this.m.tmux.latest;
    if (!state) return;
    const panes = new Map(state.sessions.flatMap((s) => s.windows.flatMap((win) => win.panes.map((p) => [p.id, { p, s, win }] as const))));
    for (const w of this.watches) {
      if (w.kind !== 'tmux') continue;
      const hit = panes.get(w.paneId);
      if (hit && !hit.p.dead && !SHELLS.has(hit.p.command)) continue;
      const took = fmt.duration(Date.now() - w.since);
      this.finish(
        w,
        hit ? l10n.t('tmux job finished in {0} (watched for {1})', w.label, took) : l10n.t('tmux pane closed: {0}', w.label),
        ...(hit ? [{ title: l10n.t('Peek output'), run: () => void vscode.commands.executeCommand('serverMonitor.tmux.peekTarget', w.paneId, w.label) }] : []),
      );
    }
  }

  private checkGpu(): void {
    const gpus = this.m.gpu.latest?.gpus;
    if (!gpus) return;
    const free = this.m.freeGpus(gpus);
    for (const w of this.watches) {
      if (w.kind !== 'gpuFree' || free.length < w.count) continue;
      const ids = free.map((g) => g.index).join(',');
      this.finish(w, l10n.t('{0} GPU(s) are free now: {1}', free.length, ids), {
        title: l10n.t('Copy CUDA_VISIBLE_DEVICES'),
        run: () => void vscode.env.clipboard.writeText(`CUDA_VISIBLE_DEVICES=${free.slice(0, Math.max(w.count, 1)).map((g) => g.index).join(',')}`),
      });
    }
  }

  private threshold(key: string, value: number, limit: number, message: () => string): void {
    if (value < limit - HYSTERESIS) {
      this.above.delete(key);
      return;
    }
    if (value < limit || this.above.has(key)) return;
    this.above.add(key);
    const muted = this.ctx.globalState.get<string[]>('mutedAlerts', []);
    if (muted.includes(key)) return;
    const mute = l10n.t("Don't alert again");
    void vscode.window.showWarningMessage(message(), mute).then((c) => {
      if (c === mute) void this.ctx.globalState.update('mutedAlerts', [...new Set([...this.ctx.globalState.get<string[]>('mutedAlerts', []), key])]);
    });
  }

  private checkMemory(): void {
    const c = this.m.core.latest;
    if (!c || !this.m.cfg.alertsEnabled) return;
    this.threshold(`mem:${getSysInfo().hostname}`, c.mem.percent, this.m.cfg.alertMemoryPercent, () =>
      l10n.t('Memory usage is {0} ({1} of {2}).', fmt.pct(c.mem.percent), fmt.bytes(c.mem.used), fmt.bytes(c.mem.total)),
    );
  }

  private checkDisks(): void {
    const d = this.m.disks.latest;
    if (!d || !this.m.cfg.alertsEnabled) return;
    for (const mt of d.mounts) {
      if (mt.percent === undefined || mt.status !== 'ok' || !this.relevantMount(mt.mount, mt.home, mt.network)) continue;
      this.threshold(`disk:${getSysInfo().hostname}:${mt.mount}`, mt.percent, this.m.cfg.alertDiskPercent, () =>
        l10n.t('Disk {0} is {1} full ({2} free).', mt.mount, fmt.pct(mt.percent!), fmt.bytes(mt.avail ?? 0)),
      );
    }
  }

  /**
   * On shared machines most mounts are someone else's problem. Alert only for the home mount, mounts holding an open
   * workspace folder, and mounts with a top-level directory named after the user (e.g. /mnt/disk2/<user>).
   */
  private relevantMount(mount: string, home: boolean, network: boolean): boolean {
    let r = this.relevance.get(mount);
    if (r === undefined) {
      const inside = (p: string) => p === mount || p.startsWith(mount === '/' ? '/' : mount + '/');
      const ws = (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.scheme === 'file' && inside(f.uri.fsPath));
      // Never touch a network filesystem synchronously here: a hung NFS server would freeze the extension host.
      r = home || ws || (!network && mount !== '/' && fs.existsSync(path.join(mount, this.m.names.myName)));
      this.relevance.set(mount, r);
    }
    return r;
  }

  dispose(): void {
    clearInterval(this.pidTimer);
    for (const d of this.demands.values()) d.dispose();
    for (const s of this.subs) s.dispose();
    this.onChange.dispose();
  }
}
