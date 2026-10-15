import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { demandWhileVisible, Monitor } from '../monitor';
import { MountUsage } from '../collectors/disks';
import * as fmt from '../util/format';
import { icon, Node, openTerminal, TreeProvider, usageColor } from './common';

export function registerDisksView(ctx: vscode.ExtensionContext, m: Monitor): void {
  const provider = new TreeProvider(() => roots());
  const view = vscode.window.createTreeView('serverMonitor.disks', { treeDataProvider: provider });

  const render = () => {
    const d = m.disks.latest;
    const c = m.core.latest;
    view.message = !d ? l10n.t('Loading…') : !d.supported ? l10n.t('Disk list is only available on Linux.') : undefined;
    view.description = c ? `R ${fmt.rate(c.diskRead)} · W ${fmt.rate(c.diskWrite)}` : undefined;
    provider.refresh();
  };

  function roots(): Node[] {
    // Home disk first, network filesystems last, otherwise by path.
    const rank = (d: MountUsage) => (d.home ? 0 : d.network ? 2 : 1);
    return [...(m.disks.latest?.mounts ?? [])].sort((a, b) => rank(a) - rank(b) || a.mount.localeCompare(b.mount)).map(mountNode);
  }

  function mountNode(d: MountUsage): Node {
    const pct = d.percent;
    let desc: string;
    let ic: vscode.ThemeIcon;
    if (d.status === 'timeout') {
      desc = `${l10n.t('not responding')} · ${d.fstype}`;
      ic = icon('warning', 'charts.yellow');
    } else if (pct === undefined) {
      desc = `${d.status === 'pending' ? '…' : l10n.t('unavailable')} · ${d.fstype}`;
      ic = icon('circle-slash');
    } else {
      desc = `${fmt.pct(pct).padStart(4)} ${fmt.bar(pct, 10)} ${fmt.bytes(d.used ?? 0)}/${fmt.bytes(d.total ?? 0)} · ${d.fstype}`;
      ic = icon(d.home ? 'home' : d.network ? 'cloud' : 'database', usageColor(pct));
    }
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${fmt.escapeMd(d.mount)}**${d.home ? ` · ${l10n.t('home')}` : ''}\n\n`);
    tip.appendMarkdown(`${l10n.t('Device')}: \`${d.device}\` · ${d.fstype}\n\n`);
    if (pct !== undefined) tip.appendMarkdown(`${l10n.t('Used')} ${fmt.bytes(d.used ?? 0)} · ${l10n.t('Free')} ${fmt.bytes(d.avail ?? 0)} · ${l10n.t('Total')} ${fmt.bytes(d.total ?? 0)}\n\n`);
    if (d.status === 'timeout') tip.appendMarkdown(l10n.t('statfs did not answer in time (network filesystem hung?). Retrying with backoff.'));
    return new Node(d.mount, { id: `disk:${d.mount}`, description: desc, icon: ic, contextValue: 'mount', tooltip: tip, data: d });
  }

  const mount = (n?: Node) => n?.data as MountUsage | undefined;

  ctx.subscriptions.push(
    provider,
    view,
    demandWhileVisible(view, 'disksView', () => [m.disks, m.core]),
    m.disks.onData.event(render),
    m.core.onData.event(() => view.visible && render()),
    vscode.commands.registerCommand('serverMonitor.disk.terminal', (n?: Node) => {
      const d = mount(n);
      if (d) openTerminal(d.mount, d.mount);
    }),
    vscode.commands.registerCommand('serverMonitor.disk.copyPath', (n?: Node) => {
      const d = mount(n);
      if (d) void vscode.env.clipboard.writeText(d.mount);
    }),
    vscode.commands.registerCommand('serverMonitor.disk.refresh', () => m.disks.refresh()),
  );
  render();
}
