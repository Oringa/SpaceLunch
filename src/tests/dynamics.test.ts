/** Analytical and invariant checks of the free-flight equations (section 8, tests 1-7). */
import { describe, expect, it } from 'vitest';
import { makeRig, constantAtmosphere, flatFamily } from './helpers';
import { FS } from '../physics/flight';
import { R_EARTH, MU_EARTH, G0 } from '../physics/constants';
import { qRotate, qNormalize, type Quat } from '../physics/quat';
import { orbitalElements, circularSpeed } from '../physics/orbit';
import { locateRoot } from '../physics/integrator';
import { baseConfig } from '../data/defaults';
import { cross, norm, type Vec3 } from '../physics/vec3';
import { idealDeltaV } from '../physics/propulsion';

export const RESULTS: Record<string, number> = {};

describe('test 1: no gravity, no air', () => {
  it('detached motion is straight and constant-velocity', () => {
    const { integ, y0 } = makeRig({ gravity: false, atmosphere: null });
    y0.set([R_EARTH + 5e5, 0, 0], 0);
    y0.set([1234.5, -2000, 777], 3);
    integ.reset(0, y0);
    while (integ.t < 1000) integ.step(1000);
    const y = integ.y;
    expect(Math.abs(y[3] - 1234.5)).toBeLessThan(1e-9);
    expect(Math.abs(y[4] + 2000)).toBeLessThan(1e-9);
    expect(Math.abs(y[0] - (R_EARTH + 5e5 + 1234.5 * 1000))).toBeLessThan(1e-5);
    expect(Math.abs(y[2] - 777 * 1000)).toBeLessThan(1e-5);
  });
  it('torque-free rigid body conserves inertial angular momentum and rotational energy', () => {
    const { integ, y0, model } = makeRig({ gravity: false, atmosphere: null });
    y0.set([R_EARTH + 5e5, 0, 0], 0);
    y0.set([3, 0.7, -0.4], FS.WX);
    integ.reset(0, y0);
    const H = (y: Float64Array): Vec3 => {
      const mp = model.massProps(y);
      const q = qNormalize([y[6], y[7], y[8], y[9]] as Quat);
      return qRotate(q, [mp.ixx * y[10], mp.iyy * y[11], mp.iyy * y[12]]);
    };
    const E = (y: Float64Array): number => {
      const mp = model.massProps(y);
      return 0.5 * (mp.ixx * y[10] ** 2 + mp.iyy * (y[11] ** 2 + y[12] ** 2));
    };
    const h0 = H(integ.y), e0 = E(integ.y);
    while (integ.t < 200) integ.step(200);
    const h1 = H(integ.y);
    const dh = norm([h1[0] - h0[0], h1[1] - h0[1], h1[2] - h0[2]]) / norm(h0);
    const de = Math.abs(E(integ.y) - e0) / e0;
    RESULTS.angularMomentumDrift = dh;
    expect(dh).toBeLessThan(1e-8);
    expect(de).toBeLessThan(1e-8);
    // Precession actually happened (non-trivial test).
    expect(Math.abs(integ.y[11] - 0.7)).toBeGreaterThan(1e-3);
  });
  it('quaternion convention: +0.1 rad about body +y maps x_b to (cos, 0, -sin)', () => {
    const { integ, y0 } = makeRig({ gravity: false, atmosphere: null });
    y0.set([R_EARTH + 5e5, 0, 0], 0);
    y0.set([0, 0.1, 0], FS.WX);
    integ.reset(0, y0);
    while (integ.t < 1) integ.step(1);
    const x = qRotate(qNormalize([integ.y[6], integ.y[7], integ.y[8], integ.y[9]] as Quat), [1, 0, 0]);
    expect(x[0]).toBeCloseTo(Math.cos(0.1), 10);
    expect(x[1]).toBeCloseTo(0, 10);
    expect(x[2]).toBeCloseTo(-Math.sin(0.1), 10);
  });
});

