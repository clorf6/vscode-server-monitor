import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { GLANCE, Monitor } from '../monitor';
import { getSysInfo } from '../collectors/sysinfo';
import * as fmt from '../util/format';
import { remoteLabel } from '../util/remote';

/** One compact status bar entry; its tooltip is a full summary table. */
export class StatusBar implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem('serverMonitor.status', vscode.StatusBarAlignment.Right, 100);
  private demands: { dispose(): void }[] = [];
  private subs: vscode.Disposable[] = [];

  constructor(private readonly m: Monitor) {
    this.item.name = l10n.t('Server Monitor');
    this.item.command = 'serverMonitor.openDashboard';
    const render = () => this.render();
    this.subs.push(
      m.core.onData.event(render),
      m.gpu.onData.event(render),
      m.disks.onData.event(render),
      m.onConfig.event(() => this.configure()),
    );
    this.configure();
  }

  private configure(): void {
    for (const d of this.demands) d.dispose();
    this.demands = [];
    const c = this.m.cfg;
    if (!c.statusBarEnabled) {
      this.item.hide();
      return;
    }
    const items = new Set(c.statusBarItems);
    // A glance: 5 s is plenty on its own; visible views and the dashboard still get the base interval.
    this.demands.push(this.m.core.demand('statusBar', 'fg', GLANCE));
    if (items.has('gpu') || items.has('gpuMem')) this.demands.push(this.m.gpu.demand('statusBar', 'fg', GLANCE));
    if (items.has('disk')) this.demands.push(this.m.disks.demand('statusBar'));
    this.item.text = '$(pulse) …';
    this.item.show();
    this.render();
  }

  private render(): void {
    const c = this.m.cfg;
    if (!c.statusBarEnabled) return;
    const core = this.m.core.latest;
    const gpus = this.m.gpu.latest?.gpus;
    const home = this.m.disks.latest?.mounts.find((x) => x.home);
    const parts: string[] = [];
    for (const it of c.statusBarItems) {
      if (it === 'cpu' && core) parts.push(`CPU ${fmt.pct(core.cpu)}`);
      else if (it === 'mem' && core) parts.push(`${l10n.t('MEM')} ${fmt.pct(core.mem.percent)}`);
      else if (it === 'load' && core) parts.push(`${l10n.t('LOAD')} ${core.load[0].toFixed(1)}`);
      else if (it === 'gpu' && gpus?.length) parts.push(l10n.t('GPU {0}/{1} free', this.m.freeGpus(gpus).length, gpus.length));
      else if (it === 'gpuMem' && gpus?.length) {
        const used = gpus.reduce((a, g) => a + (g.memUsed || 0), 0);
        const total = gpus.reduce((a, g) => a + (g.memTotal || 0), 0);
        parts.push(`${l10n.t('VRAM')} ${fmt.pct(total ? (used / total) * 100 : 0)}`);
      } else if (it === 'net' && core) parts.push(`↓${fmt.bytes(core.rx)} ↑${fmt.bytes(core.tx)}`);
      else if (it === 'disk' && home?.percent !== undefined) parts.push(`${l10n.t('DISK')} ${fmt.pct(home.percent)}`);
    }
    this.item.text = parts.length ? `$(pulse) ${parts.join('  ')}` : '$(pulse) …';

    let level = 0;
    const check = (p: number | undefined) => {
      if (p === undefined) return;
      if (p >= c.critPercent) level = 2;
      else if (p >= c.warnPercent) level = Math.max(level, 1);
    };
    // CPU at 100% is normal on a compute server; memory and the home disk filling up are what bite.
    if (core) check(core.mem.percent);
    if (home) check(home.percent);
    this.item.backgroundColor = level === 2 ? new vscode.ThemeColor('statusBarItem.errorBackground') : level === 1 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.tooltip = this.tooltip();
  }

  private tooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['serverMonitor.openDashboard', 'serverMonitor.copyFreeGpus', 'serverMonitor.freeUp'] };
    const si = getSysInfo();
    const core = this.m.core.latest;
    md.appendMarkdown(`**${fmt.escapeMd(si.hostname)}** · ${fmt.escapeMd(remoteLabel())} · ${l10n.t('up {0}', fmt.duration(si.uptime * 1000))}\n\n`);
    if (core) {
      md.appendMarkdown(`$(pulse) CPU **${fmt.pct(core.cpu, 1)}** · ${l10n.t('load')} ${core.load.map((x) => x.toFixed(1)).join(' / ')} · ${l10n.t('{0} cores', core.cores.length)}\n\n`);
      md.appendMarkdown(
        `$(server) ${l10n.t('Memory')} **${fmt.bytes(core.mem.used)} / ${fmt.bytes(core.mem.total)}** (${fmt.pct(core.mem.percent)})` +
          (core.mem.swapTotal ? ` · swap ${fmt.bytes(core.mem.swapUsed)} / ${fmt.bytes(core.mem.swapTotal)}` : '') +
          '\n\n',
      );
      md.appendMarkdown(`$(arrow-swap) ${l10n.t('Network')} ↓${fmt.rate(core.rx)} ↑${fmt.rate(core.tx)} · ${l10n.t('Disk IO')} R ${fmt.rate(core.diskRead)} W ${fmt.rate(core.diskWrite)}\n\n`);
    }
    const home = this.m.disks.latest?.mounts.find((x) => x.home);
    if (home?.percent !== undefined) md.appendMarkdown(`$(database) ${l10n.t('Home disk')} \`${fmt.escapeMd(home.mount)}\` ${fmt.pct(home.percent)} · ${l10n.t('{0} free', fmt.bytes(home.avail ?? 0))}\n\n`);

    const gpus = this.m.gpu.latest?.gpus;
    if (gpus?.length) {
      // Owner names only if some other consumer refreshed them recently; the status bar alone never spawns that query.
      const apps = Date.now() - this.m.gpuApps.updatedAt < 30_000 ? this.m.gpuApps.latest ?? [] : [];
      md.appendMarkdown(`| GPU | ${l10n.t('Util')} | ${l10n.t('GPU memory')} | ${l10n.t('Temp')} | ${l10n.t('Power')} |${apps.length ? ` ${l10n.t('Users')} |` : ''}\n`);
      md.appendMarkdown(`|:--|--:|--:|--:|--:|${apps.length ? ':--|' : ''}\n`);
      const free = new Set(this.m.freeGpus(gpus).map((g) => g.index));
      for (const g of gpus) {
        const users = [...new Set(apps.filter((a) => a.gpuIndex === g.index).map((a) => a.user))].join(', ');
        md.appendMarkdown(
          `| ${free.has(g.index) ? '$(circle-large-outline)' : '$(circle-large-filled)'} ${g.index} ${fmt.escapeMd(g.name)} | ${fmt.pct(g.util)} | ${fmt.mib(g.memUsed)} / ${fmt.mib(g.memTotal)} | ${isNaN(g.temp) ? '–' : g.temp + '°C'} | ${isNaN(g.power) ? '–' : Math.round(g.power) + 'W'} |${apps.length ? ` ${fmt.escapeMd(users)} |` : ''}\n`,
        );
      }
      md.appendMarkdown('\n');
      if (free.size) md.appendMarkdown(`[$(copy) ${l10n.t('Copy CUDA_VISIBLE_DEVICES for free GPUs')}](command:serverMonitor.copyFreeGpus) · `);
    }
    md.appendMarkdown(`[$(dashboard) ${l10n.t('Open dashboard')}](command:serverMonitor.openDashboard) · [$(sparkle) ${l10n.t('Free up resources…')}](command:serverMonitor.freeUp)`);
    return md;
  }

  dispose(): void {
    for (const d of this.demands) d.dispose();
    for (const s of this.subs) s.dispose();
    this.item.dispose();
  }
}
