/**
 * Parameter registry: every editable CAUSE in a SimConfig, with its symbol,
 * SI unit, display unit, range, precision, tooltip, provenance class and
 * dependencies. Derived consequences (RPM, wet mass, loads, ...) are never
 * editable; they are listed in DERIVED_QUANTITIES with the model that
 * computes them.
 */
import type { SourceClass } from '../physics/provenance';
import {
  ARM_MATERIALS, BALANCE_PRESETS, BEARING_PRESETS, MOTOR_PRESETS, MOUNT_PRESETS, PAYLOAD_PRESETS,
  PROTECTION_PRESETS, RCS_PRESETS, UPPER_STAGE_STACKS,
} from './presets';
import { AERO_FAMILIES, FIN_PRESETS } from '../physics/aero';

export type ParamGroup = 'launcher' | 'vehicle' | 'flight' | 'environment' | 'numerics' | 'mode';
export type ParamTier = 'primary' | 'detail' | 'expert';

export interface UnitSpec {
  si: string;
  display: string;
  /** display = si * factor + offset */
  factor: number;
  offset?: number;
}

export const U = {
  m: { si: 'm', display: 'm', factor: 1 },
  km: { si: 'm', display: 'km', factor: 1e-3 },
  cm: { si: 'm', display: 'cm', factor: 100 },
  mm: { si: 'm', display: 'mm', factor: 1000 },
  mps: { si: 'm/s', display: 'm/s', factor: 1 },
  kg: { si: 'kg', display: 'kg', factor: 1 },
  kgm2: { si: 'kg/m²', display: 'kg/m²', factor: 1 },
  m2: { si: 'm²', display: 'm²', factor: 1 },
  deg: { si: 'deg', display: '°', factor: 1 },
  pa: { si: 'Pa', display: 'Pa', factor: 1 },
  kpa: { si: 'Pa', display: 'kPa', factor: 1e-3 },
  mpa: { si: 'Pa', display: 'MPa', factor: 1e-6 },
  kn: { si: 'N', display: 'kN', factor: 1e-3 },
  K: { si: 'K', display: 'K', factor: 1 },
  s: { si: 's', display: 's', factor: 1 },
  us: { si: 's', display: 'µs', factor: 1e6 },
  ms: { si: 's', display: 'ms', factor: 1e3 },
  kw: { si: 'W', display: 'kW', factor: 1e-3 },
  m3s: { si: 'm³/s', display: 'm³/s', factor: 1 },
  kgm2rot: { si: 'kg·m²', display: 'kg·m²', factor: 1 },
  gasload: { si: 'Pa·m³/(s·m²)', display: 'Pa·m³/(s·m²)', factor: 1 },
  none: { si: '-', display: '', factor: 1 },
  frac: { si: '-', display: '%', factor: 100 },
} satisfies Record<string, UnitSpec>;

export interface ParamDef {
  path: string;
  name: string;
  symbol: string;
  unit: UnitSpec;
  kind: 'number' | 'select' | 'boolean';
  min?: number;
  max?: number;
  /** Display decimals. */
  precision?: number;
  scale?: 'linear' | 'log';
  options?: Array<{ value: string; label: string }>;
  tooltip: string;
  classification: SourceClass;
  group: ParamGroup;
  section: string;
  tier: ParamTier;
  /** Consequences this cause feeds (derived quantity ids). */
  affects: string[];
  /** Other causes that constrain its valid range. */
  dependsOn: string[];
  editableDuringRun: false;
}

const opts = <T extends { name: string }>(rec: Record<string, T>): Array<{ value: string; label: string }> =>
  Object.entries(rec).map(([value, p]) => ({ value, label: p.name }));

const P = (d: Omit<ParamDef, 'editableDuringRun' | 'dependsOn' | 'affects'> & Partial<Pick<ParamDef, 'dependsOn' | 'affects'>>): ParamDef => ({
  dependsOn: [],
  affects: [],
  ...d,
  editableDuringRun: false,
});

