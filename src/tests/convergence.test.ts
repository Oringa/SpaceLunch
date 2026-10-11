/** Test 8: tighter tolerances and smaller step caps converge on key outcomes. */
import { describe, expect, it } from 'vitest';
import { designById } from '../data/designs';
import { buildScenario } from '../sim/build';
import { Session, type RunSummary } from '../sim/session';
import type { SimConfig } from '../sim/config';

export const CONVERGENCE: Record<string, Record<string, number[]>> = {};

function level(c: SimConfig, k: number): SimConfig {
  // k = 0 coarse, 1 default, 2 fine
  const f = [10, 1, 0.1][k];
  const capF = [4, 1, 0.25][k];
  const I = c.integrator;
  I.rtol *= f;
  I.positionTolM *= f;
  I.hMaxCorridorS *= capF;
  I.hMaxAtmosphereS *= capF;
  I.hMaxBurnS *= capF;
  I.hMaxCoastS *= capF;
  I.hMaxRotorS *= capF;
  return c;
}

function run(id: string, k: number, mutate?: (c: SimConfig) => void): RunSummary {
  const c = level(designById(id), k);
  mutate?.(c);
  const s = new Session(buildScenario(c));
  s.runToEnd();
  return s.summary();
}

describe('numerical convergence', () => {
  it('suborbital: apogee, peak q, peak heat flux, release clearance', () => {
    const r = [0, 1, 2].map((k) => run('edge-of-space', k));
    const q = (s: RunSummary): Record<string, number> => ({
      apogee: s.extrema.maxAltitude.value,
      maxQ: s.extrema.maxQ.value,
      heat: s.extrema.maxHeatFlux.value,
      clearance: s.extrema.minClearance.value,
      t1: s.extrema.maxT1.value,
    });
    const v = r.map(q);
    CONVERGENCE.suborbital = Object.fromEntries(Object.keys(v[0]).map((k) => [k, v.map((x) => x[k])]));
    // Default vs fine agree tightly.
    expect(Math.abs(v[1].apogee - v[2].apogee)).toBeLessThan(5);
    expect(Math.abs(v[1].maxQ - v[2].maxQ) / v[2].maxQ).toBeLessThan(1e-3);
    expect(Math.abs(v[1].heat - v[2].heat) / v[2].heat).toBeLessThan(1e-3);
    expect(Math.abs(v[1].clearance - v[2].clearance)).toBeLessThan(1e-4);
    expect(Math.abs(v[1].t1 - v[2].t1)).toBeLessThan(1);
    // Coarse is no closer than default (convergent sequence).
    expect(Math.abs(v[0].apogee - v[2].apogee) + 1e-3).toBeGreaterThanOrEqual(Math.abs(v[1].apogee - v[2].apogee) * 0.5);
  });
  it('narrow release window: clearance converges near the tolerance limit', () => {
    const r = [1, 2].map((k) => run('edge-of-space', k, (c) => { c.launcher.release.timingOffsetS = 1.2e-4; c.launcher.release.timingJitterStdS = 0; }));
    CONVERGENCE.narrowWindow = { clearance: r.map((s) => s.extrema.minClearance.value) };
    expect(r[0].failure?.kind).toBe(r[1].failure?.kind);
    expect(Math.abs(r[0].extrema.minClearance.value - r[1].extrema.minClearance.value)).toBeLessThan(1e-4);
  });
  it('orbital: insertion elements', () => {
    const r = [1, 2].map((k) => run('leo-reference', k));
    for (const s of r) expect(s.orbit).toBeDefined();
    const peri = r.map((s) => s.orbit!.periapsisAltitude);
    const apo = r.map((s) => s.orbit!.apoapsisAltitude);
    const inc = r.map((s) => s.orbit!.inclination ?? 0);
    CONVERGENCE.orbital = { periapsis: peri, apoapsis: apo, inclination: inc };
    expect(Math.abs(peri[0] - peri[1])).toBeLessThan(200);
    expect(Math.abs(apo[0] - apo[1])).toBeLessThan(2000);
    expect(Math.abs(inc[0] - inc[1])).toBeLessThan(1e-4);
  });
});
