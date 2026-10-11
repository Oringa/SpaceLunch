/**
 * Vehicle geometry and mass properties built from components.
 *
 * Body axis convention: x_body points from the tail toward the nose. Axial
 * stations "x" are measured from the nose of the current outer body toward the
 * tail (positive aft). The vehicle is axisymmetric: I_yy = I_zz.
 *
 * Two configurations share one implementation:
 *   aeroshell attached : outer body = aeroshell; the stack (payload + stages) sits inside.
 *   aeroshell jettisoned: outer body = exposed stack (payload on top, stages below).
 * Propellant is modelled as a settled cylinder at the bottom of its tank so
 * CG and inertia move as it is consumed (quasi-static; jet damping and
 * internal flow inertia are neglected).
 */
import { type AeroFamily, type FinPreset, type FinGeometry, finGeometry, AERO_FAMILIES, FIN_PRESETS } from './aero';
import type { StageSpec } from './propulsion';
import type { ThermalParams, ThermalMaterial } from './thermal';

export interface MassItem {
  name: string;
  mass: number;
  /** Station of the item's centroid from the outer-body nose (m). */
  x: number;
  length: number;
  radius: number;
  shell: boolean;
  jettisonedWithAeroshell: boolean;
}

export interface StageLayout {
  spec: StageSpec;
  /** Stations within the STACK frame (from stack top, positive aft). */
  top: number;
  length: number;
  tankTop: number;
  tankBottom: number;
  bottom: number;
}

export interface VehicleEnvelopes {
  payloadLateralSustainedG: number;
  payloadLateralPeakG: number;
  payloadAxialPeakG: number;
  sustainedDurationS: number;
  /** Most restrictive stage hardware envelope (g). */
  stageLateralSustainedG: number;
  stageLateralPeakG: number;
  stageAxialPeakG: number;
  maxDynamicPressurePa: number;
  maxNormalForceN: number;
  maxAngleOfAttackRad: number;
  angleLimitAboveQPa: number;
}

export interface VehicleModel {
  length: number;
  diameter: number;
  refArea: number;
  noseRadius: number;
  noseLength: number;
  family: AeroFamily;
  fins: FinPreset;
  finGeom: FinGeometry;
  wettedArea: number;
  noseCapArea: number;
  stackDiameter: number;
  stackLength: number;
  /** Station of the stack top inside the aeroshell. */
  stackOffset: number;
  payloadMass: number;
  payloadLength: number;
  payloadSpecificHeat: number;
  rcs: { dryMass: number; propellant: number; isp: number; torqueMax: number; stationInStack: number };
  aeroshellItems: MassItem[];
  stages: StageLayout[];
  thermal: ThermalParams;
  envelopes: VehicleEnvelopes;
  /** Configuration warnings found while building (not fatal). */
  notes: string[];
}

export interface MassProps {
  mass: number;
  xcg: number;
  ixx: number;
  iyy: number;
  length: number;
  diameter: number;
  refArea: number;
  noseRadius: number;
  family: AeroFamily;
  fins: FinPreset;
  /** Nozzle exit station of the active stage (m from current nose), NaN if none. */
  xNozzle: number;
  /** Payload centroid station (m from current nose). */
  xPayload: number;
  /** RCS couple arm for pitch/yaw (m). */
  rcsArm: number;
}

export interface VehicleInputs {
  lengthM: number;
  diameterM: number;
  noseRadiusM: number;
  aeroFamilyId: string;
  finsId: string;
  payloadMassKg: number;
  payloadBulkDensity: number;
  payloadSpecificHeat: number;
  airframeArealMassKgM2: number;
  fairingMassKg: number;
  mountingMassKg: number;
  noseBallastKg: number;
  tps: {
    noseMaterial: ThermalMaterial;
    noseThickness: number;
    bodyArealMass: number;
    bodyArealHeatCapacity: number;
    bodyEmissivity: number;
    bodyMaxTemperatureK: number;
    insulationConductance: number;
  };
  stages: StageSpec[];
  rcs: { dryMass: number; propellantMass: number; isp: number; torquePerLength: number };
  payloadEnvelope: { lateralSustainedG: number; lateralPeakG: number; axialPeakG: number; sustainedDurationS: number; maxTemperatureK: number };
  maxDynamicPressurePa: number;
  maxNormalForceN: number;
  maxAngleOfAttackDeg: number;
  angleLimitAboveQPa: number;
  heatingMultiplier?: number;
}

