/**
 * Finite-duration rocket propulsion with changing mass [R10]:
 *     mdot = -F / (Isp g0)
 *     dv_ideal = Isp g0 ln(m0 / mf)
 * Mass flow is set by throttle; specific impulse and thrust vary linearly with
 * ambient pressure between sea-level and vacuum values, keeping F = mdot g0 Isp(p)
 * consistent.
 */
import { G0, P0_SEA_LEVEL } from './constants';
import { prov, type Provenance } from './provenance';

export interface StageSpec {
  id: string;
  name: string;
  dryMass: number;
  propellantMass: number;
  propellantDensity: number;
  thrustVac: number;
  ispVac: number;
  ispSl: number;
  minThrottle: number;
  maxIgnitions: number;
  gimbalMaxDeg: number;
  /** Lateral/axial acceleration envelopes for the stage hardware (g). */
  lateralSustainedG: number;
  lateralPeakG: number;
  axialPeakG: number;
  /** Engine + interstage length (m), added to tank length. */
  engineLength: number;
  costCredits: number;
  provenance: Provenance;
}

/** Full-throttle mass flow (kg/s). */
export const massFlowFull = (s: StageSpec): number => s.thrustVac / (s.ispVac * G0);

/** Effective specific impulse at ambient pressure p (s). */
export function ispAt(s: StageSpec, p: number): number {
  const f = Math.min(1, Math.max(0, p / P0_SEA_LEVEL));
  return s.ispVac - (s.ispVac - s.ispSl) * f;
}

/** Thrust at throttle (fraction of full mass flow) and ambient pressure. */
export function thrustAt(s: StageSpec, throttle: number, p: number): number {
  return throttle * massFlowFull(s) * G0 * ispAt(s, p);
}

export const idealDeltaV = (isp: number, m0: number, mf: number): number => isp * G0 * Math.log(m0 / mf);

export const PROPULSION_PROVENANCE = prov(
  'physical-law',
  ['R10'],
  'Rocket equation and mass flow are exact for constant exhaust velocity; the linear Isp(p) interpolation between sea-level and vacuum values is an engineering approximation. Base-drag changes while the engine burns are not modelled.',
);
