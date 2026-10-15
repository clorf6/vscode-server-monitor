import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { demandWhileVisible, Monitor } from '../monitor';
import { aggregateUsers, UserUsage } from '../collectors/users';
import * as fmt from '../util/format';
import { icon, Node, shortCmd, TreeProvider } from './common';
import { ProcTarget } from './processView';
import { gotoPanel } from './nav';

/** Per-user totals: who is using the CPUs, memory and which GPUs on a shared machine. */
export function registerUsersView(ctx: vscode.ExtensionContext, m: Monitor): void {
  const provider = new TreeProvider(() => roots());
  const view = vscode.window.createTreeView('serverMonitor.users', { treeDataProvider: provider });

  const render = () => {
    const snap = m.procs.latest;
    view.message = snap && !snap.supported ? l10n.t('Per-user usage is only available on Linux.') : !snap || snap.scope !== 'all' ? l10n.t('Loading…') : undefined;
    provider.refresh();
  };

  function roots(): Node[] {
    const snap = m.procs.latest;
    if (!snap?.supported || snap.scope !== 'all') return [];
    const gpus = m.gpu.latest?.gpus ?? [];
    const apps = m.gpuApps.latest ?? [];
    const users = aggregateUsers(snap.procs, apps, gpus)
      .filter((u) => u.cpu >= 0.5 || u.gpus.length || u.uid === m.names.myUid || u.rss > 512 * 1024 * 1024)
      .sort((a, b) => b.gpus.length - a.gpus.length || b.cpu - a.cpu);
    view.description = l10n.t('{0} active', users.length);
    return users.map((u) => userNode(u));
  }

  function userNode(u: UserUsage): Node {
    const name = m.names.name(u.uid);
    const me = u.uid === m.names.myUid;
    const desc = [`CPU ${fmt.pct(u.cpu)}`, fmt.bytes(u.rss), u.gpus.length ? `GPU ${u.gpus.join(',')} (${fmt.mib(u.gpuMem)})` : '', l10n.t('{0} procs', u.procs)].filter(Boolean).join(' · ');
    return new Node(me ? l10n.t('{0} (you)', name) : name, {
      id: `user:${u.uid}`,
      description: desc,
      icon: icon(me ? 'account' : 'person', me ? 'charts.blue' : u.gpus.length ? 'charts.orange' : undefined),
      contextValue: 'user',
      data: name,
      kids: () => {
        const snap = m.procs.latest;
        const procs = (snap?.procs ?? []).filter((p) => p.uid === u.uid).sort((a, b) => b.cpu - a.cpu || b.rss - a.rss).slice(0, 10);
        const gmem = new Map((m.gpuApps.latest ?? []).filter((a) => a.uid === u.uid).map((a) => [a.pid, a]));
        return procs.map((p) => {
          const cmd = m.procC.cmdline(p);
          const g = gmem.get(p.pid);
          return new Node(shortCmd(cmd), {
            id: `user:${u.uid}:${p.pid}`,
            description: [fmt.pct(p.cpu), fmt.bytes(p.rss), g ? `GPU${g.gpuIndex} ${fmt.mib(g.memMiB)}` : '', String(p.pid)].filter(Boolean).join(' · '),
            icon: icon('circle-small'),
            contextValue: me ? 'proc.mine' : 'proc.other',
            tooltip: new vscode.MarkdownString().appendCodeblock(cmd, 'shell'),
            data: { pid: p.pid, label: shortCmd(cmd), mine: me, start: p.start } satisfies ProcTarget,
          });
        });
      },
    });
  }

  ctx.subscriptions.push(
    provider,
    view,
    demandWhileVisible(view, 'usersView', () => [m.procs, m.gpu, m.gpuApps], (v) => m.needAllProcesses('usersView', v)),
    m.procs.onData.event(render),
    vscode.commands.registerCommand('serverMonitor.user.showProcesses', async (n?: Node) => {
      if (typeof n?.data !== 'string') return;
      if (await gotoPanel({ page: 'proc', q: `user:${n.data}`, scope: 'all' })) return;
      await vscode.commands.executeCommand('serverMonitor.processes.focus');
      await vscode.commands.executeCommand('serverMonitor.proc.filter', `user:${n.data}`);
    }),
  );
  render();
}