export class VehicleBuildError extends Error {}

const TANK_FILL = 0.85;

/** Lateral (wetted) area of the nose section. */
function noseLateralArea(fam: AeroFamily, D: number, Ln: number): number {
  const r = D / 2;
  switch (fam.nose) {
    case 'hemisphere':
      return 2 * Math.PI * r * r;
    case 'cone':
      return Math.PI * r * Math.sqrt(Ln * Ln + r * r);
    case 'ogive':
      return 0.67 * Math.PI * D * Ln;
    default:
      return Math.PI * r * r;
  }
}

export function buildVehicle(inp: VehicleInputs): VehicleModel {
  const fam = AERO_FAMILIES[inp.aeroFamilyId];
  if (!fam) throw new VehicleBuildError(`Unknown aerodynamic family '${inp.aeroFamilyId}'.`);
  const fins = FIN_PRESETS[inp.finsId];
  if (!fins) throw new VehicleBuildError(`Unknown fin preset '${inp.finsId}'.`);
  const L = inp.lengthM, D = inp.diameterM;
  if (!(L > 0 && D > 0)) throw new VehicleBuildError('Vehicle length and diameter must be positive.');
  const notes: string[] = [];
  const rMaxNose = fam.maxNoseRadiusFraction * D;
  if (inp.noseRadiusM > rMaxNose + 1e-12) {
    throw new VehicleBuildError(
      `Nose radius ${(inp.noseRadiusM * 100).toFixed(1)} cm exceeds the ${fam.name} geometric limit of ${(rMaxNose * 100).toFixed(1)} cm (${(fam.maxNoseRadiusFraction * 100).toFixed(0)} % of diameter).`,
    );
  }
  if (inp.noseRadiusM <= 0.002) throw new VehicleBuildError('Nose radius must exceed 2 mm (the heating correlation diverges for sharp noses).');
  const Ln = Math.min(fam.noseLengthCalibers * D, 0.5 * L);
  const refArea = (Math.PI * D * D) / 4;
  const noseLat = noseLateralArea(fam, D, Ln);
  const wetted = noseLat + Math.PI * D * (L - Ln) + refArea;
  const noseCapArea = 2 * Math.PI * inp.noseRadiusM * inp.noseRadiusM;
  const fg = finGeometry(fins, L, D);

  // ---- stack geometry
  const gap = Math.max(0.01, 0.04 * D);
  const ds = D - 2 * gap;
  const rs = ds / 2;
  const As = Math.PI * rs * rs;
  const payloadLength = Math.max(0.08, inp.payloadMassKg / (inp.payloadBulkDensity * As));
  const stagesTopDown = [...inp.stages].reverse(); // upper stage first
  let cursor = payloadLength;
  const layoutsTopDown: StageLayout[] = [];
  for (const s of stagesTopDown) {
    const tankLen = s.propellantMass / s.propellantDensity / (As * TANK_FILL) + 0.06;
    const len = tankLen + s.engineLength;
    layoutsTopDown.push({ spec: s, top: cursor, length: len, tankTop: cursor, tankBottom: cursor + tankLen, bottom: cursor + len });
    cursor += len;
  }
  const stackLength = cursor;
  const stages = layoutsTopDown.reverse(); // index 0 = bottom (first to burn)
  const usable = L - 0.6 * Ln;
  if (stackLength > usable + 1e-9) {
    throw new VehicleBuildError(
      `Internal stack (payload ${payloadLength.toFixed(2)} m + stages ${(stackLength - payloadLength).toFixed(2)} m = ${stackLength.toFixed(2)} m) does not fit the aeroshell's usable length ${usable.toFixed(2)} m. Lengthen the vehicle, widen it, or carry less propellant.`,
    );
  }
  // Stages: aft-aligned so the nozzle exits at the tail. Ballistic: payload forward.
  const stackOffset = stages.length > 0 ? L - stackLength : 0.6 * Ln;

  // ---- aeroshell items (stations from aeroshell nose)
  const tps = inp.tps;
  const items: MassItem[] = [];
  const noseCapMass = tps.noseMaterial.density * tps.noseThickness * noseCapArea;
  items.push({ name: 'Nose cap (TPS)', mass: noseCapMass, x: Math.min(inp.noseRadiusM * 0.5, Ln), length: 0, radius: inp.noseRadiusM, shell: false, jettisonedWithAeroshell: true });
  const bodyTpsArea = Math.max(0, wetted - refArea - noseCapArea);
  const bodyCentroid = (noseLat * (0.62 * Ln) + Math.PI * D * (L - Ln) * (Ln + (L - Ln) / 2)) / (noseLat + Math.PI * D * (L - Ln));
  items.push({ name: 'Body TPS', mass: tps.bodyArealMass * bodyTpsArea, x: bodyCentroid, length: L, radius: D / 2, shell: true, jettisonedWithAeroshell: true });
  items.push({ name: 'Airframe', mass: inp.airframeArealMassKgM2 * wetted, x: bodyCentroid, length: L, radius: D / 2, shell: true, jettisonedWithAeroshell: true });
  items.push({ name: 'Nose fairing', mass: inp.fairingMassKg, x: 0.6 * Ln, length: Ln, radius: D / 2, shell: true, jettisonedWithAeroshell: true });
  items.push({ name: 'Mounting/interface hardware', mass: inp.mountingMassKg, x: 0.5 * L, length: 0, radius: D / 2, shell: false, jettisonedWithAeroshell: true });
  if (fg.mass > 0) items.push({ name: 'Fins', mass: fg.mass, x: fg.xcp, length: fg.meanChord, radius: D / 2 + fg.span / 2, shell: false, jettisonedWithAeroshell: true });
  if (inp.noseBallastKg > 0) items.push({ name: 'Nose ballast', mass: inp.noseBallastKg, x: 0.4 * Ln, length: 0, radius: 0, shell: false, jettisonedWithAeroshell: true });

  // ---- thermal network parameters
  const surf = Math.min(0.003, 0.3 * tps.noseThickness);
  const otherInternal = stages.reduce((a, s) => a + s.spec.dryMass, 0) + inp.rcs.dryMass;
  const thermal: ThermalParams = {
    noseRadius: inp.noseRadiusM,
    noseArea: noseCapArea,
    bodyArea: bodyTpsArea,
    surfaceLayerThickness: surf,
    backingThickness: Math.max(1e-4, tps.noseThickness - surf),
    noseMaterial: tps.noseMaterial,
    bodyArealHeatCapacity: tps.bodyArealHeatCapacity + inp.airframeArealMassKgM2 * 900,
    bodyEmissivity: tps.bodyEmissivity,
    bodyMaxTemperatureK: tps.bodyMaxTemperatureK,
    bodyHeatingFraction: fam.bodyHeatingFraction,
    insulationConductance: tps.insulationConductance,
    internalHeatCapacity: inp.payloadMassKg * inp.payloadSpecificHeat + 0.25 * otherInternal * 900,
    internalMaxTemperatureK: inp.payloadEnvelope.maxTemperatureK,
    sinkTemperatureK: 250,
    heatingMultiplier: inp.heatingMultiplier ?? 1,
  };

  const stageLatSus = Math.min(Infinity, ...inp.stages.map((s) => s.lateralSustainedG));
  const stageLatPk = Math.min(Infinity, ...inp.stages.map((s) => s.lateralPeakG));
  const stageAxPk = Math.min(Infinity, ...inp.stages.map((s) => s.axialPeakG));
  const finePct = L / D;
  if (finePct < fam.applicability.finenessMin || finePct > fam.applicability.finenessMax) {
    notes.push(
      `Fineness ratio L/D = ${finePct.toFixed(1)} is outside the ${fam.name} table domain (${fam.applicability.finenessMin}-${fam.applicability.finenessMax}); aerodynamic coefficients are extrapolated.`,
    );
  }
  return {
    length: L,
    diameter: D,
    refArea,
    noseRadius: inp.noseRadiusM,
    noseLength: Ln,
    family: fam,
    fins,
    finGeom: fg,
    wettedArea: wetted,
    noseCapArea,
    stackDiameter: ds,
    stackLength,
    stackOffset,
    payloadMass: inp.payloadMassKg,
    payloadLength,
    payloadSpecificHeat: inp.payloadSpecificHeat,
    rcs: {
      dryMass: inp.rcs.dryMass,
      propellant: inp.rcs.propellantMass,
      isp: inp.rcs.isp,
      torqueMax: inp.rcs.torquePerLength * L,
      stationInStack: payloadLength,
    },
    aeroshellItems: items,
    stages,
    thermal,
    envelopes: {
      payloadLateralSustainedG: inp.payloadEnvelope.lateralSustainedG,
      payloadLateralPeakG: inp.payloadEnvelope.lateralPeakG,
      payloadAxialPeakG: inp.payloadEnvelope.axialPeakG,
      sustainedDurationS: inp.payloadEnvelope.sustainedDurationS,
      stageLateralSustainedG: stageLatSus,
      stageLateralPeakG: stageLatPk,
      stageAxialPeakG: stageAxPk,
      maxDynamicPressurePa: inp.maxDynamicPressurePa,
      maxNormalForceN: inp.maxNormalForceN,
      maxAngleOfAttackRad: (inp.maxAngleOfAttackDeg * Math.PI) / 180,
      angleLimitAboveQPa: inp.angleLimitAboveQPa,
    },
    notes,
  };
}

