/**
 * Simulation configuration: the editable CAUSES. Everything here is SI.
 * Derived consequences (RPM, loads, wet mass, reference area, ...) are never
 * stored here; they are computed by sim/build.ts from these inputs.
 */
export const SCHEMA_VERSION = 1;
export const MODEL_VERSION = 'centrifuge-model-1.0.0';

export type Fidelity = 'engineering' | 'assisted';

export interface PhysicsToggles {
  /** Atmospheric forces and aerodynamic heating (false = vacuum thought experiment). */
  atmosphere: boolean;
  earthRotation: boolean;
}

export interface SiteConfig {
  latitudeDeg: number;
  longitudeDeg: number;
  altitudeM: number;
}

export interface ArmConfig {
  materialId: string;
  profile: 'linear' | 'exponential' | 'constant-stress';
  rootAreaM2: number;
  tipAreaM2: number;
  sectionAspect: number;
}

export interface LauncherConfig {
  /** Effective arm radius: hub axis to vehicle centre of mass (m). */
  armRadiusM: number;
  /** Inner radius of the vacuum chamber (m). Must exceed arm radius + vehicle clearance. */
  chamberRadiusM: number;
  /** Axial depth of the disc-shaped chamber (m). */
  chamberDepthM: number;
  targetTipSpeedMps: number;
  arm: ArmConfig;
  hubInertiaKgM2: number;
  balanceId: string;
  /** Counterbalance radius as a fraction of arm radius (0.4-1). */
  counterRadiusFraction: number;
  mountId: string;
  motorId: string;
  bearingId: string;
  vacuum: {
    targetPressurePa: number;
    chamberTemperatureK: number;
    pumpSpeedM3s: number;
    gasLoadPerAreaPaM3sM2: number;
    ultimatePressurePa: number;
    pumpPowerW: number;
  };
  gasDrag: { cdContinuum: number; cdFreeMolecular: number };
  exit: {
    apertureRadiusM: number;
    tunnelLengthM: number;
    membraneArealDensityKgM2: number;
  };
  release: {
    mode: 'phase-locked' | 'manual-training';
    actuatorLatencyS: number;
    timingOffsetS: number;
    timingJitterStdS: number;
    /** Relative speed tolerance before the phase-locked release arms. */
    armingTolerance: number;
  };
  structure: {
    /** Required safety factor on the modelled arm stress (warning margin). */
    safetyFactor: number;
    /** Envelope for unmodelled bending: max tip tangential acceleration (m/s^2). */
    maxTipTangentialAccel: number;
  };
  /** Fraction of residual rotor energy recovered by regenerative braking after release. */
  regenEfficiency: number;
}

export interface VehicleConfig {
  payloadMassKg: number;
  payloadId: string;
  aeroFamilyId: string;
  finsId: string;
  lengthM: number;
  diameterM: number;
  noseRadiusM: number;
  /** Airframe structure mass per unit wetted area (kg/m^2). */
  airframeArealMassKgM2: number;
  /** Nose fairing mass (kg), jettisoned with the aeroshell. */
  fairingMassKg: number;
  /** Interface/mounting hardware riding with the vehicle, jettisoned with the aeroshell (kg). */
  mountingMassKg: number;
  /** Optional ballast in the nose to move the centre of gravity forward (kg). */
  noseBallastKg: number;
  protectionId: string;
  stackId: string;
  rcsId: string;
  /** Aeroshell envelopes. */
  maxDynamicPressurePa: number;
  maxNormalForceN: number;
  /** Unstable-flight envelope: total angle of attack limit above a dynamic-pressure threshold. */
  maxAngleOfAttackDeg: number;
  angleLimitAboveQPa: number;
}

export type IgnitionCondition =
  | { kind: 'altitude'; valueM: number }
  | { kind: 'time-after-release'; valueS: number }
  | { kind: 'vertical-speed-below'; valueMps: number };

export interface FlightPlanConfig {
  azimuthDeg: number;
  elevationDeg: number;
  /** Attitude control in unpowered flight. */
  coastAttitude: 'passive' | 'hold-air-relative';
  jettison: { kind: 'altitude'; valueM: number } | { kind: 'never' };
  guidance: {
    mode: 'none' | 'assisted-insertion' | 'prograde' | 'pitch-program';
    ignition: IgnitionCondition;
    /** Target circular altitude for altitude-hold insertion (m). */
    targetAltitudeM: number;
    /** Cutoff when osculating periapsis reaches this altitude (m). */
    cutoffPeriapsisM: number;
    /** Pitch program: [seconds after ignition, pitch above local horizontal (deg)]. */
    pitchProgram: Array<[number, number]>;
    /** Coast between stage separation and next ignition (s). */
    stagingCoastS: number;
  };
}

export interface EnvironmentConfig {
  weatherSeed: number;
  perturbation: {
    enabled: boolean;
    surfacePressureStdFrac: number;
    temperatureStdK: number;
    thermosphereDensityStdFrac: number;
  };
  wind: {
    enabled: boolean;
    layers: Array<{ altitudeM: number; speedMps: number; fromDeg: number }>;
    structureAmplitudeMps: number;
  };
}

export interface IntegratorConfig {
  rtol: number;
  /** Absolute position tolerance (m); other components scale from it. */
  positionTolM: number;
  hMaxCorridorS: number;
  hMaxAtmosphereS: number;
  hMaxBurnS: number;
  hMaxCoastS: number;
  hMaxRotorS: number;
}

export interface UncertaintyConfig {
  /** If true, hardware/environment parameters are perturbed from their provenance uncertainty using the run seed. */
  enabled: boolean;
}

export interface SimConfig {
  schemaVersion: number;
  modelVersion: string;
  name: string;
  seed: number;
  fidelity: Fidelity;
  physics: PhysicsToggles;
  site: SiteConfig;
  launcher: LauncherConfig;
  vehicle: VehicleConfig;
  flightPlan: FlightPlanConfig;
  environment: EnvironmentConfig;
  integrator: IntegratorConfig;
  uncertainty: UncertaintyConfig;
  /** End the run after this much simulated flight time if nothing else ends it (s). */
  maxFlightTimeS: number;
  /** For orbital missions: propagate this many orbits after insertion to validate. */
  orbitValidationRevs: number;
  missionId?: string;
}

export const DEFAULT_INTEGRATOR: IntegratorConfig = {
  rtol: 1e-9,
  positionTolM: 1e-3,
  hMaxCorridorS: 5e-5,
  hMaxAtmosphereS: 0.01,
  hMaxBurnS: 0.25,
  hMaxCoastS: 20,
  hMaxRotorS: 0.5,
};

export function cloneConfig<T>(c: T): T {
  return JSON.parse(JSON.stringify(c)) as T;
}

/** Set a value at a dotted path (e.g. 'launcher.armRadiusM'). */
export function setPath(obj: unknown, path: string, value: unknown): void {
  const parts = path.split('.');
  let o = obj as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] as Record<string, unknown>;
  o[parts[parts.length - 1]] = value;
}

export function getPath(obj: unknown, path: string): unknown {
  let o = obj as Record<string, unknown> | undefined;
  for (const p of path.split('.')) {
    if (o === undefined || o === null) return undefined;
    o = o[p] as Record<string, unknown>;
  }
  return o;
}
