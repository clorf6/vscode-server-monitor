import { execFile, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /** Resolves once the process has really gone — after a timeout that can be much later, or never (hung NFS). */
  exited?: Promise<void>;
}

/**
 * Run a binary without a shell and never reject. A process stuck in uninterruptible sleep (hung NFS) may ignore
 * the kill, so callers must not wait for it beyond the timeout — this resolves on timeout regardless.
 */
export function run(file: string, args: string[], opts: { timeoutMs?: number; maxBuffer?: number; env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  let gone!: () => void;
  const exited = new Promise<void>((r) => (gone = r));
  return new Promise((resolve) => {
    let settled = false;
    let child: ChildProcess | undefined;
    const finish = (r: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, exited });
    };
    const timer = setTimeout(() => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish({ stdout: '', stderr: 'timeout', code: null, timedOut: true });
    }, timeoutMs);
    try {
      child = execFile(file, args, { maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024, env: opts.env, cwd: opts.cwd, windowsHide: true }, (err, stdout, stderr) => {
        const c = (err as { code?: unknown } | null)?.code;
        const code = err ? (typeof c === 'number' ? c : 1) : 0;
        finish({ stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : '')), code, timedOut: false });
      });
      child.on('exit', () => gone());
      child.on('error', () => gone());
    } catch (err) {
      gone();
      finish({ stdout: '', stderr: String(err), code: 1, timedOut: false });
    }
  });
}

const lingering = new Map<string, Promise<void>>();

/**
 * run(), but never a second copy of `key` while an earlier one outlived its timeout. A process stuck in uninterruptible
 * sleep (dead NFS server, wedged GPU driver) ignores SIGKILL; spawning a fresh one every poll would pile them up, so
 * until it is gone this reports a timeout without spawning anything.
 */
export async function runExclusive(key: string, file: string, args: string[], opts: Parameters<typeof run>[2] = {}): Promise<ExecResult> {
  if (lingering.has(key)) return { stdout: '', stderr: 'previous run still has not exited', code: null, timedOut: true };
  const r = await run(file, args, opts);
  if (r.timedOut && r.exited) {
    const done = r.exited;
    lingering.set(key, done);
    void done.then(() => lingering.get(key) === done && lingering.delete(key));
  }
  return r;
}

/** Spawn a long-running process and deliver complete stdout lines. */
export function spawnLines(file: string, args: string[], onLine: (line: string) => void, onExit: (code: number | null) => void): ChildProcess {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let buf = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  });
  child.on('error', () => onExit(null));
  child.on('exit', (code) => onExit(code));
  return child;
}

const whichCache = new Map<string, string | undefined>();

/** Locate an executable on PATH (plus optional extra candidates). Cached for the session. */
export function which(name: string, extra: string[] = []): string | undefined {
  const key = name + '\0' + extra.join('\0');
  if (whichCache.has(key)) return whichCache.get(key);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  let found: string | undefined;
  outer: for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (isExecutable(p)) {
        found = p;
        break outer;
      }
    }
  }
  if (!found) found = extra.find(isExecutable);
  whichCache.set(key, found);
  return found;
}

function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
