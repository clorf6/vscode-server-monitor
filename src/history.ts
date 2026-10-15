/** Fixed-capacity ring buffer of numbers. */
export class Ring {
  private buf: Float64Array;
  private start = 0;
  len = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  push(v: number): void {
    if (this.len < this.capacity) {
      this.buf[(this.start + this.len) % this.capacity] = v;
      this.len++;
    } else {
      this.buf[this.start] = v;
      this.start = (this.start + 1) % this.capacity;
    }
  }

  toArray(from = 0): number[] {
    const out: number[] = [];
    for (let i = from; i < this.len; i++) out.push(this.buf[(this.start + i) % this.capacity]);
    return out;
  }

  at(i: number): number {
    return this.buf[(this.start + i) % this.capacity];
  }
}

export interface HistorySnapshot {
  t: number[];
  series: Record<string, number[]>;
}

/** Time series sharing one time axis. Series that appear later are back-filled with NaN. */
export class History {
  private t: Ring;
  private series = new Map<string, Ring>();

  constructor(private capacity: number) {
    this.t = new Ring(capacity);
  }

  push(t: number, values: Record<string, number>): void {
    for (const key of Object.keys(values)) {
      if (!this.series.has(key)) {
        const r = new Ring(this.capacity);
        for (let i = 0; i < this.t.len; i++) r.push(NaN);
        this.series.set(key, r);
      }
    }
    this.t.push(t);
    for (const [key, r] of this.series) r.push(values[key] ?? NaN);
  }

  /** Points with timestamp >= since. */
  snapshot(since = 0): HistorySnapshot {
    let from = 0;
    while (from < this.t.len && this.t.at(from) < since) from++;
    const series: Record<string, number[]> = {};
    for (const [k, r] of this.series) series[k] = r.toArray(from);
    return { t: this.t.toArray(from), series };
  }

  get length(): number {
    return this.t.len;
  }
}
