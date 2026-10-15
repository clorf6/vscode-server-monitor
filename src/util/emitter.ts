// Minimal event emitter so collectors stay free of the `vscode` module (tests and the smoke script run in plain Node).

export interface Disposable {
  dispose(): void;
}

export type Listener<T> = (value: T) => void;

export class Emitter<T> {
  private listeners = new Set<Listener<T>>();

  event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(value);
      } catch (err) {
        console.error('[server-monitor] listener failed', err);
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }

  dispose(): void {
    this.listeners.clear();
  }
}
