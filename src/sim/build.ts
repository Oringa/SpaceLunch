/**
 * Resolve a SimConfig (+ presets) into physics parameters, validate it, and
 * compute the derived CONSEQUENCES shown next to every control. Nothing is
 * silently fixed: inconsistent or infeasible inputs produce named issues.
 */
import { G0, OMEGA_EARTH } from '../physics/constants';
import {
  ARM_MATERIALS, BALANCE_PRESETS, BEARING_PRESETS, MOTOR_PRESETS, MOUNT_PRESETS, PAYLOAD_PRESETS,
  PROTECTION_PRESETS, RCS_PRESETS, STAGE_PRESETS, TPS_MATERIALS, UPPER_STAGE_STACKS,
  type BalancePreset, type MountPreset, type PayloadPreset,
} from '../data/presets';
import { AERO_FAMILIES, aeroCoefficients, emptyAeroCoefficients, type AeroFamily } from '../physics/aero';
import { buildPerturbedAtmosphere, standardAtmosphere, type AtmosphereModel } from '../physics/atmosphere';
import { buildLauncherGeometry, type LauncherGeometry } from '../physics/launcher';
import { type GuidanceParams } from '../physics/guidance';
import { idealDeltaV, type StageSpec } from '../physics/propulsion';
import {
  type RotorParams, type RotorDerived, type ArmGeometry, deriveRotor, balancingCounterMass, equilibriumSpeed,
  motorTorqueAvailable, rotorDerivative, RS, lossTorque,
} from '../physics/rotor';
import { pumpdown, type VacuumParams, type PumpdownResult } from '../physics/vacuum';
import { buildVehicle, MassModel, VehicleBuildError, massBreakdown, emptyMassProps, type VehicleModel } from '../physics/vehicle';
import { type WindModel } from '../physics/wind';
import { streamRng } from '../physics/random';
import { Dopri5 } from '../physics/integrator';
import { add, scale, type Vec3 } from '../physics/vec3';
import { ecefToEci } from '../physics/frames';
import { type SimConfig, type VehicleConfig, SCHEMA_VERSION } from './config';
import { estimateCosts, type CostBreakdown } from '../game/costs';

export type IssueLevel = 'error' | 'warning' | 'info';
export interface BuildIssue {
  level: IssueLevel;
  path?: string;
  message: string;
}

export interface ReleaseModel {
  mount: MountPreset;
  balance: BalancePreset;
  /** Residual timing error applied by the phase-locked controller (s) = offset + sampled jitter. */
  timingErrorS: number;
  sampledJitterS: number;
  /** Residual pitch rate fraction and sampled error (rad/s). */
  residualFraction: number;
  residualErrorRadS: number;
}

export interface DerivedSummary {
  omegaTarget: number;
  rpm: number;
  aRadial: number;
  aRadialG: number;
  /** Worst-case felt lateral load on the vehicle including gravity (g). */
  lateralLoadG: number;
  tipSpeed: number;
  wetMass: number;
  tipMass: number;
  vehicleKE: number;
  rotorKE: number;
  rotorInertia: number;
  armMass: number;
  counterMass: number;
  stressMax: number;
  stressMaxAt: number;
  stressMargin: number;
  stressAllowable: number;
  counterStressMax: number;
  equilibriumOmega: number;
  equilibriumTipSpeed: number;
  maxTipTangentialAccel: number;
  postReleaseBearingLoad: number;
  bearingLimit: number;
  spinupTimeEstimate: number;
  spinupEnergyEstimate: number;
  pump: PumpdownResult;
  directionErrorPerMs: number;
  timingToleranceS: number;
  apertureMargin: number;
  corridorPathLength: number;
  ballisticCoefficient: number;
  stabilityMarginSubsonicCal: number;
  stabilityMarginHypersonicCal: number;
  fineness: number;
  idealDeltaV: number;
  stageDeltaV: number[];
  gasLossPowerAtTarget: number;
  bearingLossPowerAtTarget: number;
  massBreakdown: Array<{ name: string; mass: number; group: string }>;
  costs: CostBreakdown;
  inclinationEstimateDeg: number;
}