/** Mass of everything currently attached, given discrete state and variable masses. */
interface FixedSums {
  M: number;
  S: number;
  Jyy: number;
  Jxx: number;
  length: number;
  diameter: number;
  refArea: number;
  noseRadius: number;
  family: AeroFamily;
  fins: FinPreset;
  /** Station offset of the stack frame within the current body. */
  stackShift: number;
  xNozzle: number;
  xPayload: number;
  rcsStation: number;
  /** Active-stage tank (current-body stations), for variable propellant. */
  tankBottom: number;
  tankLength: number;
  rcsArm: number;
}

function itemInertia(it: MassItem): { iy: number; ix: number } {
  if (it.shell) {
    return { ix: it.mass * it.radius * it.radius, iy: it.mass * (it.radius * it.radius / 2 + (it.length * it.length) / 12) };
  }
  return {
    ix: 0.5 * it.mass * it.radius * it.radius,
    iy: (it.mass * (3 * it.radius * it.radius + it.length * it.length)) / 12,
  };
}

export class MassModel {
  private cache = new Map<string, FixedSums>();
  constructor(readonly v: VehicleModel) {}

  private fixed(aeroshell: boolean, active: number): FixedSums {
    const key = `${aeroshell ? 1 : 0}:${active}`;
    let f = this.cache.get(key);
    if (f) return f;
    const v = this.v;
    const items: MassItem[] = [];
    const rs = v.stackDiameter / 2;
    // Present stages: indices >= active (lower ones were dropped). active === -1 => none present.
    const present = v.stages.filter((_, i) => active >= 0 && i >= active);
    const allGone = active < 0 || active >= v.stages.length;
    let stackShift: number;
    let length: number, diameter: number, family: AeroFamily, fins: FinPreset, noseRadius: number;
    if (aeroshell) {
      stackShift = v.stackOffset;
      length = v.length;
      diameter = v.diameter;
      family = v.family;
      fins = v.fins;
      noseRadius = v.noseRadius;
      for (const it of v.aeroshellItems) items.push(it);
    } else {
      stackShift = 0;
      const bottom = allGone ? v.payloadLength : present[0].bottom;
      length = bottom;
      diameter = v.stackDiameter;
      family = AERO_FAMILIES['stack-cylinder'];
      fins = FIN_PRESETS['none'];
      noseRadius = rs;
    }
    items.push({ name: 'Payload', mass: v.payloadMass, x: stackShift + v.payloadLength / 2, length: v.payloadLength, radius: rs, shell: false, jettisonedWithAeroshell: false });
    items.push({ name: 'RCS', mass: v.rcs.dryMass, x: stackShift + v.rcs.stationInStack, length: 0, radius: rs, shell: false, jettisonedWithAeroshell: false });
    let activeLayout: StageLayout | undefined;
    for (const s of present) {
      const i = v.stages.indexOf(s);
      items.push({ name: `${s.spec.name} dry`, mass: s.spec.dryMass, x: stackShift + (s.top + s.bottom) / 2, length: s.length, radius: rs, shell: true, jettisonedWithAeroshell: false });
      if (i === active) activeLayout = s;
      else {
        // Inactive (upper) stages carry full propellant.
        const tl = s.tankBottom - s.tankTop;
        items.push({ name: `${s.spec.name} propellant`, mass: s.spec.propellantMass, x: stackShift + (s.tankTop + s.tankBottom) / 2, length: tl, radius: rs, shell: false, jettisonedWithAeroshell: false });
      }
    }
    let M = 0, S = 0, Jyy = 0, Jxx = 0;
    for (const it of items) {
      const { ix, iy } = itemInertia(it);
      M += it.mass;
      S += it.mass * it.x;
      Jyy += iy + it.mass * it.x * it.x;
      Jxx += ix;
    }
    f = {
      M, S, Jyy, Jxx, length, diameter,
      refArea: (Math.PI * diameter * diameter) / 4,
      noseRadius, family, fins, stackShift,
      xNozzle: activeLayout ? stackShift + activeLayout.bottom : NaN,
      xPayload: stackShift + v.payloadLength / 2,
      rcsStation: stackShift + v.rcs.stationInStack,
      tankBottom: activeLayout ? stackShift + activeLayout.tankBottom : 0,
      tankLength: activeLayout ? activeLayout.tankBottom - activeLayout.tankTop : 0,
      rcsArm: 0.8 * length,
    };
    this.cache.set(key, f);
    return f;
  }

