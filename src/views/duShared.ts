import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { l10n } from 'vscode';
import { duLevel, DuResult } from '../collectors/du';
import { getSysInfo } from '../collectors/sysinfo';
import { Monitor } from '../monitor';
import * as fmt from '../util/format';
import { icon, tildify } from './common';

// Shared by the "Folder Sizes" tree view and the panel's folder page: the scan cache, the folder chooser and the
// recent-folders list. Nothing here touches the filesystem synchronously (a hung NFS mount must not freeze the host).

const MAX_RECENT = 8;
const home = os.homedir();

function recentKey(): string {
  return `du.recent:${getSysInfo().hostname}`;
}

export function recentFolders(ctx: vscode.ExtensionContext): string[] {
  const v = ctx.globalState.get<unknown>(recentKey(), []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function rememberFolder(ctx: vscode.ExtensionContext, dir: string): void {
  void ctx.globalState.update(recentKey(), [dir, ...recentFolders(ctx).filter((d) => d !== dir)].slice(0, MAX_RECENT));
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? home + p.slice(1) : p;
}

/** Async with a deadline: a path on a hung network mount must not freeze the extension host or the picker. */
export function withTimeout<T>(p: Promise<T>, fallback: T, ms = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([p.catch(() => fallback), new Promise<T>((r) => (timer = setTimeout(() => r(fallback), ms)))]).finally(() => clearTimeout(timer));
}

export function isDir(p: string): Promise<boolean> {
  return withTimeout(
    fs.promises.stat(p).then((s) => s.isDirectory()),
    false,
  );
}

/**
 * One `du` level per folder, cached until rescanned. Several folders may scan in parallel (one child process each);
 * asking for a folder that is already being scanned joins that scan.
 */
export class DuScanner implements vscode.Disposable {
  readonly cache = new Map<string, DuResult>();
  readonly scans = new Map<string, { ac: AbortController; p: Promise<DuResult>; started: number }>();
  /** Last failure per folder ("cancelled" for a cancelled scan), until it is scanned again. */
  readonly errors = new Map<string, string>();
  readonly onChange = new vscode.EventEmitter<void>();

  scan(dir: string): Promise<DuResult> {
    const hit = this.cache.get(dir);
    if (hit) return Promise.resolve(hit);
    const running = this.scans.get(dir);
    if (running) return running.p;
    const ac = new AbortController();
    this.errors.delete(dir);
    const p = (async () => {
      try {
        const r = await duLevel(dir, ac.signal);
        this.cache.set(dir, r);
        return r;
      } catch (err) {
        this.errors.set(dir, String((err as Error)?.message ?? err));
        throw err;
      } finally {
        this.scans.delete(dir);
        this.onChange.fire();
      }
    })();
    this.scans.set(dir, { ac, p, started: Date.now() });
    this.onChange.fire();
    return p;
  }

  /** Forget cached results for `dir` and everything below it. */
  invalidate(dir: string): void {
    const prefix = dir.replace(/\/$/, '') + '/';
    for (const k of [...this.cache.keys()]) if (k === dir || k.startsWith(prefix)) this.cache.delete(k);
    this.errors.delete(dir);
    this.onChange.fire();
  }

  /** Cancel one folder's scan, or all of them. */
  cancel(dir?: string): void {
    for (const [k, s] of this.scans) if (dir === undefined || k === dir) s.ac.abort();
  }

  dispose(): void {
    this.cancel();
    this.onChange.dispose();
  }
}

interface PickItem extends vscode.QuickPickItem {
  action: 'analyze' | 'enter' | 'browse';
  path?: string;
}

/** Places shown when the input is empty: recent folders, home, workspace folders, mounted disks. */
function places(ctx: vscode.ExtensionContext, m: Monitor, scanner: DuScanner): PickItem[] {
  const items: PickItem[] = [];
  const seen = new Set<string>();
  const add = (p: string, label: string, ic: string, desc?: string) => {
    if (seen.has(p) || !p) return;
    seen.add(p);
    items.push({ label: `$(${ic}) ${label}`, description: desc, action: 'analyze', path: p, alwaysShow: true, buttons: [{ iconPath: icon('arrow-right'), tooltip: l10n.t('Browse into') }] });
  };
  const rec = recentFolders(ctx);
  if (rec.length) items.push({ label: l10n.t('Recent'), kind: vscode.QuickPickItemKind.Separator, action: 'analyze' });
  for (const d of rec) add(d, tildify(d, home), 'history', scanner.cache.has(d) ? fmt.bytes(scanner.cache.get(d)!.total) : undefined);
  items.push({ label: l10n.t('Places'), kind: vscode.QuickPickItemKind.Separator, action: 'analyze' });
  add(home, '~', 'home', home);
  for (const f of vscode.workspace.workspaceFolders ?? []) if (f.uri.scheme === 'file') add(f.uri.fsPath, f.name, 'folder', tildify(f.uri.fsPath, home));
  for (const mt of m.disks.latest?.mounts ?? []) {
    if (mt.status === 'timeout') continue;
    add(mt.mount, mt.mount, mt.network ? 'cloud' : 'database', mt.percent !== undefined ? `${fmt.pct(mt.percent)} · ${fmt.bytes(mt.used ?? 0)}/${fmt.bytes(mt.total ?? 0)}` : mt.fstype);
  }
  items.push({ label: `$(folder-opened) ${l10n.t('Browse…')}`, action: 'browse', alwaysShow: true });
  return items;
}

/** Items for a typed path: "analyze this folder" plus matching sub-folders (Enter on one walks into it). */
async function pathItems(value: string): Promise<PickItem[]> {
  const full = expandHome(value);
  const endsWithSlash = full.endsWith('/');
  const dir = endsWithSlash ? full : path.dirname(full);
  const prefix = endsWithSlash ? '' : path.basename(full).toLowerCase();
  const items: PickItem[] = [];
  const target = endsWithSlash ? full.replace(/\/+$/, '') || '/' : full;
  if (await isDir(target)) items.push({ label: `$(graph) ${l10n.t('Analyze {0}', tildify(target, home))}`, action: 'analyze', path: target, alwaysShow: true });
  const entries = await withTimeout(fs.promises.readdir(dir, { withFileTypes: true }), [] as fs.Dirent[]);
  const wanted = entries.filter((e) => e.name.toLowerCase().startsWith(prefix) && (prefix.startsWith('.') || !e.name.startsWith('.')));
  const linkDirs = new Set<string>();
  await Promise.all(wanted.filter((e) => e.isSymbolicLink()).slice(0, 100).map(async (e) => (await isDir(path.join(dir, e.name))) && linkDirs.add(e.name)));
  const subs = wanted
    .filter((e) => e.isDirectory() || linkDirs.has(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 300);
  for (const name of subs) {
    const p = path.join(dir, name);
    items.push({ label: `$(folder) ${name}/`, description: tildify(p, home), action: 'enter', path: p, alwaysShow: true, buttons: [{ iconPath: icon('graph'), tooltip: l10n.t('Analyze this folder') }] });
  }
  if (!items.length) items.push({ label: l10n.t('No matching folder'), action: 'enter', alwaysShow: true });
  return items;
}

/**
 * QuickPick folder chooser: type a path (with sub-folder completion), or pick a recent folder, home, a workspace folder
 * or a mount. Resolves to an absolute folder path, or undefined when cancelled.
 */
export function chooseFolder(ctx: vscode.ExtensionContext, m: Monitor, scanner: DuScanner, current?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<PickItem>();
    qp.title = l10n.t('Analyze folder size');
    qp.placeholder = l10n.t('Type a path (e.g. /data or ~/), Enter walks into a folder; or pick a place below');
    qp.matchOnDescription = false;
    let seq = 0;
    const refresh = async () => {
      const v = qp.value.trim();
      if (!(v.startsWith('/') || v.startsWith('~'))) {
        seq++;
        qp.items = places(ctx, m, scanner);
        return;
      }
      const mine = ++seq;
      qp.busy = true;
      const items = await pathItems(v);
      if (mine !== seq) return; // a newer keystroke won
      qp.busy = false;
      qp.items = items;
    };
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    const finish = (v: string | undefined) => {
      if (done) return;
      done = true;
      qp.hide();
      resolve(v);
    };
    qp.onDidChangeValue(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 60);
    });
    qp.onDidTriggerItemButton((e) => {
      if (!e.item.path) return;
      if (e.item.action === 'enter') finish(e.item.path);
      else {
        qp.value = tildify(e.item.path, home).replace(/\/?$/, '/');
        void refresh();
      }
    });
    qp.onDidAccept(async () => {
      const it = qp.selectedItems[0];
      if (!it) {
        const v = expandHome(qp.value.trim());
        if (await isDir(v)) finish(v.replace(/\/+$/, '') || '/');
        return;
      }
      if (it.action === 'browse') {
        done = true;
        qp.hide();
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, defaultUri: vscode.Uri.file(current ?? home), title: l10n.t('Choose a folder to analyze') });
        resolve(picked?.[0]?.fsPath);
      } else if (it.action === 'enter' && it.path) {
        qp.value = tildify(it.path, home) + '/';
        void refresh();
      } else if (it.action === 'analyze' && it.path) finish(it.path);
    });
    qp.onDidHide(() => {
      finish(undefined);
      qp.dispose();
    });
    void refresh();
    qp.show();
    // Mounted disks come from the disk source; if nothing polled it yet, add them as soon as they arrive.
    if (!m.disks.latest) void m.disks.fetch().then(() => !done && !qp.value.trim() && void refresh());
  });
}
