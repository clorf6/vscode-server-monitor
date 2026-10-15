// Headless integration run: activates the real views against the mocked `vscode` module on this machine,
// makes every view visible, waits for data and prints what each tree would show.
// Build: esbuild test/harness.ts --bundle --platform=node --alias:vscode=./test/vscode-mock.ts --outfile=out/harness.js
import * as vscode from 'vscode';
import { registry, setVisible } from './vscode-mock';
import { Monitor } from '../src/monitor';
import { AlertManager } from '../src/alerts';
import { StatusBar } from '../src/views/statusBar';
import { registerGpuView } from '../src/views/gpuView';
import { registerProcessView } from '../src/views/processView';
import { registerUsersView } from '../src/views/usersView';
import { registerTmuxView } from '../src/views/tmuxView';
import { registerPortsView } from '../src/views/portsView';
import { registerDisksView } from '../src/views/disksView';
import { registerDockerView } from '../src/views/dockerView';
import { registerDuView } from '../src/views/duView';
import { registerWatchesView } from '../src/views/watchesView';
import { registerOverview } from '../src/views/overview';
import { registerTools } from '../src/views/tools';
import type { Node } from '../src/views/common';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const state = new Map<string, unknown>();
const ctx = {
  subscriptions: [] as { dispose(): unknown }[],
  globalState: { get: (k: string, d: unknown) => (state.has(k) ? state.get(k) : d), update: async (k: string, v: unknown) => void state.set(k, v) },
  extensionUri: vscode.Uri.file(process.cwd()),
} as unknown as vscode.ExtensionContext;

async function dump(id: string, maxRoots = 8, depth = 1) {
  const view = registry.views.get(id);
  const roots: Node[] = (await view.provider.getChildren()) ?? [];
  console.log(`\n[${id}] description=${JSON.stringify(view.description)} message=${JSON.stringify(view.message)} roots=${roots.length}`);
  const walk = async (nodes: Node[], d: number) => {
    for (const n of nodes.slice(0, maxRoots)) {
      const ic = (n.iconPath as { id?: string; color?: { id: string } } | undefined);
      console.log(`${'  '.repeat(d)}- ${typeof n.label === 'string' ? n.label : JSON.stringify(n.label)}  | ${n.description ?? ''}  [${ic?.id ?? ''}${ic?.color ? '/' + ic.color.id : ''}] ctx=${n.contextValue ?? ''}`);
      if (d < depth && n.kids) await walk(await n.kids(), d + 1);
      if (n.resolve && d === 0 && nodes.indexOf(n) === 0) {
        const tip = await n.resolve();
        console.log(`${'  '.repeat(d + 1)}tooltip: ${String(typeof tip === 'string' ? tip : tip?.value).replace(/\n+/g, ' ⏎ ').slice(0, 300)}`);
      }
    }
  };
  await walk(roots, 0);
}

(async () => {
  const c0 = process.cpuUsage();
  // The classic tree views are opt-in since 0.3.0; this run exercises them.
  registry.config['sidebar.showTreeViews'] = true;
  const m = new Monitor();
  const alerts = new AlertManager(m, ctx);
  const sb = new StatusBar(m);
  registerGpuView(ctx, m, alerts);
  registerProcessView(ctx, m, alerts);
  registerUsersView(ctx, m);
  registerTmuxView(ctx, m, alerts);
  registerPortsView(ctx, m);
  registerDisksView(ctx, m);
  registerDockerView(ctx, m);
  registerDuView(ctx, m);
  registerWatchesView(ctx, alerts);
  registerOverview(ctx, m, alerts);
  registerTools(ctx, m);
  console.log(`activation cpu ${((process.cpuUsage(c0).user + process.cpuUsage(c0).system) / 1000).toFixed(1)} ms, commands ${registry.commands.size}`);

  for (const id of ['serverMonitor.gpus', 'serverMonitor.processes', 'serverMonitor.users', 'serverMonitor.tmux', 'serverMonitor.ports', 'serverMonitor.disks', 'serverMonitor.docker']) setVisible(id, true);
  await sleep(7000);

  const item = registry.statusItems[0];
  console.log(`\n[status bar] ${item.text}  bg=${item.backgroundColor?.id ?? '-'}`);
  console.log(String(item.tooltip?.value).slice(0, 1500));

  await dump('serverMonitor.gpus', 10, 1);
  await dump('serverMonitor.processes', 6, 0);
  await vscode.commands.executeCommand('serverMonitor.proc.showAll');
  await vscode.commands.executeCommand('serverMonitor.proc.treeOn');
  await sleep(6500);
  await dump('serverMonitor.processes', 5, 1);
  await vscode.commands.executeCommand('serverMonitor.proc.filter', 'user:root sshd');
  await dump('serverMonitor.processes', 3, 0);
  await vscode.commands.executeCommand('serverMonitor.proc.treeOff');
  await vscode.commands.executeCommand('serverMonitor.proc.showMine');
  await vscode.commands.executeCommand('serverMonitor.proc.clearFilter');
  await dump('serverMonitor.users', 6, 1);
  await dump('serverMonitor.tmux', 5, 2);
  await dump('serverMonitor.ports', 5, 1);
  await dump('serverMonitor.disks', 12, 0);
  await dump('serverMonitor.docker', 5, 0);

  // Folder size: analyze the project directory itself (in the tree: it is enabled and shown).
  setVisible('serverMonitor.du', true);
  await vscode.commands.executeCommand('serverMonitor.du.analyze', process.cwd());
  await dump('serverMonitor.du', 6, 2);

  // Watches: pid watch on a short-lived child, GPU-free watch for 1 GPU.
  const { spawn } = await import('child_process');
  const child = spawn('sleep', ['2']);
  alerts.add({ kind: 'pid', pid: child.pid!, start: m.procC.startTimeOf(child.pid!), label: 'sleep 2' });
  await vscode.commands.executeCommand('serverMonitor.copyFreeGpus');
  await dump('serverMonitor.watches', 5, 0);
  await sleep(8000);
  console.log('\nwatches left:', alerts.watches.length);
  console.log('clipboard:', vscode.env.clipboard as unknown as { text: string });
  console.log('messages:\n  ' + registry.messages.join('\n  '));

  // Hide everything: no source should stay active except alert background demands.
  for (const id of registry.views.keys()) if (registry.views.get(id).visible) setVisible(id, false);
  sb.dispose();
  await sleep(200);
  const active = ['core', 'gpu', 'gpuApps', 'procs', 'ports', 'tmux', 'disks', 'docker'].filter((k) => (m as unknown as Record<string, { active: boolean }>)[k].active);
  console.log('\nactive sources after hiding all views + status bar:', active.join(', ') || 'none', '(core/disks expected: threshold alerts)');
  const c = process.cpuUsage(c0);
  console.log(`total cpu ${((c.user + c.system) / 1000).toFixed(0)} ms`);
  for (const d of ctx.subscriptions) d.dispose();
  alerts.dispose();
  m.dispose();
  process.exit(0);
})();
