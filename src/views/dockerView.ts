import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { demandWhileVisible, Monitor } from '../monitor';
import { DockerContainer } from '../collectors/docker';
import { which } from '../util/exec';
import { icon, Node, openTerminal, relTime, showError, TreeProvider } from './common';

export function registerDockerView(ctx: vscode.ExtensionContext, m: Monitor): void {
  const provider = new TreeProvider(() => roots());
  const view = vscode.window.createTreeView('serverMonitor.docker', { treeDataProvider: provider });
  void vscode.commands.executeCommand('setContext', 'serverMonitor.dockerPresent', !!m.dockerC.socketPath);

  const render = () => {
    const d = m.docker.latest;
    if (!m.cfg.dockerEnabled) view.message = l10n.t('Docker view is disabled in settings (serverMonitor.docker.enabled).');
    else if (!d) view.message = l10n.t('Loading…');
    else if (d.status === 'no-socket') view.message = l10n.t('Docker is not running or not installed.');
    else if (d.status === 'no-permission') view.message = l10n.t('No permission to use the Docker socket ({0}). Ask an admin to add you to the "docker" group.', m.dockerC.socketPath ?? '');
    else if (d.status === 'error') view.message = l10n.t('Docker error: {0}', d.error ?? '');
    else view.message = d.containers.length ? undefined : l10n.t('No containers.');
    view.description = d?.status === 'ok' ? l10n.t('{0} running', d.containers.filter((c) => c.state === 'running').length) : undefined;
    provider.refresh();
  };

  function roots(): Node[] {
    if (!m.cfg.dockerEnabled) return [];
    return (m.docker.latest?.containers ?? []).map((c) => {
      const running = c.state === 'running';
      return new Node(c.name, {
        id: `docker:${c.id}`,
        description: [c.image, c.status, c.ports.join(' ')].filter(Boolean).join(' · '),
        icon: icon(running ? 'vm-running' : c.state === 'paused' ? 'debug-pause' : 'vm-outline', running ? 'charts.green' : undefined),
        contextValue: running ? 'container.running' : 'container.stopped',
        tooltip: `${c.id.slice(0, 12)} · ${c.image}\n${c.status} · ${l10n.t('created {0}', relTime(c.created))}`,
        data: c,
      });
    });
  }

  const c = (n?: Node) => n?.data as DockerContainer | undefined;
  const action = (a: 'start' | 'stop' | 'restart') => async (n?: Node) => {
    const x = c(n);
    if (!x) return;
    // The tree view may be hidden (sidebar panel only): show progress in the status bar then.
    const location = view.visible ? { viewId: 'serverMonitor.docker' } : vscode.ProgressLocation.Window;
    await vscode.window.withProgress({ location, title: x.name }, () => m.dockerC.action(x.id, a)).then(() => m.docker.refresh(), showError);
  };
  const cli = () => which('docker') ?? 'docker';

  ctx.subscriptions.push(
    provider,
    view,
    demandWhileVisible(view, 'dockerView', () => (m.cfg.dockerEnabled ? [m.docker] : [])),
    m.docker.onData.event(render),
    m.onConfig.event(render),
    vscode.commands.registerCommand('serverMonitor.docker.start', action('start')),
    vscode.commands.registerCommand('serverMonitor.docker.stop', action('stop')),
    vscode.commands.registerCommand('serverMonitor.docker.restart', action('restart')),
    vscode.commands.registerCommand('serverMonitor.docker.logs', (n?: Node) => {
      const x = c(n);
      if (x) openTerminal(`logs: ${x.name}`, undefined, `${cli()} logs -f --tail 200 ${x.id.slice(0, 12)}`);
    }),
    vscode.commands.registerCommand('serverMonitor.docker.exec', (n?: Node) => {
      const x = c(n);
      if (x) openTerminal(`exec: ${x.name}`, undefined, `${cli()} exec -it ${x.id.slice(0, 12)} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`);
    }),
    vscode.commands.registerCommand('serverMonitor.docker.copyId', (n?: Node) => {
      const x = c(n);
      if (x) void vscode.env.clipboard.writeText(x.id);
    }),
  );
  render();
}