  /** Compute mass properties into out. */
  props(aeroshell: boolean, active: number, propActive: number, rcsProp: number, out: MassProps): MassProps {
    const f = this.fixed(aeroshell, active);
    let M = f.M, S = f.S, Jyy = f.Jyy, Jxx = f.Jxx;
    const rs = this.v.stackDiameter / 2;
    const mp = Math.max(0, propActive);
    if (mp > 0 && f.tankLength > 0) {
      const spec = this.v.stages[active].spec;
      const frac = Math.min(1, mp / spec.propellantMass);
      const l = frac * f.tankLength;
      const x = f.tankBottom - l / 2;
      M += mp;
      S += mp * x;
      Jyy += (mp * (3 * rs * rs + l * l)) / 12 + mp * x * x;
      Jxx += 0.5 * mp * rs * rs;
    }
    const mr = Math.max(0, rcsProp);
    if (mr > 0) {
      M += mr;
      S += mr * f.rcsStation;
      Jyy += mr * f.rcsStation * f.rcsStation;
    }
    const xcg = S / M;
    out.mass = M;
    out.xcg = xcg;
    out.iyy = Math.max(1e-6, Jyy - M * xcg * xcg);
    out.ixx = Math.max(1e-6, Jxx);
    out.length = f.length;
    out.diameter = f.diameter;
    out.refArea = f.refArea;
    out.noseRadius = f.noseRadius;
    out.family = f.family;
    out.fins = f.fins;
    out.xNozzle = f.xNozzle;
    out.xPayload = f.xPayload;
    out.rcsArm = f.rcsArm;
    return out;
  }
}

