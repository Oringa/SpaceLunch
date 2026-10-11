/**
 * Minimal external store for React (useSyncExternalStore). High-rate data
 * (snapshots, telemetry) lives in the controller and is sampled by React at
 * ~10 Hz; it never flows through React state at solver rate.
 */
import { useSyncExternalStore } from 'react';

export class Store<S extends object> {
  private state: S;
  private listeners = new Set<() => void>();
  constructor(initial: S) {
    this.state = initial;
  }
  get(): S {
    return this.state;
  }
  set(patch: Partial<S> | ((s: S) => Partial<S>)): void {
    const p = typeof patch === 'function' ? patch(this.state) : patch;
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }
  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
}

export function useStore<S extends object, T>(store: Store<S>, select: (s: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.get()), () => select(store.get()));
}