/** Spin-up counts as stalled once the rotor reaches this fraction of the drive's equilibrium speed. */
export const STALL_FRACTION = 0.985;

export interface Scenario {
  config: SimConfig;
  issues: BuildIssue[];
  ok: boolean;
  /** Equilibrium rotor speed (rad/s) when the drive cannot reach the target; null otherwise. */
  stallOmega: number | null;
  geometry: LauncherGeometry;
  rotor: RotorParams;
  rotorDerived: RotorDerived;
  omegaTarget: number;
  vehicle: VehicleModel;
  massModel: MassModel;
  payload: PayloadPreset;
  vacuum: VacuumParams;
  atmosphere: AtmosphereModel;
  wind: WindModel;
  guidance: GuidanceParams;
  release: ReleaseModel;
  derived: DerivedSummary;
  uncertaintyDraws: Record<string, number>;
  stages: StageSpec[];
}

const err = (issues: BuildIssue[], path: string, message: string): void => {
  issues.push({ level: 'error', path, message });
};
const warn = (issues: BuildIssue[], path: string, message: string): void => {
  issues.push({ level: 'warning', path, message });
};

/** Radius of the vehicle's cross-section envelope including fins (m): what must pass the exit aperture. */
export function vehicleEnvelopeRadius(V: Pick<VehicleConfig, 'diameterM' | 'finsId'>): number {
  const finSpan = V.finsId === 'none' ? 0 : (V.finsId === 'large-tail' ? 0.8 : 0.55) * V.diameterM;
  return V.diameterM / 2 + finSpan;
}

/** Farthest point of the vehicle from the hub axis when mounted at arm radius R (m): what the chamber must clear. */
export function vehicleCornerRadius(R: number, V: Pick<VehicleConfig, 'diameterM' | 'lengthM'>): number {
  return Math.hypot(R + V.diameterM / 2, V.lengthM / 2);
}

function scaledFamily(f: AeroFamily, cdScale: number, cnScale: number): AeroFamily {
  if (cdScale === 1 && cnScale === 1) return f;
  return { ...f, cd0: f.cd0.map((x) => x * cdScale), cnAlpha: f.cnAlpha.map((x) => x * cnScale), crossflowCd: f.crossflowCd.map((x) => x * cdScale) };
}