describe('test 2: radial launch at 2000 m/s, no air, no rotation', () => {
  it('reaches 210.386 km and returns; never classified as an orbit', () => {
    const { integ, y0 } = makeRig({ gravity: true, atmosphere: null, fidelity: 'assisted' });
    y0.set([R_EARTH, 0, 0], 0);
    y0.set([2000, 0, 0], 3);
    integ.reset(0, y0);
    let prev = 2000 * R_EARTH;
    let apogee = NaN;
    const tmp = new Float64Array(FS.N);
    const g = (t: number): number => { integ.dense(t, tmp); return tmp[0] * tmp[3]; };
    for (let i = 0; i < 100000; i++) {
      const t0 = integ.t;
      integ.step();
      const rv = integ.y[0] * integ.y[3];
      if (prev > 0 && rv <= 0) {
        const ta = locateRoot(g, t0, integ.t, prev, rv, 1e-12);
        integ.dense(ta, tmp);
        apogee = tmp[0] - R_EARTH;
        const el = orbitalElements([integ.y[0], integ.y[1], integ.y[2]], [integ.y[3], integ.y[4], integ.y[5]]);
        expect(el.kind).toBe('radial');
        expect(el.intersectsEarth).toBe(true);
      }
      prev = rv;
      if (integ.y[0] < R_EARTH) break;
    }
    RESULTS.radialApogee = apogee;
    expect(apogee).toBeCloseTo(210386, -1);
    expect(Math.abs(apogee - 210386)).toBeLessThan(2);
    expect(integ.y[0]).toBeLessThan(R_EARTH);
  });
});

describe('test 3: 200 km circular orbit, gravity only', () => {
  it('speed 7,788.488 m/s; ten-orbit energy and angular-momentum drift < 1e-6', () => {
    const c = baseConfig();
    const { integ, y0 } = makeRig({ config: c, gravity: true, atmosphere: null, rtol: c.integrator.rtol, hMax: c.integrator.hMaxCoastS });
    const r0 = R_EARTH + 200e3;
    const v0 = circularSpeed(r0);
    expect(v0).toBeCloseTo(7788.488, 2);
    y0.set([r0, 0, 0], 0);
    y0.set([0, v0 * Math.cos(0.5), v0 * Math.sin(0.5)], 3);
    // Use the production tolerances (position 1 mm) for this test.
    integ.opts.atol[0] = integ.opts.atol[1] = integ.opts.atol[2] = c.integrator.positionTolM;
    integ.opts.atol[3] = integ.opts.atol[4] = integ.opts.atol[5] = c.integrator.positionTolM * 1e-3;
    integ.reset(0, y0);
    const T = 2 * Math.PI * Math.sqrt(r0 ** 3 / MU_EARTH);
    const energy = (y: Float64Array): number => 0.5 * (y[3] ** 2 + y[4] ** 2 + y[5] ** 2) - MU_EARTH / Math.hypot(y[0], y[1], y[2]);
    const hmag = (y: Float64Array): number => norm(cross([y[0], y[1], y[2]], [y[3], y[4], y[5]]));
    const e0 = energy(integ.y), h0 = hmag(integ.y);
    while (integ.t < 10 * T) integ.step(10 * T);
    const dE = Math.abs((energy(integ.y) - e0) / e0);
    const dH = Math.abs((hmag(integ.y) - h0) / h0);
    RESULTS.tenOrbitEnergyDrift = dE;
    RESULTS.tenOrbitMomentumDrift = dH;
    RESULTS.tenOrbitSteps = integ.naccept;
    expect(dE).toBeLessThan(1e-6);
    expect(dH).toBeLessThan(1e-6);
  });
});

describe('test 4: constant-density drag-only motion', () => {
  it('matches v(t) = v0 / (1 + k v0 t), k = rho Cd A / (2 m)', () => {
    const rho = 0.5, cd = 0.3;
    const c = baseConfig();
    c.vehicle.finsId = 'none'; // fins add their own drag increment; the analytic case needs constant Cd
    const { integ, y0, model, scenario } = makeRig({ config: c, gravity: false, atmosphere: constantAtmosphere(rho), fidelity: 'assisted', family: flatFamily(cd) });
    y0.set([R_EARTH + 1e4, 0, 0], 0);
    const v0 = 1500;
    y0.set([0, v0, 0], 3);
    integ.reset(0, y0);
    const m = model.massProps(y0).mass;
    const k = (rho * cd * scenario.vehicle.refArea) / (2 * m);
    let maxRel = 0;
    while (integ.t < 30) {
      integ.step(30);
      const v = Math.hypot(integ.y[3], integ.y[4], integ.y[5]);
      const exact = v0 / (1 + k * v0 * integ.t);
      maxRel = Math.max(maxRel, Math.abs(v - exact) / exact);
    }
    RESULTS.dragAnalyticMaxRelError = maxRel;
    expect(maxRel).toBeLessThan(1e-8);
  });
});

