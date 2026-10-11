/**
 * Play mode rebuilds the hardware around the player's choices: a heavier
 * payload or an added rocket stage gets a longer (and if needed wider)
 * vehicle, and a longer arm or bigger vehicle gets a chamber and exit port
 * with the same clearances as the design the player started from. This
 * removes geometry chores that would otherwise refuse the launch; the
 * physics and the failure checks are unchanged, so an overstressed arm,
 * an overloaded payload or a weak motor still fails, in flight.
 */
import { cloneConfig, type SimConfig } from '../sim/config';
import { vehicleCornerRadius, vehicleEnvelopeRadius } from '../sim/build';
import { AERO_FAMILIES } from '../physics/aero';
import { internalStackLength, minimumVehicleLength } from '../physics/vehicle';
import { PAYLOAD_PRESETS, STAGE_PRESETS, UPPER_STAGE_STACKS } from '../data/presets';

/** Longest length-to-diameter ratio before the vehicle is widened instead of lengthened. */
const MAX_FINENESS = 14;
const r2 = (x: number): number => Math.round(x * 100) / 100;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export function fitToDesign(base: SimConfig, next: SimConfig): SimConfig {
  const c = cloneConfig(next);
  const V = c.vehicle;
  const fam = AERO_FAMILIES[V.aeroFamilyId];
  const payload = PAYLOAD_PRESETS[V.payloadId];
  const stack = UPPER_STAGE_STACKS[V.stackId];
  if (fam && payload && stack) {
    const stages = stack.stages.map((id) => STAGE_PRESETS[id]).filter((x) => !!x);
    const need = (d: number): number => 1.03 * minimumVehicleLength(fam, d, internalStackLength(d, V.payloadMassKg, payload.bulkDensity, stages));
    // Never smaller than the design the player started from.
    let D = base.vehicle.diameterM;
    let L = Math.max(base.vehicle.lengthM, need(D));
    for (let i = 0; i < 60 && L / D > MAX_FINENESS; i++) {
      D *= 1.06;
      L = Math.max(base.vehicle.lengthM, need(D));
    }
    const nose = base.vehicle.noseRadiusM * (D / base.vehicle.diameterM);
    V.diameterM = r3(D);
    V.lengthM = r2(L);
    V.noseRadiusM = r3(Math.min(Math.max(nose, 0.003), 0.95 * fam.maxNoseRadiusFraction * V.diameterM));
  }
  const gap = Math.max(0.5, base.launcher.chamberRadiusM - vehicleCornerRadius(base.launcher.armRadiusM, base.vehicle));
  c.launcher.chamberRadiusM = r2(vehicleCornerRadius(c.launcher.armRadiusM, V) + gap);
  const margin = Math.max(0.03, base.launcher.exit.apertureRadiusM - vehicleEnvelopeRadius(base.vehicle));
  c.launcher.exit.apertureRadiusM = r3(vehicleEnvelopeRadius(V) + margin);
  return c;
}