export function buildScenario(config: SimConfig): Scenario {
  const c = config;
  const issues: BuildIssue[] = [];
  if (c.schemaVersion !== SCHEMA_VERSION) warn(issues, 'schemaVersion', `Configuration schema ${c.schemaVersion} differs from ${SCHEMA_VERSION}.`);
  const L = c.launcher;
  const V = c.vehicle;
  const F = c.flightPlan;

  // ---- uncertainty draws (sampled once from the seed)
  const draws: Record<string, number> = {};
  const urng = streamRng(c.seed, 'uncertainty');
  const u = (name: string, rel: number): number => {
    if (!c.uncertainty.enabled) return 1;
    const x = 1 + rel * urng.normal();
    draws[name] = x;
    return x;
  };
  const cdScale = u('aero.cd', 0.1);
  const cnScale = u('aero.cnAlpha', 0.15);
  const heatScale = u('thermal.correlation', 0.15);
  const strengthScale = u('arm.strength', 0.05);
  const ispScale = u('stage.isp', 0.01);
  const motorScale = u('motor.power', 0.02);

  // ---- presets
  const mat0 = ARM_MATERIALS[L.arm.materialId];
  const motor0 = MOTOR_PRESETS[L.motorId];
  const bearing = BEARING_PRESETS[L.bearingId];
  const mount = MOUNT_PRESETS[L.mountId];
  const balance = BALANCE_PRESETS[L.balanceId];
  const payload = PAYLOAD_PRESETS[V.payloadId];
  const protection = PROTECTION_PRESETS[V.protectionId];
  const stack = UPPER_STAGE_STACKS[V.stackId];
  const rcsP = RCS_PRESETS[V.rcsId];
  const family0 = AERO_FAMILIES[V.aeroFamilyId];
  const missing: Array<[unknown, string, string]> = [
    [mat0, 'launcher.arm.materialId', L.arm.materialId], [motor0, 'launcher.motorId', L.motorId],
    [bearing, 'launcher.bearingId', L.bearingId], [mount, 'launcher.mountId', L.mountId],
    [balance, 'launcher.balanceId', L.balanceId], [payload, 'vehicle.payloadId', V.payloadId],
    [protection, 'vehicle.protectionId', V.protectionId], [stack, 'vehicle.stackId', V.stackId],
    [rcsP, 'vehicle.rcsId', V.rcsId], [family0, 'vehicle.aeroFamilyId', V.aeroFamilyId],
  ];
  for (const [val, path, id] of missing) if (!val) err(issues, path, `Unknown preset '${id}'.`);
  if (issues.some((i) => i.level === 'error')) {
    throw new ConfigError(issues);
  }
  const mat = { ...mat0, ultimateStrength: mat0.ultimateStrength * strengthScale };
  const motor = { ...motor0, electricalPowerW: motor0.electricalPowerW * motorScale };
  const stages: StageSpec[] = stack.stages.map((id) => {
    const s = STAGE_PRESETS[id];
    return { ...s, ispVac: s.ispVac * ispScale, ispSl: s.ispSl * ispScale };
  });
  const family = scaledFamily(family0, cdScale, cnScale);

  // ---- geometry checks
  const R = L.armRadiusM;
  if (!(R >= 5 && R <= 150)) err(issues, 'launcher.armRadiusM', `Arm radius ${R} m is outside the supported 5-150 m range.`);
  if (!(L.targetTipSpeedMps > 0)) err(issues, 'launcher.targetTipSpeedMps', 'Target tip speed must be positive.');
  const cornerR = vehicleCornerRadius(R, V);
  if (L.chamberRadiusM < cornerR + 0.25) {
    err(issues, 'launcher.chamberRadiusM', `Chamber radius ${L.chamberRadiusM.toFixed(2)} m does not clear the vehicle envelope on the arm (needs at least ${(cornerR + 0.25).toFixed(2)} m for a ${V.lengthM} m vehicle at R = ${R} m).`);
  }
  if (L.counterRadiusFraction < 0.3 || L.counterRadiusFraction > 1) err(issues, 'launcher.counterRadiusFraction', 'Counterbalance radius fraction must be within 0.3-1.');
  if (F.elevationDeg < 5 || F.elevationDeg > 90) err(issues, 'flightPlan.elevationDeg', 'Elevation must be between 5 and 90 degrees (the exit tunnel must point upward).');
  if (L.arm.tipAreaM2 <= 0 || L.arm.rootAreaM2 <= 0) err(issues, 'launcher.arm', 'Arm section areas must be positive.');
  if (L.arm.rootAreaM2 < L.arm.tipAreaM2) warn(issues, 'launcher.arm.rootAreaM2', 'Root area smaller than tip area: the arm thins toward the hub, where tension is highest.');
  const envelopeRadius = vehicleEnvelopeRadius(V);
  if (L.exit.apertureRadiusM <= envelopeRadius) {
    err(issues, 'launcher.exit.apertureRadiusM', `Exit aperture radius ${(L.exit.apertureRadiusM * 100).toFixed(0)} cm does not exceed the vehicle envelope radius ${(envelopeRadius * 100).toFixed(0)} cm (body + fins).`);
  }

  // ---- vehicle
  let vehicle: VehicleModel;
  try {
    const tpsMat = TPS_MATERIALS[protection.noseMaterial];
    vehicle = buildVehicle({
      lengthM: V.lengthM, diameterM: V.diameterM, noseRadiusM: V.noseRadiusM,
      aeroFamilyId: V.aeroFamilyId, finsId: V.finsId,
      payloadMassKg: V.payloadMassKg, payloadBulkDensity: payload.bulkDensity, payloadSpecificHeat: payload.specificHeat,
      airframeArealMassKgM2: V.airframeArealMassKgM2, fairingMassKg: V.fairingMassKg, mountingMassKg: V.mountingMassKg,
      noseBallastKg: V.noseBallastKg,
      tps: {
        noseMaterial: tpsMat, noseThickness: protection.noseThickness, bodyArealMass: protection.bodyArealMass,
        bodyArealHeatCapacity: protection.bodyArealHeatCapacity, bodyEmissivity: protection.bodyEmissivity,
        bodyMaxTemperatureK: protection.bodyMaxTemperatureK, insulationConductance: protection.insulationConductance,
      },
      stages,
      rcs: { dryMass: rcsP.dryMass, propellantMass: rcsP.propellantMass, isp: rcsP.isp, torquePerLength: rcsP.torquePerLength },
      payloadEnvelope: payload,
      maxDynamicPressurePa: V.maxDynamicPressurePa, maxNormalForceN: V.maxNormalForceN,
      maxAngleOfAttackDeg: V.maxAngleOfAttackDeg, angleLimitAboveQPa: V.angleLimitAboveQPa,
      heatingMultiplier: heatScale,
    });
    vehicle.family = family;
  } catch (e) {
    if (e instanceof VehicleBuildError) {
      err(issues, 'vehicle', e.message);
      throw new ConfigError(issues);
    }
    throw e;
  }
  for (const n of vehicle.notes) warn(issues, 'vehicle', n);
  const massModel = new MassModel(vehicle);
  const mp0 = massModel.props(true, stages.length ? 0 : -1, stages.length ? stages[0].propellantMass : 0, vehicle.rcs.propellant, emptyMassProps());
  const wetMass = mp0.mass;
  const cradleMass = mount.cradleBaseMass + mount.cradleMassFraction * wetMass;
  const tipMass = wetMass + cradleMass;

  // ---- rotor
  const armV: ArmGeometry = { length: R, rootArea: L.arm.rootAreaM2, tipArea: L.arm.tipAreaM2, profile: L.arm.profile, sectionAspect: L.arm.sectionAspect };
  const Rc = R * L.counterRadiusFraction;
  const armC: ArmGeometry = { ...armV, length: Rc };
  const counterMass = balancingCounterMass(tipMass, armV, armC, mat.density, Rc);
  const steelDensity = 7850;
  const counterFrontal = Math.pow(counterMass / steelDensity, 2 / 3);
  const rotor: RotorParams = {
    vehicleArm: armV, counterArm: armC, material: mat,
    vehicleTipMass: tipMass, vehicleMass: wetMass, vehicleOwnInertia: mp0.iyy,
    counterMass, counterRadius: Rc, hubInertia: L.hubInertiaKgM2,
    motor, bearing,
    chamberPressurePa: L.vacuum.targetPressurePa, chamberTemperatureK: L.vacuum.chamberTemperatureK,
    armCdContinuum: L.gasDrag.cdContinuum, armCdFreeMolecular: L.gasDrag.cdFreeMolecular,
    vehicleFrontalArea: V.diameterM * V.lengthM, counterFrontalArea: counterFrontal,
  };
  const rd = deriveRotor(rotor);
  const omegaT = L.targetTipSpeedMps / R;
  const sigmaMax = omegaT * omegaT * rd.vehicleArm.stressFactor;
  const sigmaCounter = omegaT * omegaT * rd.counterArm.stressFactor;
  const allow = mat.ultimateStrength / L.structure.safetyFactor;
  if (Math.max(sigmaMax, sigmaCounter) > mat.ultimateStrength) {
    warn(issues, 'launcher.arm', `Modelled arm stress at target speed (${(Math.max(sigmaMax, sigmaCounter) / 1e9).toFixed(2)} GPa) exceeds the ${mat.name} failure threshold (${(mat.ultimateStrength / 1e9).toFixed(2)} GPa): the run will end in a modelled structural failure during spin-up.`);
  } else if (Math.max(sigmaMax, sigmaCounter) > allow) {
    warn(issues, 'launcher.arm', `Arm stress ${(Math.max(sigmaMax, sigmaCounter) / 1e9).toFixed(2)} GPa violates the safety-factor margin (allowable ${(allow / 1e9).toFixed(2)} GPa at SF ${L.structure.safetyFactor}). This is a margin warning, not a modelled fracture.`);
  }
  const wEq = equilibriumSpeed(rotor, rd);
  // A drive too weak for the target is a playable outcome, not an input error:
  // spin-up levels off near the equilibrium speed and the launch is aborted.
  const stallOmega = wEq < omegaT * (1 - L.release.armingTolerance) ? wEq : null;
  if (stallOmega !== null) {
    warn(issues, 'launcher.targetTipSpeedMps', `Target tip speed ${L.targetTipSpeedMps.toFixed(0)} m/s is beyond this drive: ${(motor.electricalPowerW / 1e6).toFixed(1)} MW balances bearing and gas losses at ${(wEq * R).toFixed(0)} m/s. Spin-up will stall there and the launch will be aborted.`);
  }
  const maxTan = (motorTorqueAvailable(motor, 0) / rd.inertia) * R;
  if (maxTan > L.structure.maxTipTangentialAccel) {
    warn(issues, 'launcher.motorId', `Peak tip tangential acceleration ${maxTan.toFixed(1)} m/s² exceeds the unmodelled-bending envelope ${L.structure.maxTipTangentialAccel} m/s² (bending is not simulated; this is an envelope warning).`);
  }
  const postReleaseLoad = balance.releasesBallast ? 0.02 * wetMass * omegaT * omegaT * R : wetMass * omegaT * omegaT * R;
  if (postReleaseLoad > bearing.radialLoadLimitN) {
    warn(issues, 'launcher.balanceId', `After release the rotor is unbalanced by the departed vehicle: transient bearing load ${(postReleaseLoad / 1e6).toFixed(1)} MN exceeds the ${bearing.name} envelope ${(bearing.radialLoadLimitN / 1e6).toFixed(1)} MN. The run will fail at release.`);
  }

  // ---- vacuum
  const chamberVolume = Math.PI * L.chamberRadiusM ** 2 * L.chamberDepthM + Math.PI * L.exit.apertureRadiusM ** 2 * L.exit.tunnelLengthM;
  const chamberArea = 2 * Math.PI * L.chamberRadiusM ** 2 + 2 * Math.PI * L.chamberRadiusM * L.chamberDepthM + 2 * Math.PI * L.exit.apertureRadiusM * L.exit.tunnelLengthM;
  const vacuum: VacuumParams = {
    volume: chamberVolume, surfaceArea: chamberArea, pumpSpeed: L.vacuum.pumpSpeedM3s, gasLoadPerArea: L.vacuum.gasLoadPerAreaPaM3sM2,
    ultimatePressure: L.vacuum.ultimatePressurePa, initialPressure: 101325, targetPressure: L.vacuum.targetPressurePa, pumpPowerW: L.vacuum.pumpPowerW,
  };
  const pump = pumpdown(vacuum);
  if (!pump.feasible) err(issues, 'launcher.vacuum.targetPressurePa', pump.reason ?? 'Pump-down infeasible.');

  // ---- geometry
  const geometry = buildLauncherGeometry({
    latDeg: c.site.latitudeDeg, lonDeg: c.site.longitudeDeg, siteAltitude: c.site.altitudeM,
    azimuthDeg: F.azimuthDeg, elevationDeg: F.elevationDeg, armRadius: R, chamberRadius: L.chamberRadiusM,
    chamberDepth: L.chamberDepthM, apertureRadius: L.exit.apertureRadiusM, tunnelLength: L.exit.tunnelLengthM,
  });

  // ---- release model (sampled once)
  const rrng = streamRng(c.seed, 'release');
  const jitter = L.release.timingJitterStdS * rrng.normal();
  const resErr = mount.residualErrorStd * rrng.normal();
  const release: ReleaseModel = {
    mount, balance,
    timingErrorS: L.release.timingOffsetS + jitter,
    sampledJitterS: jitter,
    residualFraction: mount.residualFraction,
    residualErrorRadS: resErr,
  };

  // ---- environment
  let atmosphere: AtmosphereModel = standardAtmosphere;
  const E = c.environment;
  if (E.perturbation.enabled) {
    const w = streamRng(E.weatherSeed, 'atmosphere');
    atmosphere = buildPerturbedAtmosphere({
      surfacePressureFraction: E.perturbation.surfacePressureStdFrac * w.normal(),
      surfaceTemperatureOffsetK: E.perturbation.temperatureStdK * w.normal(),
      decayAltitudeM: 15000,
      waves: [0, 1, 2].map((i) => ({ amplitudeK: (E.perturbation.temperatureStdK * 0.4) * w.normal(), wavelengthM: [6000, 13000, 27000][i], phase: 2 * Math.PI * w.next() })),
      thermosphereDensityFactor: Math.max(0.2, 1 + E.perturbation.thermosphereDensityStdFrac * w.normal()),
    });
  }
  const wrng = streamRng(E.weatherSeed, 'wind');
  const wind: WindModel = {
    enabled: E.wind.enabled,
    layers: E.wind.layers.map((l) => ({ ...l })),
    structure: E.wind.structureAmplitudeMps > 0
      ? [1500, 4000, 9000].map((wl) => ({ amplitudeMps: E.wind.structureAmplitudeMps * (0.5 + wrng.next()), wavelengthM: wl, phaseE: 2 * Math.PI * wrng.next(), phaseN: 2 * Math.PI * wrng.next() }))
      : [],
  };

  // ---- guidance
  const tAz = geometry.h;
  const fallbackHorizontal: Vec3 = ecefToEci(tAz, 0, c.physics.earthRotation);
  const guidance: GuidanceParams = {
    mode: stages.length ? F.guidance.mode : 'none',
    targetAltitude: F.guidance.targetAltitudeM,
    cutoffPeriapsis: F.guidance.cutoffPeriapsisM,
    pitchProgram: F.guidance.pitchProgram,
    fallbackHorizontal,
  };
  if (stages.length && F.guidance.mode === 'none') warn(issues, 'flightPlan.guidance.mode', 'Upper stage carried but guidance mode is "none": it will never ignite.');
  if (F.guidance.mode === 'assisted-insertion' && F.guidance.targetAltitudeM < F.guidance.cutoffPeriapsisM + 10_000) {
    err(issues, 'flightPlan.guidance.targetAltitudeM', 'Target altitude must be at least 10 km above the cutoff periapsis, otherwise the cutoff can never trigger.');
  }

  // ---- consequences
  const breakdown = massBreakdown(vehicle);
  const ac = emptyAeroCoefficients();
  const geomA = { family, fins: vehicle.fins, length: vehicle.length, diameter: vehicle.diameter, refArea: vehicle.refArea };
  aeroCoefficients(geomA, 0.5, 0, 0, mp0.xcg, ac);
  const smSub = (ac.xcpSmallAlpha - mp0.xcg) / vehicle.diameter;
  aeroCoefficients(geomA, 6, 0, 0, mp0.xcg, ac);
  const smHyp = (ac.xcpSmallAlpha - mp0.xcg) / vehicle.diameter;
  const beta = wetMass / (ac.ca * vehicle.refArea);
  // delta-v budget
  const stageDv: number[] = [];
  let upperMass = vehicle.payloadMass + vehicle.rcs.dryMass + vehicle.rcs.propellant;
  for (let i = stages.length - 1; i >= 0; i--) {
    const s = stages[i];
    const m0 = upperMass + s.dryMass + s.propellantMass;
    const mf = upperMass + s.dryMass;
    stageDv.unshift(idealDeltaV(s.ispVac, m0, mf));
    upperMass = m0;
  }
  const dvTotal = stageDv.reduce((a, b) => a + b, 0);
  const path = geometry.sEnd;
  const margin = L.exit.apertureRadiusM - envelopeRadius;
  const spin = estimateSpinup(rotor, rd, omegaT, L.release.armingTolerance, stallOmega !== null ? STALL_FRACTION * stallOmega : undefined);
  const latRad = geometry.lat;
  const sinAz = Math.sin(geometry.azimuth);
  const cosI = Math.cos(latRad) * sinAz;
  const incl = (Math.acos(Math.max(-1, Math.min(1, cosI))) * 180) / Math.PI;

  const derived: DerivedSummary = {
    omegaTarget: omegaT,
    rpm: (omegaT * 60) / (2 * Math.PI),
    aRadial: omegaT * omegaT * R,
    aRadialG: (omegaT * omegaT * R) / G0,
    lateralLoadG: (omegaT * omegaT * R + G0) / G0,
    tipSpeed: L.targetTipSpeedMps,
    wetMass,
    tipMass,
    vehicleKE: 0.5 * wetMass * L.targetTipSpeedMps ** 2,
    rotorKE: 0.5 * rd.inertia * omegaT * omegaT,
    rotorInertia: rd.inertia,
    armMass: rd.armMass,
    counterMass,
    stressMax: sigmaMax,
    stressMaxAt: rd.vehicleArm.stressMaxAt,
    stressMargin: mat.ultimateStrength / Math.max(sigmaMax, sigmaCounter),
    stressAllowable: allow,
    counterStressMax: sigmaCounter,
    equilibriumOmega: wEq,
    equilibriumTipSpeed: wEq * R,
    maxTipTangentialAccel: maxTan,
    postReleaseBearingLoad: postReleaseLoad,
    bearingLimit: bearing.radialLoadLimitN,
    spinupTimeEstimate: spin.time,
    spinupEnergyEstimate: spin.energy,
    pump,
    directionErrorPerMs: omegaT * 1e-3,
    timingToleranceS: margin / (omegaT * Math.max(path, 1)),
    apertureMargin: margin,
    corridorPathLength: path,
    ballisticCoefficient: beta,
    stabilityMarginSubsonicCal: smSub,
    stabilityMarginHypersonicCal: smHyp,
    fineness: vehicle.length / vehicle.diameter,
    idealDeltaV: dvTotal,
    stageDeltaV: stageDv,
    gasLossPowerAtTarget: rd.kGas * omegaT ** 3,
    bearingLossPowerAtTarget: (lossTorque(rotor, rd, omegaT) - rd.kGas * omegaT ** 2) * omegaT,
    massBreakdown: breakdown,
    costs: { items: [], perLaunch: 0, capital: 0 },
    inclinationEstimateDeg: incl,
  };
  const scenario: Scenario = {
    config: c, issues, ok: !issues.some((i) => i.level === 'error'), geometry, rotor, rotorDerived: rd, omegaTarget: omegaT, stallOmega,
    vehicle, massModel, payload, vacuum, atmosphere, wind, guidance, release, derived, uncertaintyDraws: draws, stages,
  };
  derived.costs = estimateCosts(scenario);
  // Sanity: NaN guard on headline numbers.
  for (const [k, v] of Object.entries(derived)) {
    if (typeof v === 'number' && Number.isNaN(v)) issues.push({ level: 'error', path: k, message: `Derived quantity ${k} is NaN (degenerate configuration).` });
  }
  scenario.ok = !issues.some((i) => i.level === 'error');
  void OMEGA_EARTH; void add; void scale; void RS;
  return scenario;
}

export class ConfigError extends Error {
  constructor(readonly issues: BuildIssue[]) {
    super(issues.filter((i) => i.level === 'error').map((i) => i.message).join(' '));
  }
}

/** Spin-up estimate with the same rotor ODE and integrator as the authoritative run. */
/** Time and energy to reach the arming band, or `stopOmega` (rad/s) when given (a stalling drive). */
export function estimateSpinup(p: RotorParams, d: RotorDerived, omegaT: number, tol: number, stopOmega = omegaT * (1 - tol)): { time: number; energy: number } {
  const atol = new Float64Array([1e-6, 1e-8, 1, 1, 1, 1]);
  const integ = new Dopri5(RS.N, (_t, y, dy) => rotorDerivative(p, d, omegaT, true, y, dy), { rtol: 1e-8, atol, hMax: 2, hMin: 1e-9 });
  integ.reset(0, new Float64Array(RS.N));
  for (let i = 0; i < 200000 && integ.t < 6 * 3600; i++) {
    integ.step();
    if (integ.y[RS.OMEGA] >= stopOmega) return { time: integ.t, energy: integ.y[RS.E_ELEC] };
  }
  return { time: Infinity, energy: Infinity };
}
