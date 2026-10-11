/**
 * Main-thread stand-in for the simulation worker (see resilient.ts). Runs
 * the same WorkerHost; messages are cloned and delivered asynchronously so
 * the controller sees the same message semantics as with a real worker.
 */
import { WorkerHost } from './engine';
import type { FromWorker, ToWorker } from './protocol';
import type { WorkerLike } from './resilient';

export class InlineWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
  private dead = false;
  private readonly host = new WorkerHost(
    (msg: FromWorker) => {
      setTimeout(() => {
        if (!this.dead) this.onmessage?.({ data: msg } as MessageEvent<FromWorker>);
      }, 0);
    },
    () => performance.now(),
    (fn, ms) => setTimeout(() => {
      if (!this.dead) fn();
    }, ms),
  );

  postMessage(msg: ToWorker): void {
    const copy = structuredClone(msg);
    setTimeout(() => {
      if (!this.dead) this.host.handle(copy);
    }, 0);
  }

  terminate(): void {
    this.dead = true;
  }
}
