import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { AlertManager, Watch } from '../alerts';
import { icon, Node, relTime, TreeProvider } from './common';

export function registerWatchesView(ctx: vscode.ExtensionContext, alerts: AlertManager): void {
  const provider = new TreeProvider(() =>
    alerts.watches.map(
      (w) =>
        new Node(w.label, {
          id: `watch:${w.id}`,
          description: `${kindLabel(w)} · ${relTime(w.since)}`,
          icon: icon(w.kind === 'pid' ? 'pulse' : w.kind === 'tmux' ? 'terminal-tmux' : 'circuit-board', 'charts.purple'),
          contextValue: 'watch',
          data: w.id,
        }),
    ),
  );
  const view = vscode.window.createTreeView('serverMonitor.watches', { treeDataProvider: provider });
  const render = () => {
    view.badge = alerts.watches.length ? { value: alerts.watches.length, tooltip: l10n.t('{0} active watches', alerts.watches.length) } : undefined;
    provider.refresh();
  };
  // Keep the "since" times fresh while the view is shown.
  const timer = setInterval(() => view.visible && alerts.watches.length && provider.refresh(), 30_000);

  ctx.subscriptions.push(
    provider,
    view,
    { dispose: () => clearInterval(timer) },
    alerts.onChange.event(render),
    vscode.commands.registerCommand('serverMonitor.watch.remove', (n?: Node) => typeof n?.data === 'string' && alerts.remove(n.data)),
    vscode.commands.registerCommand('serverMonitor.watch.clear', () => alerts.clear()),
  );
  render();
}

function kindLabel(w: Watch): string {
  switch (w.kind) {
    case 'pid':
      return l10n.t('process exit · pid {0}', w.pid);
    case 'tmux':
      return l10n.t('tmux job done');
    case 'gpuFree':
      return l10n.t('GPUs free');
  }
}
