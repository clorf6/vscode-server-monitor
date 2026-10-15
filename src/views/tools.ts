import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { Monitor } from '../monitor';
import { QuickCommand } from '../config';
import { ProcInfo } from '../collectors/processes';
import { SHELLS } from '../collectors/tmux';
import * as fmt from '../util/format';
import { pidUid } from '../util/procfs';
import type { Goto } from '../../webview/overview-protocol';
import { confirm, shortCmd, showError } from './common';
import { gotoPanel } from './nav';

export type LocateTarget = { kind: 'proc'; pid: number } | { kind: 'gpu'; index: number } | { kind: 'disk'; mount: string } | { kind: 'mem' };

interface Candidate extends vscode.QuickPickItem {
  pid: number;
  start: number;
  rss: number;
  gpuMiB: number;
}

/** Never offered by "free up": infrastructure the user is relying on right now. */
const KEEP = /(^|\/)(sshd|systemd|dbus-daemon|dbus-broker|ssh-agent|gpg-agent|tmux|screen|pulseaudio|pipewire|wireplumber|at-spi[\w-]*|gvfsd[\w-]*|xdg-[\w-]+)(\s|:|$)/;

/** Locate, "free up resources" and quick commands — the actions behind the overview's buttons. */
export function registerTools(ctx: vscode.ExtensionContext, m: Monitor): void {
  /** Pids of this extension host and everything above it (the VS Code server) — never candidates. */
  function protectedPids(procs: ProcInfo[]): Set<number> {
    const byPid = new Map(procs.map((p) => [p.pid, p]));
    const out = new Set<number>();
    for (let pid: number | undefined = process.pid; pid && pid > 1 && !out.has(pid); pid = byPid.get(pid)?.ppid) out.add(pid);
    // Children of the extension host (our own nvidia-smi, du, ss…) too.
    for (const p of procs) if (p.ppid === process.pid) out.add(p.pid);
    return out;
  }

  async function freeUp() {
    const snap = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: l10n.t('Looking for processes to free…') }, async () => {
      const [procs] = await Promise.all([m.procs.fetch(), m.gpuC.available === false ? undefined : m.gpuApps.fetch()]);
      return procs;
    });
    if (!snap?.supported) return void vscode.window.showWarningMessage(l10n.t('Process list is only available on Linux.'));
    const mine = snap.procs.filter((p) => p.uid === m.names.myUid);
    const keep = protectedPids(mine);
    const gpus = m.gpu.latest?.gpus ?? [];
    const utilOf = new Map(gpus.map((g) => [g.index, g.util]));
    const gpuByPid = new Map<number, { mem: number; idx: number[] }>();
    for (const a of m.gpuApps.latest ?? []) {
      if (a.uid !== m.names.myUid) continue;
      const e = gpuByPid.get(a.pid) ?? { mem: 0, idx: [] };
      e.mem += isFinite(a.memMiB) ? a.memMiB : 0;
      if (a.gpuIndex >= 0) e.idx.push(a.gpuIndex);
      gpuByPid.set(a.pid, e);
    }

    const now = Date.now();
    const items: Candidate[] = [];
    for (const p of mine) {
      if (keep.has(p.pid) || SHELLS.has(p.comm) || p.state === 'Z') continue;
      const cmd = m.procC.cmdline(p);
      if (KEEP.test(cmd) || /\/\.(vscode|cursor|windsurf)-server\//.test(cmd)) continue;
      const g = gpuByPid.get(p.pid);
      const age = now - p.start;
      const reasons: string[] = [];
      let icon = 'circle-small';
      // Busy jobs are never offered: only GPU memory held by an idle process or on an idle GPU.
      const gpuIdle = !!g && g.idx.length > 0 && g.idx.every((i) => (utilOf.get(i) ?? 100) < 5);
      if (g && (gpuIdle || p.cpu < 5)) {
        reasons.push(gpuIdle ? l10n.t('holds {0} of GPU {1} memory while the GPU is idle', fmt.mib(g.mem), g.idx.join(',')) : l10n.t('holds {0} of GPU {1} memory but is idle', fmt.mib(g.mem), g.idx.join(',')));
        icon = 'circuit-board';
      }
      if (p.state === 'T' || p.state === 't') {
        reasons.push(l10n.t('stopped (Ctrl-Z) but still holds {0} of RAM', fmt.bytes(p.rss)));
        icon = 'debug-pause';
      } else if (/ipykernel_launcher|ipykernel|jupyter-kernel/.test(cmd) && p.cpu < 1) {
        reasons.push(l10n.t('idle Jupyter kernel holding {0}', fmt.bytes(p.rss)));
        icon = 'notebook';
      } else if (p.rss >= 1024 ** 3 && p.cpu < 1 && age > 10 * 60_000) {
        reasons.push(l10n.t('idle for a while, holds {0} of RAM', fmt.bytes(p.rss)));
        if (icon === 'circle-small') icon = 'database';
      }
      if (!reasons.length) continue;
      items.push({
        label: `$(${icon}) ${shortCmd(cmd)}`,
        description: [`pid ${p.pid}`, fmt.bytes(p.rss), g ? `GPU ${fmt.mib(g.mem)}` : '', fmt.pct(p.cpu) + ' CPU', l10n.t('running {0}', fmt.duration(age))].filter(Boolean).join(' · '),
        detail: reasons.join('; '),
        pid: p.pid,
        start: p.start,
        rss: p.rss,
        gpuMiB: g?.mem ?? 0,
      });
    }
    if (!items.length) return void vscode.window.showInformationMessage(l10n.t('Nothing obvious to free: none of your processes hold idle GPU memory, are stopped, or sit idle on lots of RAM.'));
    items.sort((a, b) => b.gpuMiB - a.gpuMiB || b.rss - a.rss);

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      title: l10n.t('Free up resources — only your own processes, no sudo'),
      placeHolder: l10n.t('Select processes to terminate (SIGTERM)'),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!picked?.length) return;
    const ram = picked.reduce((a, c) => a + c.rss, 0);
    const vram = picked.reduce((a, c) => a + c.gpuMiB, 0);
    const ok = await confirm(
      l10n.t('Terminate {0} process(es)?', picked.length),
      l10n.t('Terminate'),
      l10n.t('Frees about {0} RAM and {1} GPU memory.', fmt.bytes(ram), fmt.mib(vram)) + '\n\n' + picked.map((c) => `${c.pid}  ${c.label.replace(/^\$\([\w-]+\) /, '')}`).join('\n'),
    );
    if (!ok) return;
    const errors: string[] = [];
    for (const c of picked) {
      try {
        process.kill(c.pid, 'SIGTERM');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') errors.push(`${c.pid}: ${(err as Error).message}`);
      }
    }
    if (errors.length) showError(errors.join('\n'));
    await new Promise((r) => setTimeout(r, 3000));
    const alive = picked.filter((c) => m.procC.isAlive(c.pid, c.start));
    m.procs.refresh();
    m.gpuApps.refresh();
    if (!alive.length) return void vscode.window.showInformationMessage(l10n.t('Done: {0} process(es) exited.', picked.length));
    const force = l10n.t('Force Kill');
    const choice = await vscode.window.showWarningMessage(l10n.t('{0} process(es) are still running after SIGTERM: {1}', alive.length, alive.map((c) => c.pid).join(', ')), force);
    if (choice !== force) return;
    for (const c of alive) {
      try {
        process.kill(c.pid, 'SIGKILL');
      } catch {
        /* exited meanwhile */
      }
    }
  }

  /** Point at something in the sidebar panel; the classic tree views are used only when there is no panel and they are enabled. */
  async function locate(t?: LocateTarget) {
    if (!t || typeof t !== 'object') return;
    let g: Goto | undefined;
    switch (t.kind) {
      case 'proc': {
        if (!Number.isInteger(t.pid) || t.pid <= 0) return;
        const uid = m.procC.cachedUid(t.pid) ?? pidUid(t.pid);
        g = { page: 'proc', q: String(t.pid), scope: uid === undefined || uid === m.names.myUid ? 'mine' : 'all' };
        break;
      }
      case 'mem':
        g = { page: 'proc', q: '', sort: 'mem' };
        break;
      case 'disk':
        g = { page: 'disk', mount: typeof t.mount === 'string' ? t.mount : undefined };
        break;
      case 'gpu':
        g = { page: 'gpu', index: Number.isInteger(t.index) ? t.index : undefined };
        break;
    }
    if (!g || (await gotoPanel(g)) || !m.cfg.sidebarTreeViews) return;
    switch (t.kind) {
      case 'proc':
        await vscode.commands.executeCommand('serverMonitor.processes.focus');
        await vscode.commands.executeCommand('serverMonitor.proc.filter', String(t.pid));
        return;
      case 'mem':
        await vscode.commands.executeCommand('serverMonitor.processes.focus');
        await vscode.commands.executeCommand('serverMonitor.proc.clearFilter');
        await vscode.commands.executeCommand('serverMonitor.proc.sort', 'mem');
        return;
      case 'disk':
        await vscode.commands.executeCommand('serverMonitor.disks.focus');
        return;
      case 'gpu':
        await vscode.commands.executeCommand('serverMonitor.gpus.focus');
        return;
    }
  }

  // ------------------------------------------------------------ quick commands

  async function saveQuick(list: QuickCommand[]) {
    await vscode.workspace.getConfiguration('serverMonitor').update('quickCommands', list, vscode.ConfigurationTarget.Global);
  }

  function runQuick(q: QuickCommand) {
    const term = vscode.window.createTerminal({ name: q.name, iconPath: new vscode.ThemeIcon('zap') });
    term.show();
    term.sendText(q.command);
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand('serverMonitor.freeUp', () => freeUp().catch(showError)),
    vscode.commands.registerCommand('serverMonitor.locate', (t?: LocateTarget) => locate(t).catch(showError)),
    vscode.commands.registerCommand('serverMonitor.quickCommands.run', async (arg?: number | QuickCommand) => {
      const list = m.cfg.quickCommands;
      let q: QuickCommand | undefined = typeof arg === 'number' ? list[arg] : arg && typeof arg === 'object' && typeof arg.command === 'string' ? arg : undefined;
      if (!q) {
        const pick = await vscode.window.showQuickPick(
          [...list.map((x) => ({ label: `$(zap) ${x.name}`, description: x.command, q: x as QuickCommand | undefined })), { label: `$(add) ${l10n.t('Add quick command…')}`, description: '', q: undefined }],
          { title: l10n.t('Run quick command') },
        );
        if (!pick) return;
        if (!pick.q) {
          await vscode.commands.executeCommand('serverMonitor.quickCommands.add');
          return;
        }
        q = pick.q;
      }
      runQuick(q);
    }),
    vscode.commands.registerCommand('serverMonitor.quickCommands.add', async () => {
      const command = await vscode.window.showInputBox({ title: l10n.t('Add quick command (1/2)'), prompt: l10n.t('Command to run in a new terminal'), placeHolder: 'watch -n 1 nvidia-smi', validateInput: (v) => (v.trim() ? undefined : l10n.t('Command required')) });
      if (!command) return;
      const name = await vscode.window.showInputBox({ title: l10n.t('Add quick command (2/2)'), prompt: l10n.t('Name shown on the button'), value: shortCmd(command.trim()).slice(0, 30) });
      if (!name) return;
      await saveQuick([...m.cfg.quickCommands, { name: name.trim(), command: command.trim() }]).catch(showError);
    }),
    vscode.commands.registerCommand('serverMonitor.quickCommands.remove', async (index?: number) => {
      const list = m.cfg.quickCommands;
      if (typeof index !== 'number' || !list[index]) return;
      if (!(await confirm(l10n.t('Remove quick command "{0}"?', list[index].name), l10n.t('Remove')))) return;
      await saveQuick(list.filter((_, i) => i !== index)).catch(showError);
    }),
  );
}