export const PARAMS: ParamDef[] = [
  // ------------------------------------------------------------ primary eight
  P({ path: 'launcher.armRadiusM', name: 'Effective arm radius', symbol: 'R', unit: U.m, kind: 'number', min: 10, max: 100, precision: 1, tooltip: 'Distance from the hub axis to the vehicle centre of mass (not the chamber radius or diameter). Sets omega = v/R and a = v²/R.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Rotor', tier: 'primary', affects: ['rpm', 'aRadialG', 'stressMax', 'rotorKE', 'spinupTime'], dependsOn: ['launcher.chamberRadiusM'] }),
  P({ path: 'launcher.targetTipSpeedMps', name: 'Target tip speed', symbol: 'v_tip', unit: U.mps, kind: 'number', min: 200, max: 2500, precision: 0, tooltip: 'Commanded release speed. Whether it is reachable depends on drive power, torque, losses and structural limits; infeasible commands are reported, not fixed.', classification: 'physical-law', group: 'launcher', section: 'Rotor', tier: 'primary', affects: ['rpm', 'aRadialG', 'stressMax', 'vehicleKE', 'spinupTime'] }),
  P({ path: 'flightPlan.elevationDeg', name: 'Launch elevation', symbol: 'e', unit: U.deg, kind: 'number', min: 5, max: 90, precision: 1, tooltip: 'Elevation of the exit tunnel. Changing it moves the exit port around the chamber: the release phase is 270° − e.', classification: 'physical-law', group: 'flight', section: 'Launch geometry', tier: 'primary', affects: ['apogee', 'releasePhase'] }),
  P({ path: 'vehicle.payloadMassKg', name: 'Delivered payload mass', symbol: 'm_pl', unit: U.kg, kind: 'number', min: 0.5, max: 500, precision: 1, tooltip: 'Mass that must arrive. Distinct from the wet mass the centrifuge must accelerate.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Payload', tier: 'primary', affects: ['wetMass', 'ballisticCoefficient', 'stressMax'] }),
  P({ path: 'vehicle.aeroFamilyId', name: 'Vehicle shape family', symbol: '—', unit: U.none, kind: 'select', options: opts(AERO_FAMILIES).filter((o) => o.value !== 'stack-cylinder'), tooltip: 'Documented coefficient-table family (Mach and angle of attack). Not an "aerodynamics quality" score: each family has a different drag, centre of pressure and heating distribution.', classification: 'engineering-approximation', group: 'vehicle', section: 'Aeroshell', tier: 'primary', affects: ['ballisticCoefficient', 'stabilityMargin'] }),
  P({ path: 'vehicle.protectionId', name: 'Thermal protection', symbol: '—', unit: U.none, kind: 'select', options: opts(PROTECTION_PRESETS), tooltip: 'Nose-cap material and thickness, body tiles and insulation. Heavier protection buys temperature margin with mass.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Thermal protection', tier: 'primary', affects: ['wetMass', 'thermalMargin'] }),
  P({ path: 'vehicle.stackId', name: 'Upper stage', symbol: '—', unit: U.none, kind: 'select', options: opts(UPPER_STAGE_STACKS), tooltip: 'Onboard propulsion carried inside the aeroshell. Needs volume: tanks must fit, and must survive the centrifuge load.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Upper stage', tier: 'primary', affects: ['wetMass', 'idealDeltaV'] }),
  P({ path: 'flightPlan.guidance.mode', name: 'Flight program', symbol: '—', unit: U.none, kind: 'select', options: [
    { value: 'none', label: 'Ballistic (no burn)' },
    { value: 'assisted-insertion', label: 'Assisted orbit insertion' },
    { value: 'prograde', label: 'Prograde burn' },
    { value: 'pitch-program', label: 'Pitch program' },
  ], tooltip: 'Steering for the upper stage. The assisted law obeys the same thrust, torque and propellant limits and reports infeasible targets.', classification: 'engineering-approximation', group: 'flight', section: 'Guidance', tier: 'primary' }),

  // ------------------------------------------------------------ launcher details
  P({ path: 'launcher.chamberRadiusM', name: 'Chamber inner radius', symbol: 'R_c', unit: U.m, kind: 'number', min: 8, max: 110, precision: 1, tooltip: 'Inner radius of the vacuum vessel. Must clear the vehicle on the arm. Sets chamber volume (pump-down) and the free path to the exit wall.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Chamber & vacuum', tier: 'detail', dependsOn: ['launcher.armRadiusM', 'vehicle.lengthM'], affects: ['pumpdownTime'] }),
  P({ path: 'launcher.chamberDepthM', name: 'Chamber axial depth', symbol: 'w_c', unit: U.m, kind: 'number', min: 1, max: 20, precision: 1, tooltip: 'Depth of the disc-shaped chamber along the rotor axis.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Chamber & vacuum', tier: 'detail', affects: ['pumpdownTime'] }),
  P({ path: 'launcher.vacuum.targetPressurePa', name: 'Chamber pressure', symbol: 'p_c', unit: U.pa, kind: 'number', min: 0.01, max: 1000, precision: 3, scale: 'log', tooltip: 'Absolute pressure at launch. Lower pressure cuts residual-gas drag on the arm but lengthens pump-down.', classification: 'engineering-approximation', group: 'launcher', section: 'Chamber & vacuum', tier: 'detail', affects: ['pumpdownTime', 'gasLossPower'] }),
  P({ path: 'launcher.vacuum.pumpSpeedM3s', name: 'Pumping speed', symbol: 'S', unit: U.m3s, kind: 'number', min: 1, max: 2000, precision: 0, scale: 'log', tooltip: 'Constant effective pumping speed (an idealisation: real pumps lose speed at low pressure).', classification: 'engineering-approximation', group: 'launcher', section: 'Chamber & vacuum', tier: 'detail', affects: ['pumpdownTime'] }),
  P({ path: 'launcher.vacuum.gasLoadPerAreaPaM3sM2', name: 'Leak + outgassing per area', symbol: 'q', unit: U.gasload, kind: 'number', min: 1e-7, max: 1e-1, precision: 7, scale: 'log', tooltip: 'Gas load per unit internal surface. Larger chambers leak more: no free vacuum for big facilities.', classification: 'engineering-approximation', group: 'launcher', section: 'Chamber & vacuum', tier: 'expert', affects: ['pumpdownTime'] }),
  P({ path: 'launcher.vacuum.ultimatePressurePa', name: 'Ultimate pressure floor', symbol: 'p_ult', unit: U.pa, kind: 'number', min: 1e-5, max: 10, precision: 5, scale: 'log', tooltip: 'Lowest pressure the pump set can reach regardless of time.', classification: 'engineering-approximation', group: 'launcher', section: 'Chamber & vacuum', tier: 'expert' }),
  P({ path: 'launcher.vacuum.pumpPowerW', name: 'Pump electrical power', symbol: 'P_pump', unit: U.kw, kind: 'number', min: 1e3, max: 5e6, precision: 0, tooltip: 'Pumps run during pump-down, spin-up and hold.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Chamber & vacuum', tier: 'expert' }),
  P({ path: 'launcher.vacuum.chamberTemperatureK', name: 'Chamber gas temperature', symbol: 'T_c', unit: U.K, kind: 'number', min: 200, max: 400, precision: 0, tooltip: 'Residual gas temperature (isothermal assumption).', classification: 'engineering-approximation', group: 'launcher', section: 'Chamber & vacuum', tier: 'expert' }),
  P({ path: 'launcher.arm.materialId', name: 'Arm material', symbol: '—', unit: U.none, kind: 'select', options: opts(ARM_MATERIALS), tooltip: 'Density and modelled failure threshold. Specific strength limits tip speed: a uniform bar fails at v = sqrt(2 sigma / rho).', classification: 'engineering-approximation', group: 'launcher', section: 'Rotor', tier: 'detail', affects: ['stressMax', 'armMass'] }),
  P({ path: 'launcher.arm.profile', name: 'Arm taper profile', symbol: '—', unit: U.none, kind: 'select', options: [
    { value: 'constant-stress', label: 'Constant-stress (Gaussian) taper' },
    { value: 'exponential', label: 'Exponential taper' },
    { value: 'linear', label: 'Linear taper' },
  ], tooltip: 'How the section area varies from root to tip.', classification: 'physical-law', group: 'launcher', section: 'Rotor', tier: 'detail', affects: ['stressMax', 'armMass'] }),
  P({ path: 'launcher.arm.rootAreaM2', name: 'Arm root section area', symbol: 'A_root', unit: U.m2, kind: 'number', min: 0.001, max: 10, precision: 4, scale: 'log', tooltip: 'Cross-section at the hub, carrying the full centripetal load of the arm and tip mass.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Rotor', tier: 'detail', affects: ['stressMax', 'armMass', 'rotorKE'] }),
  P({ path: 'launcher.arm.tipAreaM2', name: 'Arm tip section area', symbol: 'A_tip', unit: U.m2, kind: 'number', min: 0.0005, max: 2, precision: 4, scale: 'log', tooltip: 'Cross-section at the vehicle end, carrying the tip mass load m omega² R.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Rotor', tier: 'detail', affects: ['stressMax', 'armMass'] }),
  P({ path: 'launcher.arm.sectionAspect', name: 'Arm section streamlining (chord/height)', symbol: 'c/b', unit: U.none, kind: 'number', min: 1, max: 12, precision: 1, tooltip: 'Higher values make a thinner frontal height for the same area, reducing residual-gas drag.', classification: 'engineering-approximation', group: 'launcher', section: 'Rotor', tier: 'expert', affects: ['gasLossPower'] }),
  P({ path: 'launcher.hubInertiaKgM2', name: 'Hub inertia', symbol: 'I_hub', unit: U.kgm2rot, kind: 'number', min: 0, max: 1e7, precision: 0, tooltip: 'Rotational inertia of hub and shaft.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Rotor', tier: 'expert', affects: ['rotorKE'] }),
  P({ path: 'launcher.balanceId', name: 'Counterbalance design', symbol: '—', unit: U.none, kind: 'select', options: opts(BALANCE_PRESETS), tooltip: 'Fixed static balance leaves an imbalance m·omega²·R on the bearing after release; the fictional ballast release keeps the rotor balanced at a refurbishment cost.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Rotor', tier: 'detail', affects: ['bearingLoad'] }),
  P({ path: 'launcher.counterRadiusFraction', name: 'Counterbalance radius / R', symbol: 'R_cb/R', unit: U.frac, kind: 'number', min: 0.3, max: 1, precision: 0, tooltip: 'A shorter counter arm needs a heavier counter mass (same static moment) but stores less energy.', classification: 'physical-law', group: 'launcher', section: 'Rotor', tier: 'expert', affects: ['rotorKE', 'counterMass'] }),
  P({ path: 'launcher.motorId', name: 'Drive', symbol: '—', unit: U.none, kind: 'select', options: opts(MOTOR_PRESETS), tooltip: 'Electrical power, mechanical torque ceiling and efficiency. Torque-limited from standstill, then power-limited.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Drive & bearings', tier: 'detail', affects: ['spinupTime', 'equilibriumSpeed'] }),
  P({ path: 'launcher.bearingId', name: 'Bearings', symbol: '—', unit: U.none, kind: 'select', options: opts(BEARING_PRESETS), tooltip: 'Coulomb + viscous loss model and a transient radial-load envelope.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Drive & bearings', tier: 'detail', affects: ['bearingLoad', 'spinupTime'] }),
  P({ path: 'launcher.gasDrag.cdContinuum', name: 'Arm drag coefficient (continuum)', symbol: 'C_d,c', unit: U.none, kind: 'number', min: 0.05, max: 3, precision: 2, tooltip: 'Frontal drag coefficient of the arm section in continuum flow.', classification: 'engineering-approximation', group: 'launcher', section: 'Drive & bearings', tier: 'expert' }),
  P({ path: 'launcher.gasDrag.cdFreeMolecular', name: 'Arm drag coefficient (free molecular)', symbol: 'C_d,fm', unit: U.none, kind: 'number', min: 1, max: 4, precision: 2, tooltip: 'Frontal drag coefficient in free-molecular flow (diffuse reflection).', classification: 'engineering-approximation', group: 'launcher', section: 'Drive & bearings', tier: 'expert' }),
  P({ path: 'launcher.mountId', name: 'Vehicle mount', symbol: '—', unit: U.none, kind: 'select', options: opts(MOUNT_PRESETS), tooltip: 'Defines attitude and residual angular velocity at separation. A rigid cradle passes the full rotor rate to the vehicle.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Release', tier: 'detail', affects: ['residualPitchRate'] }),
  P({ path: 'launcher.exit.apertureRadiusM', name: 'Exit aperture radius', symbol: 'r_ap', unit: U.cm, kind: 'number', min: 0.05, max: 2, precision: 0, tooltip: 'Radius of the exit port and tunnel. Bigger is more forgiving but needs a larger membrane and leaks more air on rupture.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Release', tier: 'detail', affects: ['timingTolerance'], dependsOn: ['vehicle.diameterM', 'vehicle.finsId'] }),
  P({ path: 'launcher.exit.tunnelLengthM', name: 'Exit tunnel length', symbol: 'L_t', unit: U.m, kind: 'number', min: 0, max: 60, precision: 1, tooltip: 'Straight tunnel from the chamber wall to the membrane. Longer tunnels amplify timing errors (lateral offset ≈ ω·Δt·distance).', classification: 'fictional-game-hardware', group: 'launcher', section: 'Release', tier: 'detail', affects: ['timingTolerance'] }),
  P({ path: 'launcher.exit.membraneArealDensityKgM2', name: 'Exit membrane areal density', symbol: 'σ_m', unit: U.kgm2, kind: 'number', min: 0, max: 5, precision: 2, tooltip: 'Membrane mass per area; the vehicle loses momentum tearing through it (perfectly inelastic approximation).', classification: 'engineering-approximation', group: 'launcher', section: 'Release', tier: 'expert' }),
  P({ path: 'launcher.release.mode', name: 'Release mode', symbol: '—', unit: U.none, kind: 'select', options: [
    { value: 'phase-locked', label: 'Automatic phase-locked release' },
    { value: 'manual-training', label: 'Manual training challenge (slowed playback)' },
  ], tooltip: 'Phase-locked release is the default. Manual release is a training challenge with the physical clock unchanged.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Release', tier: 'detail' }),
  P({ path: 'launcher.release.actuatorLatencyS', name: 'Release actuator latency', symbol: 't_lat', unit: U.ms, kind: 'number', min: 0, max: 0.05, precision: 2, tooltip: 'Delay between command and separation. Phase-locked release compensates its nominal value; manual release does not.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Release', tier: 'expert' }),
  P({ path: 'launcher.release.timingOffsetS', name: 'Systematic timing offset', symbol: 'Δt_0', unit: U.us, kind: 'number', min: -0.005, max: 0.005, precision: 1, tooltip: 'Uncompensated timing bias. Direction error ≈ omega·Δt.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Release', tier: 'detail', affects: ['releaseDirectionError'] }),
  P({ path: 'launcher.release.timingJitterStdS', name: 'Timing jitter (1σ)', symbol: 'σ_t', unit: U.us, kind: 'number', min: 0, max: 0.002, precision: 1, tooltip: 'Random timing error, sampled once per run from the seed.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Release', tier: 'detail' }),
  P({ path: 'launcher.structure.safetyFactor', name: 'Required safety factor', symbol: 'SF', unit: U.none, kind: 'number', min: 1, max: 4, precision: 2, tooltip: 'Warning margin on modelled arm stress. Exceeding it is a margin warning, not proof of fracture; the failure threshold is the material strength.', classification: 'engineering-approximation', group: 'launcher', section: 'Structure', tier: 'detail' }),
  P({ path: 'launcher.structure.maxTipTangentialAccel', name: 'Unmodelled-bending envelope', symbol: 'a_t,max', unit: U.mps, kind: 'number', min: 1, max: 1000, precision: 0, tooltip: 'Envelope on tip tangential acceleration (m/s²) standing in for bending, which is not simulated.', classification: 'fictional-game-hardware', group: 'launcher', section: 'Structure', tier: 'expert' }),
  P({ path: 'launcher.regenEfficiency', name: 'Regenerative braking efficiency', symbol: 'η_regen', unit: U.frac, kind: 'number', min: 0, max: 0.95, precision: 0, tooltip: 'Fraction of residual rotor energy recovered after release (reported separately; not credited against cost).', classification: 'fictional-game-hardware', group: 'launcher', section: 'Drive & bearings', tier: 'expert' }),

  // ------------------------------------------------------------ vehicle
  P({ path: 'vehicle.payloadId', name: 'Payload hardware class', symbol: '—', unit: U.none, kind: 'select', options: opts(PAYLOAD_PRESETS), tooltip: 'Load-duration and temperature envelope of the payload.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Payload', tier: 'detail' }),
  P({ path: 'vehicle.lengthM', name: 'Vehicle length', symbol: 'L', unit: U.m, kind: 'number', min: 0.5, max: 12, precision: 2, tooltip: 'Sets internal volume, wetted area, inertia and chamber clearance.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Aeroshell', tier: 'detail', affects: ['wetMass', 'stabilityMargin'] }),
  P({ path: 'vehicle.diameterM', name: 'Vehicle diameter', symbol: 'D', unit: U.cm, kind: 'number', min: 0.05, max: 1.5, precision: 1, tooltip: 'Sets the drag reference area A = pi D²/4 and internal volume.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Aeroshell', tier: 'detail', affects: ['ballisticCoefficient'] }),
  P({ path: 'vehicle.noseRadiusM', name: 'Effective nose radius', symbol: 'r_n', unit: U.cm, kind: 'number', min: 0.003, max: 0.75, precision: 1, tooltip: 'Larger radius lowers stagnation heating (q ∝ 1/sqrt(r_n)) but adds drag; constrained by the shape family.', classification: 'engineering-approximation', group: 'vehicle', section: 'Aeroshell', tier: 'detail', dependsOn: ['vehicle.diameterM', 'vehicle.aeroFamilyId'], affects: ['peakHeatFlux'] }),
  P({ path: 'vehicle.finsId', name: 'Fins', symbol: '—', unit: U.none, kind: 'select', options: opts(FIN_PRESETS), tooltip: 'Tail fins move the centre of pressure aft (stability) and add mass and drag. Their force vanishes with dynamic pressure.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Aeroshell', tier: 'detail', affects: ['stabilityMargin'] }),
  P({ path: 'vehicle.airframeArealMassKgM2', name: 'Airframe areal mass', symbol: 'm″_af', unit: U.kgm2, kind: 'number', min: 2, max: 60, precision: 1, tooltip: 'Structural mass per wetted area of the aeroshell.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Aeroshell', tier: 'expert', affects: ['wetMass'] }),
  P({ path: 'vehicle.fairingMassKg', name: 'Nose fairing mass', symbol: 'm_f', unit: U.kg, kind: 'number', min: 0, max: 200, precision: 1, tooltip: 'Jettisoned with the aeroshell.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Aeroshell', tier: 'expert' }),
  P({ path: 'vehicle.mountingMassKg', name: 'Mounting/interface hardware', symbol: 'm_mt', unit: U.kg, kind: 'number', min: 0, max: 200, precision: 1, tooltip: 'Interface hardware that flies with the vehicle and is discarded with the aeroshell.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Aeroshell', tier: 'expert' }),
  P({ path: 'vehicle.noseBallastKg', name: 'Nose ballast', symbol: 'm_b', unit: U.kg, kind: 'number', min: 0, max: 300, precision: 1, tooltip: 'Moves the CG forward for stability at the cost of mass.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Aeroshell', tier: 'detail', affects: ['stabilityMargin', 'wetMass'] }),
  P({ path: 'vehicle.rcsId', name: 'Reaction control', symbol: '—', unit: U.none, kind: 'select', options: opts(RCS_PRESETS), tooltip: 'Finite-torque, finite-propellant attitude control for thin air and vacuum.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Attitude hardware', tier: 'detail' }),
  P({ path: 'vehicle.maxDynamicPressurePa', name: 'Aeroshell dynamic-pressure envelope', symbol: 'q_max', unit: U.mpa, kind: 'number', min: 1e4, max: 2e7, precision: 2, tooltip: 'Exceeding it is an aerodynamic-overload failure.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Envelopes', tier: 'detail' }),
  P({ path: 'vehicle.maxNormalForceN', name: 'Aeroshell normal-force envelope', symbol: 'N_max', unit: U.kn, kind: 'number', min: 100, max: 5e6, precision: 1, tooltip: 'Bending proxy: aerodynamic normal-force limit.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Envelopes', tier: 'detail' }),
  P({ path: 'vehicle.maxAngleOfAttackDeg', name: 'Angle-of-attack envelope', symbol: 'α_max', unit: U.deg, kind: 'number', min: 1, max: 90, precision: 1, tooltip: 'Unstable-flight criterion: exceeded while dynamic pressure is above the threshold below.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Envelopes', tier: 'expert' }),
  P({ path: 'vehicle.angleLimitAboveQPa', name: 'AoA envelope applies above q', symbol: 'q_α', unit: U.kpa, kind: 'number', min: 100, max: 5e6, precision: 0, tooltip: 'Dynamic pressure above which the angle-of-attack envelope applies.', classification: 'fictional-game-hardware', group: 'vehicle', section: 'Envelopes', tier: 'expert' }),

  // ------------------------------------------------------------ flight plan
  P({ path: 'flightPlan.azimuthDeg', name: 'Launch azimuth', symbol: 'Az', unit: U.deg, kind: 'number', min: 0, max: 360, precision: 1, tooltip: 'Clockwise from north. Due east gains the most from Earth rotation; it also sets the orbital inclination.', classification: 'physical-law', group: 'flight', section: 'Launch geometry', tier: 'detail', affects: ['inclination'] }),
  P({ path: 'site.latitudeDeg', name: 'Site latitude', symbol: 'φ', unit: U.deg, kind: 'number', min: -89, max: 89, precision: 2, tooltip: 'Geocentric latitude on the spherical Earth.', classification: 'physical-law', group: 'flight', section: 'Launch site', tier: 'detail', affects: ['inclination'] }),
  P({ path: 'site.longitudeDeg', name: 'Site longitude', symbol: 'λ', unit: U.deg, kind: 'number', min: -180, max: 180, precision: 2, tooltip: 'Longitude.', classification: 'physical-law', group: 'flight', section: 'Launch site', tier: 'expert' }),
  P({ path: 'site.altitudeM', name: 'Site altitude', symbol: 'h_0', unit: U.m, kind: 'number', min: -400, max: 5000, precision: 0, tooltip: 'Uniform terrain elevation (detailed terrain is out of scope). Higher sites start in thinner air.', classification: 'physical-law', group: 'flight', section: 'Launch site', tier: 'detail' }),
  P({ path: 'flightPlan.coastAttitude', name: 'Coast attitude control', symbol: '—', unit: U.none, kind: 'select', options: [
    { value: 'passive', label: 'Passive (aerodynamic stability only)' },
    { value: 'hold-air-relative', label: 'RCS holds nose on air-relative velocity' },
  ], tooltip: 'Attitude control before ignition; RCS authority and propellant are finite.', classification: 'engineering-approximation', group: 'flight', section: 'Guidance', tier: 'detail' }),
  P({ path: 'flightPlan.guidance.targetAltitudeM', name: 'Target apoapsis altitude', symbol: 'h_t', unit: U.km, kind: 'number', min: 120_000, max: 2_000_000, precision: 0, tooltip: 'Assisted insertion holds the osculating apoapsis here while raising periapsis.', classification: 'engineering-approximation', group: 'flight', section: 'Guidance', tier: 'detail' }),
  P({ path: 'flightPlan.guidance.cutoffPeriapsisM', name: 'Cutoff periapsis altitude', symbol: 'h_p,cut', unit: U.km, kind: 'number', min: 50_000, max: 1_500_000, precision: 0, tooltip: 'Engine cut-off once the osculating periapsis reaches this altitude.', classification: 'engineering-approximation', group: 'flight', section: 'Guidance', tier: 'detail', dependsOn: ['flightPlan.guidance.targetAltitudeM'] }),
  P({ path: 'flightPlan.guidance.stagingCoastS', name: 'Staging coast', symbol: 't_sep', unit: U.s, kind: 'number', min: 0, max: 60, precision: 1, tooltip: 'Delay between separation and the next ignition.', classification: 'fictional-game-hardware', group: 'flight', section: 'Guidance', tier: 'expert' }),

  // ------------------------------------------------------------ environment / numerics / mode
  P({ path: 'environment.wind.enabled', name: 'Wind', symbol: '—', unit: U.none, kind: 'boolean', tooltip: 'Horizontal wind vs altitude (table + seeded structure).', classification: 'engineering-approximation', group: 'environment', section: 'Weather', tier: 'detail' }),
  P({ path: 'environment.perturbation.enabled', name: 'Atmosphere perturbation', symbol: '—', unit: U.none, kind: 'boolean', tooltip: 'Seeded, hydrostatically consistent pressure/temperature perturbation of USSA76.', classification: 'engineering-approximation', group: 'environment', section: 'Weather', tier: 'detail' }),
  P({ path: 'environment.weatherSeed', name: 'Weather seed', symbol: '—', unit: U.none, kind: 'number', min: 0, max: 1e9, precision: 0, tooltip: 'Reproduces the same environment independently of solver step size.', classification: 'fictional-game-hardware', group: 'environment', section: 'Weather', tier: 'detail' }),
  P({ path: 'seed', name: 'Run seed', symbol: '—', unit: U.none, kind: 'number', min: 0, max: 1e9, precision: 0, tooltip: 'Seeds release jitter, mount error and (if enabled) hardware uncertainty.', classification: 'fictional-game-hardware', group: 'mode', section: 'Run', tier: 'detail' }),
  P({ path: 'physics.atmosphere', name: 'Atmosphere and aerodynamic heating', symbol: '—', unit: U.none, kind: 'boolean', tooltip: 'Disable for the vacuum thought experiment (gravity and orbital mechanics stay). Records are kept separate.', classification: 'physical-law', group: 'mode', section: 'Physics', tier: 'detail' }),
  P({ path: 'physics.earthRotation', name: 'Earth rotation', symbol: '—', unit: U.none, kind: 'boolean', tooltip: 'Disable to isolate rotation effects. Records are kept separate.', classification: 'physical-law', group: 'mode', section: 'Physics', tier: 'expert' }),
  P({ path: 'uncertainty.enabled', name: 'Hardware/model uncertainty', symbol: '—', unit: U.none, kind: 'boolean', tooltip: 'Perturbs aerodynamic, thermal, strength, drive and Isp parameters from their provenance uncertainty, using the run seed.', classification: 'engineering-approximation', group: 'mode', section: 'Run', tier: 'detail' }),
  P({ path: 'integrator.rtol', name: 'Relative tolerance', symbol: 'rtol', unit: U.none, kind: 'number', min: 1e-12, max: 1e-5, precision: 12, scale: 'log', tooltip: 'Dormand-Prince error control. Settings are justified by convergence tests.', classification: 'engineering-approximation', group: 'numerics', section: 'Integrator', tier: 'expert' }),
  P({ path: 'integrator.positionTolM', name: 'Position tolerance', symbol: 'atol_r', unit: U.mm, kind: 'number', min: 1e-6, max: 1, precision: 3, scale: 'log', tooltip: 'Absolute position tolerance; velocity uses 1e-3 of it.', classification: 'engineering-approximation', group: 'numerics', section: 'Integrator', tier: 'expert' }),
  P({ path: 'integrator.hMaxCorridorS', name: 'Step cap: exit corridor', symbol: 'h_cor', unit: U.us, kind: 'number', min: 1e-6, max: 1e-3, precision: 1, tooltip: 'Maximum step inside chamber and tunnel.', classification: 'engineering-approximation', group: 'numerics', section: 'Integrator', tier: 'expert' }),
  P({ path: 'integrator.hMaxAtmosphereS', name: 'Step cap: atmospheric flight', symbol: 'h_atm', unit: U.ms, kind: 'number', min: 1e-4, max: 1, precision: 2, tooltip: 'Maximum step below 90 km (x10 between 90 and 140 km).', classification: 'engineering-approximation', group: 'numerics', section: 'Integrator', tier: 'expert' }),
  P({ path: 'integrator.hMaxBurnS', name: 'Step cap: burns', symbol: 'h_burn', unit: U.s, kind: 'number', min: 1e-3, max: 5, precision: 3, tooltip: 'Maximum step while an engine burns.', classification: 'engineering-approximation', group: 'numerics', section: 'Integrator', tier: 'expert' }),
  P({ path: 'integrator.hMaxCoastS', name: 'Step cap: coast', symbol: 'h_coast', unit: U.s, kind: 'number', min: 0.01, max: 120, precision: 2, tooltip: 'Maximum step in quiet exo-atmospheric coast.', classification: 'engineering-approximation', group: 'numerics', section: 'Integrator', tier: 'expert' }),
  P({ path: 'integrator.hMaxRotorS', name: 'Step cap: rotor spin-up', symbol: 'h_rot', unit: U.s, kind: 'number', min: 1e-3, max: 5, precision: 3, tooltip: 'Maximum step during spin-up and hold.', classification: 'engineering-approximation', group: 'numerics', section: 'Integrator', tier: 'expert' }),
];

