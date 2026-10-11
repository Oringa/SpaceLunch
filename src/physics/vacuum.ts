/**
 * Idealised isothermal chamber pump-down:
 *     dp/dt = (Q - S p) / V,
 * with constant pumping speed S, constant gas load Q (leakage + outgassing
 * proportional to internal surface area) and a stated ultimate-pressure floor.
 *     p(t) = Q/S + (p0 - Q/S) exp(-S t / V)
 */
import { prov } from './provenance';

export interface VacuumParams {
  volume: number;
  surfaceArea: number;
  pumpSpeed: number;
  /** Gas load per unit internal surface area (Pa m^3/s per m^2). */
  gasLoadPerArea: number;
  ultimatePressure: number;
  initialPressure: number;
  targetPressure: number;
  pumpPowerW: number;
}

export interface PumpdownResult {
  feasible: boolean;
  gasLoad: number;
  /** Lowest reachable pressure. */
  floorPressure: number;
  /** Time to reach the target (s); Infinity if infeasible. */
  time: number;
  energyJ: number;
  reason?: string;
}

export function pumpdown(p: VacuumParams): PumpdownResult {
  const Q = p.gasLoadPerArea * p.surfaceArea;
  const pEq = Q / p.pumpSpeed;
  const floor = Math.max(pEq, p.ultimatePressure);
  if (p.targetPressure >= p.initialPressure) {
    return { feasible: true, gasLoad: Q, floorPressure: floor, time: 0, energyJ: 0 };
  }
  if (p.targetPressure <= floor * 1.0001) {
    return {
      feasible: false,
      gasLoad: Q,
      floorPressure: floor,
      time: Infinity,
      energyJ: Infinity,
      reason: `Target ${fmtP(p.targetPressure)} is below the reachable floor ${fmtP(floor)} (gas load ${Q.toExponential(2)} Pa·m³/s, pump ${p.pumpSpeed} m³/s${p.ultimatePressure >= pEq ? ', ultimate-pressure limited' : ''}).`,
    };
  }
  const t = (p.volume / p.pumpSpeed) * Math.log((p.initialPressure - pEq) / (p.targetPressure - pEq));
  return { feasible: true, gasLoad: Q, floorPressure: floor, time: t, energyJ: t * p.pumpPowerW };
}

export function pressureAt(p: VacuumParams, t: number): number {
  const Q = p.gasLoadPerArea * p.surfaceArea;
  const pEq = Q / p.pumpSpeed;
  const pr = pEq + (p.initialPressure - pEq) * Math.exp((-p.pumpSpeed * t) / p.volume);
  return Math.max(pr, p.ultimatePressure, p.targetPressure);
}

const fmtP = (x: number): string => (x >= 1 ? `${x.toPrecision(3)} Pa` : `${x.toExponential(2)} Pa`);

export const VACUUM_PROVENANCE = prov(
  'engineering-approximation',
  [],
  'Isothermal lumped chamber; constant pumping speed (real pumps lose speed at low pressure); gas load modelled as a constant per unit internal area; ultimate-pressure floor; no gas-flow transient at the exit membrane.',
);
