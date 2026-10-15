import * as os from 'os';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { demandWhileVisible, Monitor } from '../monitor';
import { AlertManager } from '../alerts';
import { SHELLS } from '../collectors/tmux';
import { TmuxPane, TmuxSession, TmuxWindow } from '../collectors/parsers';
import { confirm, icon, Node, relTime, showError, tildify, TreeProvider } from './common';

interface TmuxTarget {
  /** tmux target: session id ($1), "$1:2" for a window, or a pane id (%3). */
  target: string;
  session: TmuxSession;
  label: string;
  pane?: TmuxPane;
}

const SCHEME = 'servermon-tmux';

export function registerTmuxView(ctx: vscode.ExtensionContext, m: Monitor, alerts: AlertManager): void {
  const home = os.homedir();
  const provider = new TreeProvider(() => roots());
  const view = vscode.window.createTreeView('serverMonitor.tmux', { treeDataProvider: provider });

  const render = () => {
    const st = m.tmux.latest;
    void vscode.commands.executeCommand('setContext', 'serverMonitor.tmuxInstalled', !!m.tmuxC.binary);
    view.message = !m.tmuxC.binary ? l10n.t('tmux is not installed on this machine.') : !st ? l10n.t('Loading…') : undefined;
    view.description = st?.sessions.length ? l10n.t('{0} sessions', st.sessions.length) : undefined;
    provider.refresh();
  };

  function roots(): Node[] {
    return (m.tmux.latest?.sessions ?? []).map(sessionNode);
  }

  function busy(p: TmuxPane): boolean {
    return !p.dead && !SHELLS.has(p.command);
  }

  function sessionNode(s: TmuxSession): Node {
    const panes = s.windows.flatMap((w) => w.panes);
    const running = panes.filter(busy).length;
    const desc = [l10n.t('{0} windows', s.windows.length), s.attached ? l10n.t('attached') : '', running ? l10n.t('{0} running', running) : l10n.t('idle'), relTime(s.created)].filter(Boolean).join(' · ');
    return new Node(s.name, {
      id: `tmux:${s.id}`,
      description: desc,
      icon: icon('terminal-tmux', s.attached ? 'charts.green' : running ? 'charts.blue' : undefined),
      contextValue: 'tmuxSession',
      data: { target: s.id, session: s, label: s.name } satisfies TmuxTarget,
      kids: () => s.windows.map((w) => windowNode(s, w)),
      expanded: true,
    });
  }

  function windowNode(s: TmuxSession, w: TmuxWindow): Node {
    const label = `${w.index}: ${w.name}${w.active ? ' *' : ''}`;
    if (w.panes.length === 1) {
      // Single-pane windows double as the pane so the tree stays shallow.
      const p = w.panes[0];
      return new Node(label, {
        id: `tmux:${s.id}:${w.index}`,
        description: `${p.command} · ${tildify(p.path, home)}`,
        icon: paneIcon(p),
        contextValue: busy(p) ? 'tmuxPane.busy' : 'tmuxPane',
        data: { target: p.id, session: s, label: `${s.name}:${w.index}`, pane: p } satisfies TmuxTarget,
        command: { command: 'serverMonitor.tmux.peek', title: '', arguments: [{ data: { target: p.id, session: s, label: `${s.name}:${w.index}`, pane: p } }] },
      });
    }
    return new Node(label, {
      id: `tmux:${s.id}:${w.index}`,
      description: l10n.t('{0} panes', w.panes.length),
      icon: icon('window'),
      contextValue: 'tmuxWindow',
      data: { target: `${s.id}:${w.index}`, session: s, label: `${s.name}:${w.index}` } satisfies TmuxTarget,
      kids: () =>
        w.panes.map((p) => {
          const t: TmuxTarget = { target: p.id, session: s, label: `${s.name}:${w.index}.${p.index}`, pane: p };
          return new Node(`${p.index}: ${p.command}${p.active ? ' *' : ''}`, {
            id: `tmux:${p.id}`,
            description: tildify(p.path, home),
            icon: paneIcon(p),
            contextValue: busy(p) ? 'tmuxPane.busy' : 'tmuxPane',
            data: t,
            command: { command: 'serverMonitor.tmux.peek', title: '', arguments: [{ data: t }] },
          });
        }),
      expanded: true,
    });
  }

  function paneIcon(p: TmuxPane): vscode.ThemeIcon {
    if (p.dead) return icon('debug-stop', 'charts.red');
    return busy(p) ? icon('play-circle', 'charts.green') : icon('terminal');
  }

  // Read-only "peek" documents: servermon-tmux:/<label>.log?<pane id>. Refreshed while visible.
  const peekChanged = new vscode.EventEmitter<vscode.Uri>();
  const peekProvider: vscode.TextDocumentContentProvider = {
    onDidChange: peekChanged.event,
    async provideTextDocumentContent(uri) {
      try {
        return await m.tmuxC.capture(decodeURIComponent(uri.query));
      } catch (err) {
        return l10n.t('Cannot capture pane: {0}', String((err as Error).message));
      }
    },
  };
  // Editors showing the end of the pane output keep following it (like `tail -f`); scrolled-up ones stay put.
  const following = new Set<string>();
  const peekTimer = setInterval(() => {
    if (!vscode.window.state.focused) return;
    for (const e of vscode.window.visibleTextEditors) {
      if (e.document.uri.scheme !== SCHEME) continue;
      const last = e.visibleRanges[e.visibleRanges.length - 1];
      if (!last || last.end.line >= e.document.lineCount - 2) following.add(e.document.uri.toString());
      else following.delete(e.document.uri.toString());
      peekChanged.fire(e.document.uri);
    }
  }, 3000);
  const followSub = vscode.workspace.onDidChangeTextDocument((ev) => {
    if (ev.document.uri.scheme !== SCHEME || !following.has(ev.document.uri.toString())) return;
    const end = ev.document.lineCount - 1;
    for (const e of vscode.window.visibleTextEditors) if (e.document === ev.document) e.revealRange(new vscode.Range(end, 0, end, 0), vscode.TextEditorRevealType.Default);
  });

  async function peek(target: string, label: string) {
    const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${label.replace(/[/\\]/g, '_')}.log`, query: encodeURIComponent(target) });
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
    const last = doc.lineCount - 1;
    editor.revealRange(new vscode.Range(last, 0, last, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  const t = (n?: Node) => n?.data as TmuxTarget | undefined;
  const after = () => setTimeout(() => m.tmux.refresh(), 300);

  ctx.subscriptions.push(
    provider,
    view,
    peekChanged,
    { dispose: () => clearInterval(peekTimer) },
    followSub,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, peekProvider),
    demandWhileVisible(view, 'tmuxView', () => (m.tmuxC.binary ? [m.tmux] : [])),
    m.tmux.onData.event(render),

    vscode.commands.registerCommand('serverMonitor.tmux.attach', (n?: Node) => {
      const x = t(n);
      if (!x || !m.tmuxC.binary) return;
      const args = ['attach-session', '-t', x.session.id];
      // Jump to the clicked window/pane after attaching.
      if (x.target !== x.session.id) args.push(';', 'select-window', '-t', x.pane ? x.pane.id : x.target);
      if (x.pane) args.push(';', 'select-pane', '-t', x.pane.id);
      const term = vscode.window.createTerminal({ name: `tmux: ${x.session.name}`, shellPath: m.tmuxC.binary, shellArgs: args, env: { TMUX: null }, iconPath: icon('terminal-tmux') });
      term.show();
    }),
    vscode.commands.registerCommand('serverMonitor.tmux.peek', (n?: { data?: unknown }) => {
      const x = n?.data as TmuxTarget | undefined;
      if (x) void peek(x.pane?.id ?? x.target, x.label);
    }),
    vscode.commands.registerCommand('serverMonitor.tmux.peekTarget', (target: string, label: string) => peek(target, label)),
    vscode.commands.registerCommand('serverMonitor.tmux.refreshPeek', () => {
      const e = vscode.window.activeTextEditor;
      if (e?.document.uri.scheme === SCHEME) peekChanged.fire(e.document.uri);
    }),
    vscode.commands.registerCommand('serverMonitor.tmux.new', async () => {
      if (!m.tmuxC.binary) return;
      const name = await vscode.window.showInputBox({ title: l10n.t('New tmux session'), prompt: l10n.t('Session name'), validateInput: (v) => (!v.trim() ? l10n.t('Name required') : /[.:]/.test(v) ? l10n.t('Name cannot contain "." or ":"') : undefined) });
      if (!name) return;
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.scheme === 'file' ? vscode.workspace.workspaceFolders[0].uri.fsPath : home;
      try {
        await m.tmuxC.newSession(name.trim(), cwd);
        after();
        const attach = l10n.t('Attach');
        if ((await vscode.window.showInformationMessage(l10n.t('Created tmux session "{0}".', name), attach)) === attach) {
          const s = (await m.tmuxC.list()).sessions.find((x) => x.name === name.trim());
          if (s) void vscode.commands.executeCommand('serverMonitor.tmux.attach', { data: { target: s.id, session: s, label: s.name } });
        }
      } catch (err) {
        showError(err);
      }
    }),
    vscode.commands.registerCommand('serverMonitor.tmux.rename', async (n?: Node) => {
      const x = t(n);
      if (!x) return;
      const name = await vscode.window.showInputBox({ title: l10n.t('Rename tmux session'), value: x.session.name });
      if (!name || name === x.session.name) return;
      await m.tmuxC.renameSession(x.session.id, name).then(after, showError);
    }),
    vscode.commands.registerCommand('serverMonitor.tmux.kill', async (n?: Node) => {
      const x = t(n);
      if (!x) return;
      const isSession = x.target === x.session.id;
      const running = isSession ? x.session.windows.flatMap((w) => w.panes).filter(busy).map((p) => p.command) : x.pane && busy(x.pane) ? [x.pane.command] : [];
      const msg = isSession ? l10n.t('Kill tmux session "{0}"?', x.session.name) : l10n.t('Kill {0}?', x.label);
      if (!(await confirm(msg, l10n.t('Kill'), running.length ? l10n.t('Still running: {0}', running.join(', ')) : undefined))) return;
      const p = isSession ? m.tmuxC.killSession(x.session.id) : x.pane ? m.tmuxC.killPane(x.pane.id) : m.tmuxC.killWindow(x.target);
      await p.then(after, showError);
    }),
    vscode.commands.registerCommand('serverMonitor.tmux.ctrlC', async (n?: Node) => {
      const x = t(n);
      if (!x?.pane) return;
      if (!(await confirm(l10n.t('Send Ctrl-C to {0} ({1})?', x.label, x.pane.command), l10n.t('Send Ctrl-C')))) return;
      await m.tmuxC.sendCtrlC(x.pane.id).then(after, showError);
    }),
    vscode.commands.registerCommand('serverMonitor.tmux.watch', (n?: Node) => {
      const x = t(n);
      if (!x?.pane) return;
      if (!busy(x.pane)) return void vscode.window.showInformationMessage(l10n.t('{0} is not running a command right now.', x.label));
      alerts.add({ kind: 'tmux', paneId: x.pane.id, label: `${x.label} (${x.pane.command})` });
    }),
  );
  render();
}
