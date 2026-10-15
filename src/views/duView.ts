import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { DuResult } from '../collectors/du';
import { isLinux } from '../collectors/core';
import { Monitor } from '../monitor';
import * as fmt from '../util/format';
import { chooseFolder, DuScanner, expandHome, isDir, rememberFolder } from './duShared';
import { gotoPanel } from './nav';
import { icon, Node, openTerminal, relTime, showError, tildify, TreeProvider } from './common';

interface DuItem {
  path: string;
  size: number;
  dir: boolean;
  parentTotal: number;
}

/**
 * ncdu-style folder size explorer (classic tree view): one `du` level per expanded folder, cached until rescanned.
 * The scan cache and the folder chooser are shared with the sidebar panel's folder page (duShared.ts).
 */
export function registerDuView(ctx: vscode.ExtensionContext, m: Monitor, scanner = new DuScanner()): void {
  const home = os.homedir();
  let root: string | undefined;

  const provider = new TreeProvider(() => roots());
  const view = vscode.window.createTreeView('serverMonitor.du', { treeDataProvider: provider, showCollapseAll: true });

  const updateState = () => {
    void vscode.commands.executeCommand('setContext', 'serverMonitor.duScanning', scanner.scans.size > 0);
    void vscode.commands.executeCommand('setContext', 'serverMonitor.duHasParent', !!root && root !== '/');
    const busy = [...scanner.scans.keys()];
    view.message = busy.length ? l10n.t('Scanning {0} … (click ✕ in the title bar to cancel)', busy.map((p) => tildify(p, home)).join(', ')) : undefined;
    const r = root && scanner.cache.get(root);
    view.description = root ? `${tildify(root, home)}${r ? ` · ${fmt.bytes(r.total)} · ${relTime(r.scannedAt)}` : ''}` : undefined;
  };

  function scan(dir: string): Promise<DuResult> {
    const p = scanner.scan(dir);
    if (scanner.scans.has(dir)) void vscode.window.withProgress({ location: { viewId: 'serverMonitor.du' } }, () => p.catch(() => undefined));
    return p;
  }

  async function children(dir: string): Promise<Node[]> {
    let r: DuResult;
    try {
      r = await scan(dir);
    } catch (err) {
      if (String((err as Error).message) === 'cancelled') return [new Node(l10n.t('Scan cancelled — use Rescan to try again'), { icon: icon('circle-slash') })];
      return [new Node(l10n.t('Scan failed: {0}', String((err as Error).message)), { icon: icon('error') })];
    }
    const nodes = r.entries.slice(0, 200).map((e) => itemNode({ ...e, parentTotal: r.total }));
    if (r.entries.length > 200) {
      const rest = r.entries.slice(200).reduce((a, e) => a + e.size, 0);
      nodes.push(new Node(l10n.t('{0} smaller items', r.entries.length - 200), { description: fmt.bytes(rest), icon: icon('ellipsis') }));
    }
    if (!r.entries.length) nodes.push(new Node(l10n.t('Empty folder'), { icon: icon('info') }));
    if (r.partial) nodes.unshift(new Node(l10n.t('Some folders could not be read; sizes are lower bounds.'), { icon: icon('warning', 'charts.yellow') }));
    return nodes;
  }

  function itemNode(e: DuItem): Node {
    const pct = e.parentTotal ? (e.size / e.parentTotal) * 100 : 0;
    return new Node(path.basename(e.path) + (e.dir ? '/' : ''), {
      id: `du:${e.path}`,
      description: `${fmt.bytes(e.size).padStart(6)} ${fmt.bar(pct, 8)} ${pct.toFixed(1)}%`,
      icon: icon(e.dir ? 'folder' : 'file', pct >= 50 ? 'charts.orange' : undefined),
      contextValue: e.dir ? 'duDir' : 'duFile',
      tooltip: `${e.path}\n${fmt.bytes(e.size)} · ${pct.toFixed(1)}%`,
      data: e.path,
      kids: e.dir ? () => children(e.path) : undefined,
    });
  }

  function roots(): Node[] {
    updateState();
    if (!root) return [];
    const dir = root;
    const r = scanner.cache.get(dir);
    return [
      new Node(tildify(dir, home), {
        id: `duroot:${dir}`,
        description: r ? fmt.bytes(r.total) : undefined,
        icon: icon('root-folder'),
        contextValue: 'duDir',
        tooltip: dir,
        data: dir,
        kids: () => children(dir),
        expanded: true,
      }),
    ];
  }

  /** Show `dir` in this tree view (rescanning it). */
  async function analyzeInTree(dir: string) {
    if (!(await isDir(dir))) return void vscode.window.showWarningMessage(l10n.t('Not a folder: {0}', dir));
    root = dir;
    scanner.cache.delete(dir);
    rememberFolder(ctx, dir);
    await vscode.commands.executeCommand('serverMonitor.du.focus');
    provider.refresh();
  }

  /**
   * The command: a tree node (or the tree's own title bar while it is shown) analyzes in this tree; everything else
   * (Explorer context menu, command palette, disks view) opens the sidebar panel's folder page.
   */
  async function analyze(target?: vscode.Uri | Node | string) {
    if (!isLinux) return void vscode.window.showWarningMessage(l10n.t('Folder size analysis is only available on Linux.'));
    let dir: string | undefined;
    if (target instanceof Node) {
      dir = typeof target.data === 'string' ? target.data : (target.data as { mount?: string })?.mount;
      if (dir) return analyzeInTree(dir);
    }
    if (target instanceof vscode.Uri) dir = target.fsPath;
    else if (typeof target === 'string') dir = expandHome(target);
    const inTree = m.cfg.sidebarTreeViews && view.visible;
    if (!dir) dir = await chooseFolder(ctx, m, scanner, root);
    if (!dir) return;
    if (!inTree && (await gotoPanel({ page: 'du', path: dir }))) return;
    await analyzeInTree(dir);
  }

  const p = (n?: Node) => (typeof n?.data === 'string' ? n.data : undefined);

  ctx.subscriptions.push(
    provider,
    view,
    scanner.onChange.event(updateState),
    { dispose: () => scanner.cancel() },
    vscode.commands.registerCommand('serverMonitor.du.analyze', analyze),
    vscode.commands.registerCommand('serverMonitor.du.analyzeHome', () => analyze(home)),
    vscode.commands.registerCommand('serverMonitor.du.up', () => {
      if (root && root !== '/') void analyzeInTree(path.dirname(root));
    }),
    vscode.commands.registerCommand('serverMonitor.du.cancel', () => scanner.cancel()),
    vscode.commands.registerCommand('serverMonitor.du.rescan', (n?: Node) => {
      const dir = p(n) ?? root;
      if (!dir) return;
      scanner.invalidate(dir);
      provider.refresh();
    }),
    vscode.commands.registerCommand('serverMonitor.du.drillInto', (n?: Node) => {
      const dir = p(n);
      if (dir) void analyzeInTree(dir);
    }),
    vscode.commands.registerCommand('serverMonitor.du.terminal', (n?: { data?: unknown; contextValue?: string }) => {
      const dir = typeof n?.data === 'string' ? n.data : undefined;
      if (dir) openTerminal(path.basename(dir) || dir, n?.contextValue === 'duFile' ? path.dirname(dir) : dir);
    }),
    vscode.commands.registerCommand('serverMonitor.du.copyPath', (n?: Node) => {
      const dir = p(n);
      if (dir) void vscode.env.clipboard.writeText(dir);
    }),
    vscode.commands.registerCommand('serverMonitor.du.openFolder', (n?: Node) => {
      const dir = p(n);
      if (dir) void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceNewWindow: true });
    }),
    vscode.commands.registerCommand('serverMonitor.du.reveal', (n?: Node) => {
      const dir = p(n);
      if (dir) void vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(dir)).then(undefined, showError);
    }),
  );
  updateState();
}
