import { spawn } from 'child_process';
import * as fs from 'fs';
import { parseDu } from './parsers';
import { which } from '../util/exec';

export interface DuEntry {
  path: string;
  size: number;
  dir: boolean;
}

export interface DuResult {
  path: string;
  total: number;
  entries: DuEntry[];
  /** du hit unreadable directories; sizes are lower bounds. */
  partial: boolean;
  scannedAt: number;
}

/** One level of `du` (files and sub-directories with their recursive sizes). Cancellable; never crosses filesystems. */
export function duLevel(dir: string, signal: AbortSignal): Promise<DuResult> {
  const du = which('du');
  if (!du) return Promise.reject(new Error('du not found'));
  return new Promise((resolve, reject) => {
    const child = spawn(du, ['-x', '-a', '-d1', '-B1', '--', dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let partial = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.on('data', () => (partial = true));
    const onAbort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', async () => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return reject(new Error('cancelled'));
      const parsed = parseDu(out, dir);
      const entries = await Promise.all(
        parsed.entries.map(async (e) => ({ ...e, dir: await fs.promises.lstat(e.path).then((s) => s.isDirectory(), () => false) })),
      );
      resolve({ path: dir, total: parsed.total, entries, partial, scannedAt: Date.now() });
    });
  });
}
