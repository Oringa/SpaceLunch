/// <reference lib="webworker" />
/**
 * Simulation worker entry. Owns authoritative state for one live run and
 * runs prediction/batch jobs cooperatively. Created with Vite's documented
 * module-worker pattern:
 *   new Worker(new URL('./workers/simulation.worker.ts', import.meta.url), { type: 'module' })
 */
import { WorkerHost } from './engine';
import type { FromWorker, ToWorker } from './protocol';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const host = new WorkerHost(
  (msg: FromWorker, transfer?: Transferable[]) => ctx.postMessage(msg, transfer ?? []),
  () => performance.now(),
  (fn, ms) => setTimeout(fn, ms),
);
ctx.onmessage = (e: MessageEvent<ToWorker>) => host.handle(e.data);
