/**
 * A simulation worker with a main-thread fallback. Where the host's security
 * policy or browser blocks module workers (some sandboxed embeds, old
 * browsers), the same WorkerHost runs on the main thread instead, loaded as
 * a separate chunk only when needed. Messages sent before the worker first
 * answers are buffered and replayed to the fallback, so nothing is lost.
 */
import type { FromWorker, ToWorker } from './protocol';

export interface WorkerLike {
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null;
  postMessage(msg: ToWorker): void;
  terminate(): void;
}

export class ResilientWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  /** 'worker' once the real worker has answered; 'inline' after falling back. */
  mode: 'pending' | 'worker' | 'inline' = 'pending';
  private target: Worker | WorkerLike | null = null;
  private answered = false;
  private buffer: ToWorker[] = [];
  private dead = false;

  constructor(make: () => Worker) {
    try {
      const w = make();
      w.onmessage = (e: MessageEvent<FromWorker>) => {
        if (!this.answered) {
          this.answered = true;
          this.buffer = [];
          this.mode = 'worker';
        }
        this.onmessage?.(e);
      };
      // A worker that fails before it ever answers (blocked or unsupported) is replaced.
      w.onerror = (e: ErrorEvent) => {
        if (this.answered) return;
        e.preventDefault();
        w.terminate();
        this.fallback();
      };
      this.target = w;
    } catch {
      this.fallback();
    }
  }

  postMessage(msg: ToWorker): void {
    if (this.dead) return;
    if (!this.answered) this.buffer.push(msg);
    this.target?.postMessage(msg);
  }

  terminate(): void {
    this.dead = true;
    this.target?.terminate();
    this.target = null;
    this.buffer = [];
  }

  private fallback(): void {
    if (this.mode === 'inline' || this.dead) return;
    this.mode = 'inline';
    this.target = null;
    console.warn('CENTRIFUGE: module workers unavailable here; running the simulation on the main thread.');
    void import('./inline').then(({ InlineWorker }) => {
      if (this.dead) return;
      const w = new InlineWorker();
      w.onmessage = (e) => this.onmessage?.(e);
      this.target = w;
      this.answered = true;
      const queued = this.buffer;
      this.buffer = [];
      for (const m of queued) w.postMessage(m);
    });
  }
}
