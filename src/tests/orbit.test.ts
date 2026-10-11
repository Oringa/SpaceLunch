import { describe, expect, it } from 'vitest';
import { orbitalElements, circularSpeed, conicSamples } from '../physics/orbit';
import { MU_EARTH, R_EARTH } from '../physics/constants';
import type { Vec3 } from '../physics/vec3';

const finiteOrInf = (x: number): boolean => !Number.isNaN(x);

describe('orbital elements', () => {
  it('200 km circular orbit speed is 7,788.488 m/s', () => {
    expect(circularSpeed(R_EARTH + 200e3)).toBeCloseTo(7788.488, 2);
  });
  it('circular orbit elements', () => {
    const r: Vec3 = [R_EARTH + 200e3, 0, 0];
    const v: Vec3 = [0, circularSpeed(r[0]), 0];
    const el = orbitalElements(r, v);
    expect(el.bound).toBe(true);
    expect(el.eccentricity).toBeLessThan(1e-12);
    expect(el.periapsisAltitude).toBeCloseTo(200e3, 3);
    expect(el.apoapsisAltitude).toBeCloseTo(200e3, 3);
    expect(el.period).toBeCloseTo(2 * Math.PI * Math.sqrt(r[0] ** 3 / MU_EARTH), 6);
    expect(el.inclination).toBeCloseTo(0, 12);
  });
  it('radial trajectory: no NaN, Earth-intersecting, not an orbit even when bound', () => {
    const r: Vec3 = [R_EARTH, 0, 0];
    const el = orbitalElements(r, [2000, 0, 0]);
    expect(el.kind).toBe('radial');
    expect(el.intersectsEarth).toBe(true);
    expect(el.inclination).toBeNull();
    expect(el.apoapsisAltitude).toBeCloseTo(210386, -1);
    for (const v of Object.values(el)) if (typeof v === 'number') expect(finiteOrInf(v)).toBe(true);
  });
  it('parabolic and hyperbolic: infinite apoapsis and period, no NaN', () => {
    const r: Vec3 = [R_EARTH + 300e3, 0, 0];
    const vesc = Math.sqrt((2 * MU_EARTH) / r[0]);
    for (const f of [1, 1.3]) {
      const el = orbitalElements(r, [0, vesc * f, 0]);
      expect(el.bound).toBe(false);
      expect(el.apoapsisAltitude).toBe(Infinity);
      expect(el.period).toBe(Infinity);
      expect(Number.isFinite(el.periapsisAltitude)).toBe(true);
      for (const v of Object.values(el)) if (typeof v === 'number') expect(finiteOrInf(v)).toBe(true);
    }
  });
  it('nearly circular orbit has stable apoapsis (no 0/0)', () => {
    const r: Vec3 = [R_EARTH + 400e3, 0, 0];
    const el = orbitalElements(r, [1e-9, circularSpeed(r[0]) * (1 + 1e-12), 0]);
    expect(Math.abs(el.apoapsisAltitude - 400e3)).toBeLessThan(1);
  });
  it('inclination from a 33 deg site launched due east', () => {
    const lat = (33 * Math.PI) / 180;
    const r: Vec3 = [R_EARTH * Math.cos(lat), 0, R_EARTH * Math.sin(lat)];
    const v: Vec3 = [0, 7800, 0];
    expect(((orbitalElements(r, v).inclination ?? 0) * 180) / Math.PI).toBeCloseTo(33, 6);
  });
  it('conic samples continue to the surface for a suborbital arc', () => {
    const r: Vec3 = [R_EARTH + 100e3, 0, 0];
    const out = conicSamples(r, [500, 2000, 0], 200);
    expect(out.hitsEarth).toBe(true);
    const last = out.points[out.points.length - 1];
    expect(Math.hypot(...last)).toBeCloseTo(R_EARTH, 0);
  });
});
