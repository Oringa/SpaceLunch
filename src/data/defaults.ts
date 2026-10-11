/**
 * Baseline configurations. Mission reference configurations are derived from
 * these in data/designs.ts and verified by the solver in tests/missions.test.ts.
 */
import { DEFAULT_INTEGRATOR, MODEL_VERSION, SCHEMA_VERSION, type SimConfig } from '../sim/config';

/** Desert test range: a dry, high-altitude inland site (generic; not a real facility). */
export const SITE_DESERT = { latitudeDeg: 32.99, longitudeDeg: -106.97, altitudeM: 1400 };

export function baseConfig(): SimConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    modelVersion: MODEL_VERSION,
    name: 'Baseline',
    seed: 1,
    fidelity: 'engineering',
    physics: { atmosphere: true, earthRotation: true },
    site: { ...SITE_DESERT },
    launcher: {
      armRadiusM: 50,
      chamberRadiusM: 53,
      chamberDepthM: 6,
      targetTipSpeedMps: 2000,
      arm: { materialId: 'cfrp-ud', profile: 'constant-stress', rootAreaM2: 0.6, tipAreaM2: 0.03, sectionAspect: 4 },
      hubInertiaKgM2: 2e5,
      balanceId: 'ballast-release',
      counterRadiusFraction: 1,
      mountId: 'despin',
      motorId: 'drive-25mw',
      bearingId: 'hydrodynamic-large',
      vacuum: {
        targetPressurePa: 2,
        chamberTemperatureK: 293,
        pumpSpeedM3s: 250,
        gasLoadPerAreaPaM3sM2: 2e-4,
        ultimatePressurePa: 0.01,
        pumpPowerW: 400e3,
      },
      gasDrag: { cdContinuum: 0.5, cdFreeMolecular: 2.4 },
      exit: { apertureRadiusM: 0.45, tunnelLengthM: 12, membraneArealDensityKgM2: 0.2 },
      release: { mode: 'phase-locked', actuatorLatencyS: 0.002, timingOffsetS: 0, timingJitterStdS: 20e-6, armingTolerance: 1e-4 },
      structure: { safetyFactor: 1.5, maxTipTangentialAccel: 80 },
      regenEfficiency: 0.7,
    },
    vehicle: {
      payloadMassKg: 40,
      payloadId: 'instrument-hardened',
      aeroFamilyId: 'slender-ogive',
      finsId: 'small-tail',
      lengthM: 3.0,
      diameterM: 0.28,
      noseRadiusM: 0.03,
      airframeArealMassKgM2: 18,
      fairingMassKg: 8,
      mountingMassKg: 6,
      noseBallastKg: 0,
      protectionId: 'cc-standard',
      stackId: 'none',
      rcsId: 'none',
      maxDynamicPressurePa: 6e6,
      maxNormalForceN: 6e4,
      maxAngleOfAttackDeg: 12,
      angleLimitAboveQPa: 2e5,
    },
    flightPlan: {
      azimuthDeg: 90,
      elevationDeg: 65,
      coastAttitude: 'passive',
      jettison: { kind: 'never' },
      guidance: {
        mode: 'none',
        ignition: { kind: 'vertical-speed-below', valueMps: 400 },
        targetAltitudeM: 260_000,
        cutoffPeriapsisM: 205_000,
        pitchProgram: [[0, 30], [60, 15], [200, 0]],
        stagingCoastS: 3,
      },
    },
    environment: {
      weatherSeed: 7,
      perturbation: { enabled: false, surfacePressureStdFrac: 0.01, temperatureStdK: 4, thermosphereDensityStdFrac: 0.3 },
      wind: {
        enabled: false,
        layers: [
          { altitudeM: 0, speedMps: 5, fromDeg: 250 },
          { altitudeM: 10_000, speedMps: 30, fromDeg: 270 },
          { altitudeM: 25_000, speedMps: 10, fromDeg: 90 },
        ],
        structureAmplitudeMps: 2,
      },
    },
    integrator: { ...DEFAULT_INTEGRATOR },
    uncertainty: { enabled: false },
    maxFlightTimeS: 4 * 3600,
    orbitValidationRevs: 1,
  };
}
