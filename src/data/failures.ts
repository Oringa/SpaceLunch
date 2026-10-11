/**
 * Deterministic failing reference cases, one per modelled failure class.
 * Also offered in the interface as "learn from a failure" examples.
 */
import type { SimConfig } from '../sim/config';
import type { FailureKind } from '../sim/session';
import { instrumentHop, edgeOfSpace, leoReference } from './designs';

export interface FailureCase {
  id: string;
  expected: FailureKind | 'mission:ground-contact';
  title: string;
  lesson: string;
  make: () => SimConfig;
}

export const FAILURE_CASES: FailureCase[] = [
  {
    id: 'fail-component-load', expected: 'component-load', title: 'Ordinary avionics on a centrifuge',
    lesson: 'Unhardened electronics cannot sit at thousands of g for the minutes a spin-up takes.',
    make: () => { const c = instrumentHop(); c.name = 'Failure: ordinary avionics'; c.vehicle.payloadId = 'commercial-avionics'; return c; },
  },
  {
    id: 'fail-structural', expected: 'structural-limit', title: 'Aluminium arm at 1 km/s',
    lesson: 'A spinning bar fails near v = sqrt(2 sigma / rho) regardless of its size: specific strength, not size, sets tip speed.',
    make: () => { const c = instrumentHop(); c.name = 'Failure: aluminium arm'; c.launcher.arm.materialId = 'al-7075'; return c; },
  },
  {
    id: 'fail-bearing', expected: 'bearing-envelope', title: 'Fixed counterbalance, small bearing',
    lesson: 'When the vehicle leaves, the rotor is suddenly unbalanced by m R: the bearing sees m omega^2 R.',
    make: () => { const c = edgeOfSpace(); c.name = 'Failure: post-release imbalance'; c.launcher.balanceId = 'fixed-static'; c.launcher.bearingId = 'hydrodynamic-small'; return c; },
  },
  {
    id: 'fail-exit-collision', expected: 'exit-collision', title: 'Rigid cradle',
    lesson: 'A rigidly mounted vehicle keeps pitching at the rotor rate after release and swings into the tunnel wall.',
    make: () => { const c = instrumentHop(); c.name = 'Failure: rigid cradle'; c.launcher.mountId = 'rigid'; return c; },
  },
  {
    id: 'fail-timing', expected: 'exit-collision', title: 'Release 0.5 ms late',
    lesson: 'Direction error is omega times timing error; at the tunnel exit the offset is that angle times the path length.',
    make: () => { const c = edgeOfSpace(); c.name = 'Failure: late release'; c.launcher.release.timingOffsetS = 5e-4; return c; },
  },
  {
    id: 'fail-aero-overload', expected: 'aero-overload', title: 'Unfinned, aft-heavy orbital vehicle',
    lesson: 'With the centre of pressure ahead of the CG the vehicle diverges in the dense air right after exit.',
    make: () => { const c = leoReference(); c.name = 'Failure: unstable, no fins'; c.vehicle.finsId = 'none'; c.launcher.exit.apertureRadiusM = 0.6; return c; },
  },
  {
    id: 'fail-unstable', expected: 'unstable-flight', title: 'Unstable vehicle with a stiff airframe',
    lesson: 'Even when the structure survives, an angle of attack beyond the envelope at high dynamic pressure is a loss of control.',
    make: () => { const c = leoReference(); c.name = 'Failure: loss of control'; c.vehicle.finsId = 'none'; c.launcher.exit.apertureRadiusM = 0.6; c.vehicle.maxNormalForceN = 5e6; return c; },
  },
  {
    id: 'fail-thermal', expected: 'thermal-envelope', title: 'Bare aluminium nose at 2 km/s',
    lesson: 'Stagnation heating scales with V^3 sqrt(rho / r_n): the first seconds after exit are the hottest.',
    make: () => { const c = edgeOfSpace(); c.name = 'Failure: no thermal protection'; c.vehicle.protectionId = 'none'; return c; },
  },
  {
    id: 'fail-propellant', expected: 'propellant-exhausted', title: 'Too much payload for the upper stage',
    lesson: 'Delta-v is Isp g0 ln(m0/mf); extra payload raises mf for every stage.',
    make: () => { const c = leoReference(); c.name = 'Failure: propellant exhausted'; c.vehicle.payloadMassKg = 30; return c; },
  },
  {
    id: 'fail-ground', expected: 'mission:ground-contact', title: 'Orbital vehicle without a burn',
    lesson: 'Reaching 100 km is not orbit: without horizontal speed the trajectory intersects Earth.',
    make: () => { const c = leoReference(); c.name = 'Failure: no upper-stage burn'; c.flightPlan.guidance.mode = 'none'; return c; },
  },
];