describe('test 6: vacuum mass independence and drag passivity', () => {
  it('identical vacuum trajectories for different masses', () => {
    const run = (payload: number): Float64Array => {
      const c = baseConfig();
      c.vehicle.payloadMassKg = payload;
      const { integ, y0 } = makeRig({ config: c, gravity: true, atmosphere: null, fidelity: 'assisted' });
      y0.set([R_EARTH + 1000, 0, 0], 0);
      y0.set([1500, 1200, 300], 3);
      integ.reset(0, y0);
      while (integ.t < 300) integ.step(300);
      return integ.y.slice(0, 6);
    };
    const a = run(5), b = run(200);
    for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-4);
    for (let i = 3; i < 6; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(1e-7);
  });
  it('aerodynamic force never does positive work relative to still air, at any attitude', () => {
    const { model } = makeRig({ gravity: true, atmosphere: constantAtmosphere(1.0), fidelity: 'engineering', config: (() => { const c = baseConfig(); c.vehicle.finsId = 'large-tail'; c.launcher.exit.apertureRadiusM = 0.8; return c; })() });
    const y = new Float64Array(FS.N);
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    let worst = -Infinity;
    for (let i = 0; i < 3000; i++) {
      y.set([R_EARTH + 1000, 0, 0], 0);
      const sp = 50 + Math.abs(rnd()) * 6000;
      const dir = [rnd(), rnd(), rnd()];
      const n = Math.hypot(...dir);
      y.set([sp * dir[0] / n, sp * dir[1] / n, sp * dir[2] / n], 3);
      const q = qNormalize([rnd(), rnd(), rnd(), rnd()] as Quat);
      y.set(q, 6);
      y.set([rnd() * 3, rnd() * 3, rnd() * 3], 10);
      y[FS.T1] = y[FS.T2] = y[FS.T3] = y[FS.T4] = 300;
      const d = model.evaluate(0, y);
      const p = d.forceAero[0] * d.vAir[0] + d.forceAero[1] * d.vAir[1] + d.forceAero[2] * d.vAir[2];
      const scale = norm(d.forceAero) * d.vAirMag + 1e-30;
      worst = Math.max(worst, p / scale);
    }
    RESULTS.worstAeroPowerRatio = worst;
    expect(worst).toBeLessThanOrEqual(1e-12);
  });
});

describe('test 7: rocket equation', () => {
  it('gravity-free, drag-free constant-Isp burn matches the ideal rocket equation; propellant never negative', () => {
    const c = baseConfig();
    c.vehicle.stackId = 'kick-solid';
    c.vehicle.lengthM = 3.2;
    c.flightPlan.guidance.mode = 'prograde';
    const { integ, y0, model, scenario } = makeRig({ config: c, gravity: false, atmosphere: null, fidelity: 'assisted', discrete: { engineOn: true, aeroshellAttached: false, attitudeMode: 'guidance' } });
    y0.set([R_EARTH + 5e5, 0, 0], 0);
    y0.set([0, 100, 0], 3);
    integ.reset(0, y0);
    const m0 = model.massProps(integ.y).mass;
    const tmp = new Float64Array(FS.N);
    for (let i = 0; i < 100000; i++) {
      const t0 = integ.t;
      const p0 = integ.y[FS.MPROP];
      integ.step();
      if (integ.y[FS.MPROP] <= 0) {
        const tb = locateRoot((t) => integ.dense(t, tmp)[FS.MPROP], t0, integ.t, p0, integ.y[FS.MPROP], 1e-12);
        integ.dense(tb, tmp);
        tmp[FS.MPROP] = 0;
        model.discrete.engineOn = false;
        integ.reset(tb, tmp);
        break;
      }
    }
    const mf = model.massProps(integ.y).mass;
    const dv = Math.hypot(integ.y[3], integ.y[4], integ.y[5]) - 100;
    const ideal = idealDeltaV(scenario.stages[0].ispVac, m0, mf);
    RESULTS.rocketEquationRelError = Math.abs(dv - ideal) / ideal;
    expect(Math.abs(dv - ideal) / ideal).toBeLessThan(1e-9);
    expect(m0 - mf).toBeCloseTo(scenario.stages[0].propellantMass, 6);
    while (integ.t < tmp.length + 50) integ.step();
    expect(integ.y[FS.MPROP]).toBeGreaterThanOrEqual(0);
    expect(G0).toBe(9.80665);
  });
});
