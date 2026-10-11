/**
 * Seeded, deterministic random numbers. Uncertainty is sampled ONCE at
 * configuration time (or as deterministic functions of altitude/time) and is
 * never drawn per integration step, so changing numerical tolerances can never
 * change the physical scenario.
 */

/** SplitMix32-style hash of (seed, stream) -> uint32. */
export function hash32(seed: number, stream: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (stream + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Mulberry32 generator. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Standard normal via Box-Muller. */
  normal(): number {
    let u = this.next();
    if (u < 1e-12) u = 1e-12;
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** A named, independent stream derived from the master seed. */
export function streamRng(seed: number, name: string): Rng {
  let s = 0;
  for (let i = 0; i < name.length; i++) s = (Math.imul(s, 31) + name.charCodeAt(i)) >>> 0;
  return new Rng(hash32(seed, s));
}
