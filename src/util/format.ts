const UNITS = ['B', 'K', 'M', 'G', 'T', 'P'];

/** Compact binary size: 1536 -> "1.5K", 12.3 GiB -> "12.3G". */
export function bytes(n: number, digits = 1): string {
  if (!isFinite(n) || n < 0) return '–';
  let i = 0;
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024;
    i++;
  }
  const d = i === 0 ? 0 : n >= 100 ? 0 : digits;
  return n.toFixed(d) + UNITS[i];
}

export function rate(bytesPerSec: number): string {
  return bytes(bytesPerSec) + '/s';
}

export function mib(n: number): string {
  return bytes(n * 1024 * 1024);
}

export function pct(n: number, digits = 0): string {
  if (!isFinite(n)) return '–';
  return n.toFixed(digits) + '%';
}

/** "3d 4h", "2h 15m", "5m 3s", "12s" */
export function duration(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** Text progress bar for tree descriptions. */
export function bar(percent: number, width = 10): string {
  const p = Math.max(0, Math.min(100, isFinite(percent) ? percent : 0));
  const full = Math.round((p / 100) * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
