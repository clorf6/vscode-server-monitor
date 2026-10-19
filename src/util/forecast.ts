/** A value sampled over time (e.g. a mount's used bytes). */
export interface Point {
  t: number;
  v: number;
}

/**
 * Least-squares slope (units per second) of the samples within `windowMs` of the newest one; undefined when they span
 * less than `minSpanMs` (too little to tell a trend from noise).
 */
export function slope(points: Point[], windowMs = 30 * 60_000, minSpanMs = 10 * 60_000): number | undefined {
  if (points.length < 3) return undefined;
  const end = points[points.length - 1].t;
  const pts = points.filter((p) => p.t >= end - windowMs);
  if (pts.length < 3 || end - pts[0].t < minSpanMs) return undefined;
  const t0 = pts[0].t;
  let st = 0;
  let sv = 0;
  for (const p of pts) (st += (p.t - t0) / 1000), (sv += p.v);
  const mt = st / pts.length;
  const mv = sv / pts.length;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    const x = (p.t - t0) / 1000 - mt;
    num += x * (p.v - mv);
    den += x * x;
  }
  return den > 0 ? num / den : undefined;
}

/**
 * When a filling disk runs out at its recent rate: seconds left and the rate (bytes/s). Undefined while it is not
 * growing measurably, or would take longer than `horizonSec`.
 */
export function fillEta(points: Point[], avail: number, horizonSec = 7 * 86400): { seconds: number; rate: number } | undefined {
  const rate = slope(points);
  // at least 1 MiB/min, so a log file ticking along does not predict "full in 3 years"
  if (rate === undefined || rate < 1048576 / 60 || !(avail >= 0)) return undefined;
  const seconds = avail / rate;
  return seconds <= horizonSec ? { seconds, rate } : undefined;
}
