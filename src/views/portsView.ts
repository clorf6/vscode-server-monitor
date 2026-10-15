import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { demandWhileVisible, Monitor } from '../monitor';
import { browseHost, PortInfo } from '../collectors/ports';
import { icon, Node, TreeProvider } from './common';
import { ProcTarget } from './processView';

/** A bind address reachable from this machine only. */
export const LOCAL_ONLY = (h: string) => h.startsWith('127.') || h === '::1' || h === 'localhost';

export function registerPortsView(ctx: vscode.ExtensionContext, m: Monitor): void {
  const provider = new TreeProvider(() => roots());
  const view = vscode.window.createTreeView('serverMonitor.ports', { treeDataProvider: provider });

  const render = () => {
    const d = m.ports.latest;
    view.message = !d ? l10n.t('Loading…') : !d.supported ? l10n.t('Port list is only available on Linux.') : undefined;
    if (d) view.description = l10n.t('{0} mine · {1} total', d.ports.filter((p) => p.uid === m.names.myUid).length, d.ports.length);
    provider.refresh();
  };

  function roots(): Node[] {
    const ports = m.ports.latest?.ports ?? [];
    const mine = ports.filter((p) => p.uid === m.names.myUid);
    const others = ports.filter((p) => p.uid !== m.names.myUid);
    return [
      new Node(l10n.t('My ports'), { id: 'ports:mine', description: String(mine.length), icon: icon('account'), kids: () => mine.map(portNode), expanded: true }),
      new Node(l10n.t('Other users'), { id: 'ports:others', description: String(others.length), icon: icon('organization'), kids: () => others.map(portNode) }),
    ];
  }

  function portNode(p: PortInfo): Node {
    const mine = p.uid === m.names.myUid;
    const local = p.hosts.every(LOCAL_ONLY);
    const who = mine ? [p.procName ?? '?', p.pid ? `pid ${p.pid}` : ''] : [m.names.name(p.uid)];
    return new Node(`:${p.port}`, {
      id: `port:${p.port}:${p.uid}:${p.pid ?? ''}`,
      description: [...who, p.hosts.join(' ')].filter(Boolean).join(' · '),
      icon: icon(local ? 'lock' : 'globe', mine ? 'charts.blue' : undefined),
      contextValue: mine && p.pid ? 'port.mine' : 'port',
      tooltip: local ? l10n.t('Listening on loopback only — opening it uses VS Code port forwarding.') : l10n.t('Listening on {0}', p.hosts.join(', ')),
      data: p,
    });
  }

  async function url(p: PortInfo): Promise<vscode.Uri> {
    // asExternalUri sets up port forwarding for localhost URLs in SSH/WSL/tunnel/container windows.
    return vscode.env.asExternalUri(vscode.Uri.parse(`http://${browseHost(p)}:${p.port}/`));
  }

  const port = (n?: Node) => n?.data as PortInfo | undefined;

  ctx.subscriptions.push(
    provider,
    view,
    demandWhileVisible(view, 'portsView', () => [m.ports]),
    m.ports.onData.event(render),
    vscode.commands.registerCommand('serverMonitor.port.open', async (n?: Node) => {
      const p = port(n);
      if (p) await vscode.env.openExternal(await url(p));
    }),
    vscode.commands.registerCommand('serverMonitor.port.openInEditor', async (n?: Node) => {
      const p = port(n);
      if (p) await vscode.commands.executeCommand('simpleBrowser.show', (await url(p)).toString());
    }),
    vscode.commands.registerCommand('serverMonitor.port.copyUrl', async (n?: Node) => {
      const p = port(n);
      if (p) await vscode.env.clipboard.writeText(`http://${browseHost(p)}:${p.port}/`);
    }),
    vscode.commands.registerCommand('serverMonitor.port.kill', async (n?: Node) => {
      const p = port(n);
      if (!p?.pid) return;
      const target: ProcTarget = { pid: p.pid, label: `${p.procName ?? '?'} :${p.port}`, mine: true };
      await vscode.commands.executeCommand('serverMonitor.proc.kill', { data: target });
      setTimeout(() => m.ports.refresh(), 800);
    }),
  );
  render();
}
