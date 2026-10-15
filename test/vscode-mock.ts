// Minimal stand-in for the `vscode` module so views can be exercised headlessly (see test/harness.ts).
/* eslint-disable @typescript-eslint/no-explicit-any */

export class EventEmitter<T> {
  private ls = new Set<(v: T) => void>();
  event = (l: (v: T) => void) => {
    this.ls.add(l);
    return { dispose: () => this.ls.delete(l) };
  };
  fire(v: T) {
    for (const l of [...this.ls]) l(v);
  }
  dispose() {
    this.ls.clear();
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}
export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export enum TextEditorRevealType {
  InCenterIfOutsideViewport = 2,
}
export enum ProgressLocation {
  Window = 10,
  Notification = 15,
}
export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}
export enum ConfigurationTarget {
  Global = 1,
}

export class TreeItem {
  id?: string;
  description?: string;
  iconPath?: any;
  contextValue?: string;
  tooltip?: any;
  command?: any;
  constructor(
    public label: any,
    public collapsibleState: TreeItemCollapsibleState = 0,
  ) {}
}
export class ThemeIcon {
  constructor(
    public id: string,
    public color?: ThemeColor,
  ) {}
}
export class ThemeColor {
  constructor(public id: string) {}
}
export class MarkdownString {
  value = '';
  isTrusted: any;
  constructor(v = '', public supportThemeIcons = false) {
    this.value = v;
  }
  appendMarkdown(s: string) {
    this.value += s;
    return this;
  }
  appendCodeblock(s: string, lang = '') {
    this.value += '\n```' + lang + '\n' + s + '\n```\n';
    return this;
  }
  appendText(s: string) {
    this.value += s;
    return this;
  }
}
export class Range {
  constructor(...a: number[]) {
    void a;
  }
}
export class Uri {
  constructor(
    public scheme: string,
    public path: string,
    public query = '',
  ) {}
  get fsPath() {
    return this.path;
  }
  static file(p: string) {
    return new Uri('file', p);
  }
  static parse(s: string) {
    return new Uri(s.split(':')[0], s);
  }
  static from(c: { scheme: string; path: string; query?: string }) {
    return new Uri(c.scheme, c.path, c.query);
  }
  static joinPath(u: Uri, ...p: string[]) {
    return new Uri(u.scheme, [u.path, ...p].join('/'));
  }
  toString() {
    return `${this.scheme}:${this.path}`;
  }
  with() {
    return this;
  }
}

export const registry = {
  views: new Map<string, any>(),
  commands: new Map<string, (...a: any[]) => any>(),
  context: new Map<string, unknown>(),
  statusItems: [] as any[],
  messages: [] as string[],
  terminals: [] as any[],
  config: {} as Record<string, unknown>,
  configEmitter: new EventEmitter<any>(),
  focusEmitter: new EventEmitter<any>(),
  /** Webview view providers by view id (see test/overview-host.ts). */
  webviewViews: new Map<string, { provider: any; options: any }>(),
  /** Every executeCommand id, in order. */
  executed: [] as string[],
};

function format(msg: string, args: any[]) {
  return msg.replace(/\{(\d+)\}/g, (_, i) => String(args[+i]));
}

export const l10n = { t: (msg: string, ...args: any[]) => format(msg, args) };

const visEmitters = new Map<string, EventEmitter<any>>();

export const window = {
  state: { focused: true },
  onDidChangeWindowState: registry.focusEmitter.event,
  visibleTextEditors: [] as any[],
  activeTerminal: undefined,
  activeTextEditor: undefined,
  createTreeView(id: string, opts: any) {
    const em = new EventEmitter<any>();
    visEmitters.set(id, em);
    const view = { id, provider: opts.treeDataProvider, visible: false, message: undefined, description: undefined, badge: undefined, onDidChangeVisibility: em.event, dispose() {} };
    registry.views.set(id, view);
    return view;
  },
  createStatusBarItem() {
    const it = { text: '', tooltip: undefined as any, backgroundColor: undefined, shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} };
    registry.statusItems.push(it);
    return it;
  },
  showInformationMessage: async (m: string) => (registry.messages.push('info: ' + m), undefined),
  showWarningMessage: async (m: string) => (registry.messages.push('warn: ' + m), undefined),
  showErrorMessage: async (m: string) => (registry.messages.push('error: ' + m), undefined),
  setStatusBarMessage: (m: string) => (registry.messages.push('status: ' + m), { dispose() {} }),
  withProgress: async (_o: any, fn: any) => fn({ report() {} }, { isCancellationRequested: false }),
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showOpenDialog: async () => undefined,
  createTerminal: (o: any) => {
    const t = { ...o, show() {}, sendText(s: string) { (t as any).sent = s; } };
    registry.terminals.push(t);
    return t;
  },
  createWebviewPanel: () => {
    throw new Error('no webviews in harness');
  },
  registerWebviewPanelSerializer: () => ({ dispose() {} }),
  showTextDocument: async () => ({ revealRange() {} }),
  registerWebviewViewProvider: (id: string, provider: any, options: any) => {
    registry.webviewViews.set(id, { provider, options });
    return { dispose: () => registry.webviewViews.delete(id) };
  },
  createQuickPick: () => {
    throw new Error('no quick picks in harness');
  },
};

export function setVisible(id: string, v: boolean) {
  const view = registry.views.get(id);
  view.visible = v;
  visEmitters.get(id)!.fire(v);
}

export const commands = {
  registerCommand(id: string, fn: any) {
    if (registry.commands.has(id)) throw new Error('duplicate command ' + id);
    registry.commands.set(id, fn);
    return { dispose: () => registry.commands.delete(id) };
  },
  async executeCommand(id: string, ...args: any[]) {
    if (id === 'setContext') return void registry.context.set(args[0], args[1]);
    registry.executed.push(id);
    const fn = registry.commands.get(id);
    if (fn) return fn(...args);
  },
};

export const workspace = {
  workspaceFolders: undefined,
  getConfiguration: () => ({ get: (k: string, d: unknown) => (k in registry.config ? registry.config[k] : d) }),
  onDidChangeConfiguration: registry.configEmitter.event,
  registerTextDocumentContentProvider: () => ({ dispose() {} }),
  onDidChangeTextDocument: () => ({ dispose() {} }),
  onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  openTextDocument: async () => ({ lineCount: 1 }),
};

export const env = {
  remoteName: 'ssh-remote',
  language: 'zh-cn',
  clipboard: { text: '', writeText: async (s: string) => void (env.clipboard.text = s) },
  asExternalUri: async (u: Uri) => u,
  openExternal: async () => true,
};
