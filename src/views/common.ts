import * as vscode from 'vscode';
import { l10n } from 'vscode';

/** Tree node that is its own TreeItem; `kids` lazily produces children. */
export class Node extends vscode.TreeItem {
  kids?: () => Node[] | Promise<Node[]>;
  /** Arbitrary payload for commands invoked on this node. */
  data?: unknown;
  /** Lazily filled tooltip (TreeDataProvider.resolveTreeItem). */
  resolve?: () => Promise<vscode.MarkdownString | string | undefined>;

  constructor(label: string | vscode.TreeItemLabel, opts: { id?: string; description?: string; icon?: vscode.ThemeIcon; contextValue?: string; tooltip?: string | vscode.MarkdownString; kids?: () => Node[] | Promise<Node[]>; expanded?: boolean; data?: unknown; command?: vscode.Command } = {}) {
    super(label, opts.kids ? (opts.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
    this.id = opts.id;
    this.description = opts.description;
    this.iconPath = opts.icon;
    this.contextValue = opts.contextValue;
    if (opts.tooltip) this.tooltip = opts.tooltip;
    this.kids = opts.kids;
    this.data = opts.data;
    this.command = opts.command;
  }
}

export class TreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly roots: () => Node[] | Promise<Node[]>) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(n: Node): vscode.TreeItem {
    return n;
  }

  getChildren(n?: Node): vscode.ProviderResult<Node[]> {
    return n ? (n.kids?.() ?? []) : this.roots();
  }

  async resolveTreeItem(item: vscode.TreeItem, n: Node): Promise<vscode.TreeItem> {
    if (n.resolve && !item.tooltip) item.tooltip = await n.resolve();
    return item;
  }

  dispose(): void {
    this.changed.dispose();
  }
}

export function icon(id: string, color?: string): vscode.ThemeIcon {
  return new vscode.ThemeIcon(id, color ? new vscode.ThemeColor(color) : undefined);
}

/** Green below 60%, yellow below 85%, red above — for usage meters. */
export function usageColor(percent: number): string {
  return percent >= 85 ? 'charts.red' : percent >= 60 ? 'charts.yellow' : 'charts.green';
}

const INTERPRETERS = /^(python[\d.]*|node|bash|sh|zsh|perl|ruby|java|deno|bun|uv|torchrun|accelerate|deepspeed|julia|Rscript)$/;

/** "/opt/conda/bin/python -u /home/me/train.py --lr 1" → "python train.py" */
export function shortCmd(cmd: string): string {
  const args = cmd.split(' ').filter(Boolean);
  if (!args.length) return cmd;
  if (cmd.startsWith('[')) return cmd; // kernel thread
  const exe = args[0].split('/').pop()!.replace(/:$/, '');
  if (INTERPRETERS.test(exe)) {
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '-m' && args[i + 1]) return `${exe} -m ${args[i + 1]}`;
      if (a === '-c') return `${exe} -c …`;
      if (!a.startsWith('-')) return `${exe} ${a.split('/').pop()}`;
    }
  }
  return exe;
}

export async function confirm(message: string, action: string, detail?: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
  return choice === action;
}

export function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(code === 'EPERM' ? l10n.t('Permission denied: process {0} belongs to another user.', pid) : code === 'ESRCH' ? l10n.t('Process {0} no longer exists.', pid) : String(err));
  }
}

export function showError(err: unknown): void {
  void vscode.window.showErrorMessage(String((err as Error)?.message ?? err));
}

export function relTime(ms: number): string {
  const d = Date.now() - ms;
  return d < 0 ? '' : l10n.t('{0} ago', durationShort(d));
}

function durationShort(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return l10n.t('{0}s', s);
  if (s < 3600) return l10n.t('{0}m', Math.floor(s / 60));
  if (s < 86400) return l10n.t('{0}h {1}m', Math.floor(s / 3600), Math.floor((s % 3600) / 60));
  return l10n.t('{0}d {1}h', Math.floor(s / 86400), Math.floor((s % 86400) / 3600));
}

export function tildify(p: string, home: string): string {
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p;
}

/** Open an integrated terminal in `cwd`, optionally running one command. */
export function openTerminal(name: string, cwd?: string, cmd?: string): vscode.Terminal {
  const term = vscode.window.createTerminal({ name, cwd });
  term.show();
  if (cmd) term.sendText(cmd);
  return term;
}
