import * as vscode from 'vscode';
import { Monitor } from './monitor';
import { AlertManager } from './alerts';
import { StatusBar } from './views/statusBar';
import { registerGpuView } from './views/gpuView';
import { registerProcessView } from './views/processView';
import { registerUsersView } from './views/usersView';
import { registerTmuxView } from './views/tmuxView';
import { registerPortsView } from './views/portsView';
import { registerDisksView } from './views/disksView';
import { registerDockerView } from './views/dockerView';
import { registerDuView } from './views/duView';
import { registerWatchesView } from './views/watchesView';
import { registerDashboard } from './views/dashboard';
import { registerTools } from './views/tools';
import { registerOverview } from './views/overview';
import { DuScanner } from './views/duShared';

export function activate(ctx: vscode.ExtensionContext): void {
  const m = new Monitor();
  const alerts = new AlertManager(m, ctx);
  // Folder-size scans and their cache, shared by the panel's folder page and the classic tree view.
  const du = new DuScanner();
  ctx.subscriptions.push(m, alerts, new StatusBar(m), du);

  registerOverview(ctx, m, alerts, du);
  registerGpuView(ctx, m, alerts);
  registerProcessView(ctx, m, alerts);
  registerUsersView(ctx, m);
  registerTmuxView(ctx, m, alerts);
  registerPortsView(ctx, m);
  registerDisksView(ctx, m);
  registerDockerView(ctx, m);
  registerDuView(ctx, m, du);
  registerTools(ctx, m);
  registerWatchesView(ctx, alerts);
  registerDashboard(ctx, m);

  ctx.subscriptions.push(
    vscode.commands.registerCommand('serverMonitor.refresh', () => {
      for (const s of [m.core, m.gpuApps, m.procs, m.ports, m.tmux, m.disks, m.docker]) s.refresh();
    }),
    vscode.commands.registerCommand('serverMonitor.openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${ctx.extension.id}`)),
  );
}

export function deactivate(): void {
  /* everything is disposed through ctx.subscriptions */
}