export function emptyMassProps(): MassProps {
  return {
    mass: 0, xcg: 0, ixx: 0, iyy: 0, length: 0, diameter: 0, refArea: 0, noseRadius: 0,
    family: AERO_FAMILIES['slender-ogive'], fins: FIN_PRESETS['none'], xNozzle: NaN, xPayload: 0, rcsArm: 0,
  };
}

/** Itemised wet mass at launch (for the interface). */
export function massBreakdown(v: VehicleModel): Array<{ name: string; mass: number; group: string }> {
  const out: Array<{ name: string; mass: number; group: string }> = [];
  for (const it of v.aeroshellItems) if (it.mass > 0) out.push({ name: it.name, mass: it.mass, group: 'Aeroshell (jettisoned)' });
  out.push({ name: 'Payload', mass: v.payloadMass, group: 'Delivered' });
  if (v.rcs.dryMass > 0) out.push({ name: 'RCS hardware', mass: v.rcs.dryMass, group: 'Stack' });
  if (v.rcs.propellant > 0) out.push({ name: 'RCS propellant', mass: v.rcs.propellant, group: 'Stack' });
  for (const s of v.stages) {
    out.push({ name: `${s.spec.name} (dry)`, mass: s.spec.dryMass, group: 'Stack' });
    out.push({ name: `${s.spec.name} (propellant)`, mass: s.spec.propellantMass, group: 'Stack' });
  }
  return out;
}
