import * as os from 'os';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { demandWhileVisible, Monitor } from '../monitor';
import { AlertManager } from '../alerts';
import { ProcInfo } from '../collectors/processes';
import * as fmt from '../util/format';
import { confirm, icon, Node, openTerminal, relTime, shortCmd, showError, signalProcess, tildify, TreeProvider } from './common';

/** Payload of every node that represents a process (process, GPU and user views). */
export interface ProcTarget {
  pid: number;
  label: string;
  mine: boolean;
  start?: number;
}

type SortKey = 'cpu' | 'mem' | 'gpu' | 'time' | 'pid';

export function registerProcessView(ctx: vscode.ExtensionContext, m: Monitor, alerts: AlertManager): void {
  let scope: 'mine' | 'all' = m.cfg.processScope;
  let sort: SortKey = 'cpu';
  let filter = '';
  let tree = false;
  let limit = m.cfg.processLimit;
  let visible = false;
  const home = os.homedir();

  const provider = new TreeProvider(() => roots());
  const view = vscode.window.createTreeView('serverMonitor.processes', { treeDataProvider: provider });

  const setContext = () => {
    void vscode.commands.executeCommand('setContext', 'serverMonitor.procScope', scope);
    void vscode.commands.executeCommand('setContext', 'serverMonitor.procTree', tree);
    void vscode.commands.executeCommand('setContext', 'serverMonitor.procFiltered', !!filter);
    m.needAllProcesses('processView', visible && scope === 'all');
  };

  const sortLabel: Record<SortKey, string> = { cpu: 'CPU', mem: l10n.t('Memory'), gpu: l10n.t('GPU memory'), time: l10n.t('Start time'), pid: 'PID' };

  const render = () => {
    const snap = m.procs.latest;
    if (!snap) view.message = l10n.t('Loading…');
    else if (!snap.supported) view.message = l10n.t('Process list is only available on Linux.');
    else view.message = filter ? l10n.t('Filter: {0}', filter) : undefined;
    provider.refresh();
  };

  function gpuMemByPid(): Map<number, number> {
    const out = new Map<number, number>();
    if (Date.now() - m.gpuApps.updatedAt > 30_000) return out;
    for (const a of m.gpuApps.latest ?? []) if (isFinite(a.memMiB)) out.set(a.pid, (out.get(a.pid) ?? 0) + a.memMiB);
    return out;
  }

  function matches(p: ProcInfo, f: string): boolean {
    if (!f) return true;
    const terms = f.toLowerCase().split(/\s+/).filter(Boolean);
    return terms.every((t) => {
      if (t.startsWith('user:')) return m.names.name(p.uid).toLowerCase() === t.slice(5);
      return String(p.pid) === t || p.comm.toLowerCase().includes(t) || m.procC.cmdline(p).toLowerCase().includes(t) || m.names.name(p.uid).toLowerCase() === t;
    });
  }

  function roots(): Node[] {
    const snap = m.procs.latest;
    if (!snap?.supported) return [];
    // A scan in "mine" scope cannot serve the "all" view until the next scan arrives (and vice versa it is a superset).
    let procs = snap.procs;
    if (scope === 'mine' || snap.scope === 'mine') procs = procs.filter((p) => p.uid === m.names.myUid);
    procs = procs.filter((p) => p.pid !== process.pid && matches(p, filter));
    const scopeText = scope === 'mine' ? l10n.t('mine') : l10n.t('all users');
    view.description = `${scopeText} · ${sortLabel[sort]}↓ · ${procs.length}/${snap.total}`;
    const gmem = gpuMemByPid();
    const key = (p: ProcInfo): number => (sort === 'cpu' ? p.cpu : sort === 'mem' ? p.rss : sort === 'gpu' ? (gmem.get(p.pid) ?? 0) : sort === 'time' ? p.start : -p.pid);
    const cmp = (a: ProcInfo, b: ProcInfo) => key(b) - key(a) || b.rss - a.rss;

    if (tree) {
      const byPid = new Map(procs.map((p) => [p.pid, p]));
      const children = new Map<number, ProcInfo[]>();
      const top: ProcInfo[] = [];
      for (const p of procs) {
        if (byPid.has(p.ppid)) {
          let list = children.get(p.ppid);
          if (!list) children.set(p.ppid, (list = []));
          list.push(p);
        } else top.push(p);
      }
      const build = (p: ProcInfo): Node => {
        const kids = children.get(p.pid);
        return procNode(p, gmem, kids ? () => kids.sort(cmp).map(build) : undefined);
      };
      return withMore(top.sort(cmp), build);
    }
    return withMore(procs.sort(cmp), (p) => procNode(p, gmem));
  }

  /** Build nodes only for the first `limit` processes (each node reads a command line). */
  function withMore(list: ProcInfo[], build: (p: ProcInfo) => Node): Node[] {
    const nodes = list.slice(0, limit).map(build);
    if (list.length <= limit) return nodes;
    const rest = list.length - limit;
    return [...nodes, new Node(l10n.t('{0} more…', rest), { id: 'proc:more', icon: icon('ellipsis'), command: { command: 'serverMonitor.proc.showMore', title: '' } })];
  }

  function procNode(p: ProcInfo, gmem: Map<number, number>, kids?: () => Node[]): Node {
    const cmd = m.procC.cmdline(p);
    const mine = p.uid === m.names.myUid;
    const g = gmem.get(p.pid);
    const desc = [fmt.pct(p.cpu), fmt.bytes(p.rss), g ? `GPU ${fmt.mib(g)}` : '', scope === 'all' ? m.names.name(p.uid) : '', String(p.pid)].filter(Boolean).join(' · ');
    const state = p.state;
    const ic = state === 'R' ? icon('play-circle', 'charts.green') : state === 'D' ? icon('warning', 'charts.yellow') : state === 'Z' ? icon('error', 'charts.red') : state === 'T' || state === 't' ? icon('debug-pause') : icon('circle-small');
    const node = new Node(shortCmd(cmd), {
      id: `proc:${p.pid}:${p.start}`,
      description: desc,
      icon: ic,
      contextValue: mine ? 'proc.mine' : 'proc.other',
      data: { pid: p.pid, label: shortCmd(cmd), mine, start: p.start } satisfies ProcTarget,
      kids,
      expanded: true,
    });
    node.resolve = async () => {
      const d = await m.procC.details(p.pid);
      const md = new vscode.MarkdownString();
      md.appendCodeblock(cmd, 'shell');
      md.appendMarkdown(
        [
          `**PID** ${p.pid} · **PPID** ${p.ppid} · **${l10n.t('User')}** ${fmt.escapeMd(m.names.name(p.uid))} · **${l10n.t('State')}** ${p.state}`,
          `**CPU** ${fmt.pct(p.cpu, 1)} · **RSS** ${fmt.bytes(p.rss)} · **${l10n.t('Threads')}** ${p.threads}${g ? ` · **GPU** ${fmt.mib(g)}` : ''}`,
          `**${l10n.t('Started')}** ${new Date(p.start).toLocaleString()} (${relTime(p.start)})`,
          d.cwd ? `**cwd** \`${tildify(d.cwd, home)}\`` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      );
      return md;
    };
    return node;
  }

  const target = (n?: Node) => n?.data as ProcTarget | undefined;

  async function kill(n: Node | undefined, signal: NodeJS.Signals) {
    const t = target(n);
    if (!t) return;
    const ok = await confirm(signal === 'SIGKILL' ? l10n.t('Force kill {0} (pid {1})?', t.label, t.pid) : l10n.t('Terminate {0} (pid {1})?', t.label, t.pid), signal === 'SIGKILL' ? l10n.t('Force Kill') : l10n.t('Terminate'), signal === 'SIGKILL' ? l10n.t('SIGKILL cannot be caught: the process gets no chance to clean up.') : undefined);
    if (!ok) return;
    try {
      signalProcess(t.pid, signal);
      vscode.window.setStatusBarMessage(l10n.t('Sent {0} to {1}', signal, t.pid), 3000);
      setTimeout(() => m.procs.refresh(), 500);
    } catch (err) {
      showError(err);
    }
  }

  ctx.subscriptions.push(
    provider,
    view,
    demandWhileVisible(view, 'processView', () => [m.procs], (v) => {
      visible = v;
      setContext();
    }),
    m.procs.onData.event(render),
    m.onConfig.event((c) => {
      limit = c.processLimit;
      render();
    }),

    vscode.commands.registerCommand('serverMonitor.proc.showAll', () => {
      scope = 'all';
      setContext();
      render();
    }),
    vscode.commands.registerCommand('serverMonitor.proc.showMine', () => {
      scope = 'mine';
      setContext();
      render();
    }),
    vscode.commands.registerCommand('serverMonitor.proc.treeOn', () => {
      tree = true;
      setContext();
      render();
    }),
    vscode.commands.registerCommand('serverMonitor.proc.treeOff', () => {
      tree = false;
      setContext();
      render();
    }),
    vscode.commands.registerCommand('serverMonitor.proc.sort', async (preset?: unknown) => {
      const keys: SortKey[] = ['cpu', 'mem', 'gpu', 'time', 'pid'];
      if (typeof preset === 'string' && keys.includes(preset as SortKey)) {
        sort = preset as SortKey;
        return render();
      }
      const pick = await vscode.window.showQuickPick(
        keys.map((k) => ({ label: sortLabel[k], description: k === sort ? '✓' : '', k })),
        { title: l10n.t('Sort processes by') },
      );
      if (!pick) return;
      sort = pick.k;
      render();
    }),
    vscode.commands.registerCommand('serverMonitor.proc.filter', async (preset?: string) => {
      const v = typeof preset === 'string' ? preset : await vscode.window.showInputBox({ title: l10n.t('Filter processes'), prompt: l10n.t('Text matches command, name or PID; use user:NAME to filter by user.'), value: filter });
      if (v === undefined) return;
      filter = v.trim();
      if (/(^|\s)user:/.test(filter) && !filter.includes(`user:${m.names.myName}`)) scope = 'all';
      limit = m.cfg.processLimit;
      setContext();
      render();
    }),
    vscode.commands.registerCommand('serverMonitor.proc.clearFilter', () => {
      filter = '';
      setContext();
      render();
    }),
    vscode.commands.registerCommand('serverMonitor.proc.showMore', () => {
      limit *= 2;
      render();
    }),
    vscode.commands.registerCommand('serverMonitor.proc.kill', (n?: Node) => kill(n, 'SIGTERM')),
    vscode.commands.registerCommand('serverMonitor.proc.kill9', (n?: Node) => kill(n, 'SIGKILL')),
    vscode.commands.registerCommand('serverMonitor.proc.interrupt', async (n?: Node) => {
      const t = target(n);
      if (!t) return;
      try {
        signalProcess(t.pid, 'SIGINT');
        vscode.window.setStatusBarMessage(l10n.t('Sent {0} to {1}', 'SIGINT', t.pid), 3000);
      } catch (err) {
        showError(err);
      }
    }),
    vscode.commands.registerCommand('serverMonitor.proc.copyPid', (n?: Node) => {
      const t = target(n);
      if (t) void vscode.env.clipboard.writeText(String(t.pid));
    }),
    vscode.commands.registerCommand('serverMonitor.proc.copyCmd', (n?: Node) => {
      const t = target(n);
      if (t) void vscode.env.clipboard.writeText(m.procC.cmdline({ pid: t.pid, start: t.start ?? 0, comm: t.label }));
    }),
    vscode.commands.registerCommand('serverMonitor.proc.terminalAtCwd', async (n?: Node) => {
      const t = target(n);
      if (!t) return;
      const d = await m.procC.details(t.pid);
      if (!d.cwd) return void vscode.window.showWarningMessage(l10n.t('Cannot read the working directory of process {0}.', t.pid));
      openTerminal(t.label, d.cwd);
    }),
    vscode.commands.registerCommand('serverMonitor.proc.openCwd', async (n?: Node) => {
      const t = target(n);
      if (!t) return;
      const d = await m.procC.details(t.pid);
      if (!d.cwd) return void vscode.window.showWarningMessage(l10n.t('Cannot read the working directory of process {0}.', t.pid));
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(d.cwd), { forceNewWindow: true });
    }),
    vscode.commands.registerCommand('serverMonitor.proc.watch', (n?: Node) => {
      const t = target(n);
      if (!t) return;
      alerts.add({ kind: 'pid', pid: t.pid, start: t.start ?? m.procC.startTimeOf(t.pid), label: t.label });
    }),
  );
  setContext();
  render();
}
