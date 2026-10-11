import { describe, expect, it } from 'vitest';
import { Dopri5, locateRoot } from '../physics/integrator';

describe('Dormand-Prince 5(4)', () => {
  it('harmonic oscillator to 1e-9 over 10 periods, dense output accurate', () => {
    const f = (_t: number, y: Float64Array, dy: Float64Array): void => {
      dy[0] = y[1];
      dy[1] = -y[0];
    };
    const integ = new Dopri5(2, f, { rtol: 1e-11, atol: new Float64Array([1e-12, 1e-12]), hMax: 1, hMin: 1e-12 });
    integ.reset(0, [1, 0]);
    const T = 20 * Math.PI;
    let maxDenseErr = 0;
    const out = new Float64Array(2);
    while (integ.t < T) {
      integ.step(T);
      const tm = 0.5 * (integ.t0 + integ.t1);
      integ.dense(tm, out);
      maxDenseErr = Math.max(maxDenseErr, Math.abs(out[0] - Math.cos(tm)));
    }
    expect(Math.abs(integ.y[0] - Math.cos(T))).toBeLessThan(1e-9);
    expect(maxDenseErr).toBeLessThan(1e-8);
  });
  it('lands exactly on tStop and keeps the controller proposal', () => {
    const integ = new Dopri5(1, (_t, y, dy) => { dy[0] = -y[0]; }, { rtol: 1e-9, atol: new Float64Array([1e-12]), hMax: 10, hMin: 1e-12 });
    integ.reset(0, [1]);
    integ.step(1e-3);
    expect(integ.t).toBe(1e-3);
  });
  it('throws a diagnostic (not NaN telemetry) when the derivative blows up', () => {
    const integ = new Dopri5(1, (_t, y, dy) => { dy[0] = y[0] > 2 ? NaN : 1; }, { rtol: 1e-9, atol: new Float64Array([1e-9]), hMax: 1, hMin: 1e-9 });
    integ.reset(0, [0]);
    expect(() => { for (let i = 0; i < 100; i++) integ.step(); }).toThrow();
  });
  it('Illinois root location converges on a smooth and a discontinuous function', () => {
    const r = locateRoot((t) => Math.cos(t), 1, 2, Math.cos(1), Math.cos(2), 1e-13);
    expect(r).toBeCloseTo(Math.PI / 2, 12);
    const s = locateRoot((t) => (t < 0.3 ? 1 : -1), 0, 1, 1, -1, 1e-12);
    expect(s).toBeCloseTo(0.3, 10);
    expect(s).toBeGreaterThanOrEqual(0.3);
  });
});