export const PARAM_BY_PATH: Record<string, ParamDef> = Object.fromEntries(PARAMS.map((p) => [p.path, p]));
export const PRIMARY_PARAMS = PARAMS.filter((p) => p.tier === 'primary');

export const toDisplay = (p: ParamDef, si: number): number => si * p.unit.factor + (p.unit.offset ?? 0);
export const fromDisplay = (p: ParamDef, d: number): number => (d - (p.unit.offset ?? 0)) / p.unit.factor;

/** Derived consequences (never editable), with the model that computes them. */
export interface DerivedDef {
  id: string;
  name: string;
  symbol: string;
  unit: string;
  model: string;
  formula: string;
  classification: SourceClass;
}

export const DERIVED_QUANTITIES: DerivedDef[] = [
  { id: 'omega', name: 'Angular speed', symbol: 'ω', unit: 'rad/s', model: 'rotor', formula: 'ω = v_tip / R', classification: 'physical-law' },
  { id: 'rpm', name: 'Rotor speed', symbol: 'n', unit: 'rpm', model: 'rotor', formula: 'n = 60 ω / 2π', classification: 'physical-law' },
  { id: 'aRadialG', name: 'Centripetal load', symbol: 'a/g0', unit: 'g', model: 'rotor', formula: 'a = ω² R; worst felt lateral load = (ω² R + g0)/g0', classification: 'physical-law' },
  { id: 'vehicleKE', name: 'Vehicle translational energy at release', symbol: 'E_v', unit: 'MJ', model: 'rotor', formula: 'E_v = ½ m_wet v_tip²  (not the electricity bill)', classification: 'physical-law' },
  { id: 'rotorKE', name: 'Rotating-assembly energy', symbol: 'E_rot', unit: 'MJ', model: 'rotor', formula: 'E_rot = ½ I_total ω²', classification: 'physical-law' },
  { id: 'stressMax', name: 'Peak arm axial stress', symbol: 'σ_max', unit: 'GPa', model: 'rotor', formula: 'σ(s) = [m_tip ω² R + ∫_s^R λ ω² x dx] / A(s)', classification: 'engineering-approximation' },
  { id: 'spinupTime', name: 'Spin-up time', symbol: 't_spin', unit: 's', model: 'rotor', formula: 'ω̇ = (τ_m − τ_loss)/I, τ_m ≤ τ_lim, τ_m ω ≤ η P_e', classification: 'physical-law' },
  { id: 'equilibriumSpeed', name: 'Highest sustainable tip speed', symbol: 'v_eq', unit: 'm/s', model: 'rotor', formula: 'τ_avail(ω) = τ_bearing(ω) + τ_gas(ω)', classification: 'engineering-approximation' },
  { id: 'gasLossPower', name: 'Residual-gas drag power at target', symbol: 'P_gas', unit: 'MW', model: 'rotor', formula: 'P = k_gas ω³, k_gas = ½ ρ_c C_d ∫ b x³ dx + vehicle + counter mass', classification: 'engineering-approximation' },
  { id: 'pumpdownTime', name: 'Pump-down time', symbol: 't_pump', unit: 's', model: 'vacuum', formula: 't = (V/S) ln[(p0 − Q/S)/(p_t − Q/S)]', classification: 'engineering-approximation' },
  { id: 'bearingLoad', name: 'Post-release bearing load', symbol: 'F_b', unit: 'MN', model: 'rotor', formula: 'F = m_wet ω² R (fixed balance)', classification: 'physical-law' },
  { id: 'wetMass', name: 'Wet mass', symbol: 'm_wet', unit: 'kg', model: 'vehicle', formula: 'Σ components (payload, stages, propellant, aeroshell, TPS, fins, RCS)', classification: 'physical-law' },
  { id: 'ballisticCoefficient', name: 'Ballistic coefficient (M=6)', symbol: 'β', unit: 'kg/m²', model: 'aero', formula: 'β = m / (C_D A_ref)', classification: 'engineering-approximation' },
  { id: 'stabilityMargin', name: 'Static margin', symbol: 'SM', unit: 'cal', model: 'aero', formula: 'SM = (x_cp − x_cg)/D', classification: 'engineering-approximation' },
  { id: 'idealDeltaV', name: 'Ideal Δv', symbol: 'Δv', unit: 'm/s', model: 'propulsion', formula: 'Σ Isp g0 ln(m0/mf) per stage', classification: 'physical-law' },
  { id: 'timingTolerance', name: 'Release timing tolerance (estimate)', symbol: 'Δt_tol', unit: 'µs', model: 'launcher', formula: 'Δt ≈ (r_ap − r_env) / (ω · s_end)', classification: 'physical-law' },
  { id: 'releaseDirectionError', name: 'Direction error per ms', symbol: 'δ', unit: 'rad', model: 'launcher', formula: 'δ ≈ ω Δt', classification: 'physical-law' },
  { id: 'inclination', name: 'Inclination estimate', symbol: 'i', unit: '°', model: 'orbit', formula: 'cos i = cos φ sin Az', classification: 'physical-law' },
];
