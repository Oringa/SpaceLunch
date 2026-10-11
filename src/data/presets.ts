/**
 * Hardware presets. Every preset carries a provenance classification. Values
 * labelled 'published-reference' are typical handbook magnitudes rather than
 * certified design allowables; game hardware is explicitly fictional.
 * Costs are fictional game credits (cr).
 */
import { prov, type Provenance } from '../physics/provenance';
import type { ArmMaterial, MotorSpec, BearingSpec } from '../physics/rotor';
import type { ThermalMaterial } from '../physics/thermal';
import type { StageSpec } from '../physics/propulsion';

const typical = (note: string, rel = 0.1): Provenance =>
  prov('engineering-approximation', ['H1'], `Typical handbook magnitude: ${note}. Not a certified design allowable.`, rel);
const game = (note: string, rel = 0.1): Provenance => prov('fictional-game-hardware', [], note, rel);

// ---------------------------------------------------------------- arm materials
export const ARM_MATERIALS: Record<string, ArmMaterial> = {
  'cfrp-ud': {
    id: 'cfrp-ud',
    name: 'Carbon-fibre composite (unidirectional, fibre along arm)',
    density: 1600,
    ultimateStrength: 2.0e9,
    costPerKg: 0.12,
    provenance: typical('UD CFRP rho ~1.6 t/m^3, fibre-direction tensile strength ~1.5-2.5 GPa'),
  },
  'maraging-steel': {
    id: 'maraging-steel',
    name: 'Maraging steel (grade 300 class)',
    density: 8000,
    ultimateStrength: 1.9e9,
    costPerKg: 0.04,
    provenance: typical('maraging 300: rho ~8.0 t/m^3, UTS ~1.9-2.0 GPa'),
  },
  'al-7075': {
    id: 'al-7075',
    name: 'Aluminium 7075-T6',
    density: 2810,
    ultimateStrength: 5.7e8,
    costPerKg: 0.01,
    provenance: typical('7075-T6: rho 2.81 t/m^3, UTS ~570 MPa'),
  },
  'fiction-cnt': {
    id: 'fiction-cnt',
    name: 'Nanotube-yarn composite (fictional)',
    density: 1300,
    ultimateStrength: 6.0e9,
    costPerKg: 1.5,
    provenance: game('Fictional future material for sandbox exploration. No production material offers this today.'),
  },
};

// ---------------------------------------------------------------- motors / drives
export interface MotorPreset extends MotorSpec {
  id: string;
  name: string;
  costCredits: number;
  provenance: Provenance;
}
export const MOTOR_PRESETS: Record<string, MotorPreset> = {
  'drive-1mw': {
    id: 'drive-1mw', name: '1 MW direct drive', electricalPowerW: 1e6, torqueLimitNm: 1.5e5, efficiency: 0.93, settleTimeS: 4,
    costCredits: 1_100, provenance: game('Generic synchronous drive; torque ceiling chosen for game balance.'),
  },
  'drive-2mw': {
    id: 'drive-2mw', name: '2 MW direct drive', electricalPowerW: 2e6, torqueLimitNm: 4e5, efficiency: 0.94, settleTimeS: 4,
    costCredits: 2_000, provenance: game('Generic large synchronous drive; torque ceiling chosen for game balance.'),
  },
  'drive-8mw': {
    id: 'drive-8mw', name: '8 MW direct drive', electricalPowerW: 8e6, torqueLimitNm: 1.5e6, efficiency: 0.95, settleTimeS: 4,
    costCredits: 6_000, provenance: game('Generic large synchronous drive; torque ceiling chosen for game balance.'),
  },
  'drive-25mw': {
    id: 'drive-25mw', name: '25 MW multi-motor drive', electricalPowerW: 25e6, torqueLimitNm: 4e6, efficiency: 0.95, settleTimeS: 4,
    costCredits: 15_000, provenance: game('Several drives on one shaft; grid connection assumed available.'),
  },
  'drive-50mw': {
    id: 'drive-50mw', name: '50 MW multi-motor drive', electricalPowerW: 50e6, torqueLimitNm: 8e6, efficiency: 0.95, settleTimeS: 4,
    costCredits: 28_000, provenance: game('Upper end of exploration bounds; a utility-scale connection.'),
  },
};

// ---------------------------------------------------------------- bearings
export interface BearingPreset extends BearingSpec {
  id: string;
  name: string;
  costCredits: number;
  provenance: Provenance;
}
export const BEARING_PRESETS: Record<string, BearingPreset> = {
  'hydrodynamic-small': {
    id: 'hydrodynamic-small', name: 'Hydrodynamic journal bearing (small)', coulombTorqueNm: 400, viscousNmPerRadS: 60,
    radialLoadLimitN: 4e6, costCredits: 600, provenance: game('Loss coefficients and transient load envelope are game values of plausible magnitude.'),
  },
  'hydrodynamic-large': {
    id: 'hydrodynamic-large', name: 'Hydrodynamic journal bearing (large)', coulombTorqueNm: 2_500, viscousNmPerRadS: 400,
    radialLoadLimitN: 4e7, costCredits: 2_500, provenance: game('Loss coefficients and transient load envelope are game values of plausible magnitude.'),
  },
  'magnetic-active': {
    id: 'magnetic-active', name: 'Active magnetic bearing set', coulombTorqueNm: 150, viscousNmPerRadS: 20,
    radialLoadLimitN: 1.2e7, costCredits: 6_000, provenance: game('Low drag, modest transient capacity. Game values.'),
  },
};

// ---------------------------------------------------------------- thermal protection
export const TPS_MATERIALS: Record<string, ThermalMaterial> = {
  'al-bare': {
    id: 'al-bare', name: 'Bare aluminium nose (no TPS)', density: 2810, specificHeat: 960, conductivity: 130, emissivity: 0.3,
    maxTemperatureK: 450, costPerKg: 0.02, provenance: typical('Al alloy: strength falls steeply above ~450 K'),
  },
  'ti-heatsink': {
    id: 'ti-heatsink', name: 'Titanium heat-sink nose', density: 4430, specificHeat: 560, conductivity: 7, emissivity: 0.6,
    maxTemperatureK: 900, costPerKg: 0.1, provenance: typical('Ti-6Al-4V: rho 4.43 t/m^3, cp ~560 J/(kg K), k ~7 W/(m K)'),
  },
  'carbon-carbon': {
    id: 'carbon-carbon', name: 'Reinforced carbon-carbon cap', density: 1800, specificHeat: 1400, conductivity: 25, emissivity: 0.85,
    maxTemperatureK: 2000, costPerKg: 1.2,
    provenance: prov('engineering-approximation', ['H1'], 'C/C typical rho 1.8 t/m^3; temperature-averaged cp; 2000 K envelope stands in for oxidation limits in air (not modelled).', 0.15),
  },
  'uhtc': {
    id: 'uhtc', name: 'UHTC (ZrB2-SiC) cap', density: 5600, specificHeat: 600, conductivity: 60, emissivity: 0.8,
    maxTemperatureK: 2300, costPerKg: 2.0,
    provenance: prov('engineering-approximation', ['H1'], 'Ultra-high-temperature ceramic, typical magnitudes; brittle-fracture limits not modelled.', 0.2),
  },
};

export interface ProtectionPreset {
  id: string;
  name: string;
  noseMaterial: string;
  /** Nose-cap thickness (m). */
  noseThickness: number;
  /** Body TPS areal mass (kg/m^2) and heat capacity (J/(m^2 K)). */
  bodyArealMass: number;
  bodyArealHeatCapacity: number;
  bodyEmissivity: number;
  bodyMaxTemperatureK: number;
  insulationConductance: number;
  provenance: Provenance;
}
export const PROTECTION_PRESETS: Record<string, ProtectionPreset> = {
  none: {
    id: 'none', name: 'None (bare aluminium aeroshell)', noseMaterial: 'al-bare', noseThickness: 0.01,
    bodyArealMass: 0, bodyArealHeatCapacity: 2810 * 960 * 0.003, bodyEmissivity: 0.3, bodyMaxTemperatureK: 450, insulationConductance: 40,
    provenance: game('Bare structure: body heat capacity from a 3 mm Al skin.'),
  },
  'ti-light': {
    id: 'ti-light', name: 'Titanium nose + light body insulation', noseMaterial: 'ti-heatsink', noseThickness: 0.03,
    bodyArealMass: 6, bodyArealHeatCapacity: 9000, bodyEmissivity: 0.7, bodyMaxTemperatureK: 800, insulationConductance: 8,
    provenance: game('Heat-sink nose with a thin insulating body layer.'),
  },
  'cc-standard': {
    id: 'cc-standard', name: 'Carbon-carbon nose + ceramic body tiles', noseMaterial: 'carbon-carbon', noseThickness: 0.05,
    bodyArealMass: 10, bodyArealHeatCapacity: 12000, bodyEmissivity: 0.85, bodyMaxTemperatureK: 1500, insulationConductance: 3,
    provenance: game('Representative hypersonic TPS stack; non-ablating envelope.'),
  },
  'uhtc-heavy': {
    id: 'uhtc-heavy', name: 'UHTC nose + heavy ceramic body', noseMaterial: 'uhtc', noseThickness: 0.06,
    bodyArealMass: 16, bodyArealHeatCapacity: 18000, bodyEmissivity: 0.85, bodyMaxTemperatureK: 1700, insulationConductance: 2,
    provenance: game('Heaviest protection; best margin.'),
  },
};

// ---------------------------------------------------------------- upper stages
export const STAGE_PRESETS: Record<string, StageSpec> = {
  'kick-solid': {
    id: 'kick-solid', name: 'Hardened solid kick motor', dryMass: 22, propellantMass: 110, propellantDensity: 1800,
    thrustVac: 9_000, ispVac: 285, ispSl: 245, minThrottle: 1, maxIgnitions: 1, gimbalMaxDeg: 3,
    lateralSustainedG: 12_000, lateralPeakG: 20_000, axialPeakG: 30_000, engineLength: 0.25, costCredits: 900,
    provenance: game('Fictional high-g solid motor; Isp typical of solid propellants (published magnitude), hardware mass fraction is a game value.'),
  },
  'liquid-l1': {
    id: 'liquid-l1', name: 'Hardened pressure-fed liquid stage L1', dryMass: 70, propellantMass: 560, propellantDensity: 1250,
    thrustVac: 22_000, ispVac: 318, ispSl: 265, minThrottle: 0.4, maxIgnitions: 3, gimbalMaxDeg: 5,
    lateralSustainedG: 11_000, lateralPeakG: 18_000, axialPeakG: 25_000, engineLength: 0.35, costCredits: 2_400,
    provenance: game('Fictional high-g storable-propellant stage. Isp typical of storable bipropellants; dry mass a game value.'),
  },
  'liquid-l2': {
    id: 'liquid-l2', name: 'Hardened liquid stage L2 (small)', dryMass: 24, propellantMass: 170, propellantDensity: 1250,
    thrustVac: 6_500, ispVac: 322, ispSl: 250, minThrottle: 0.4, maxIgnitions: 3, gimbalMaxDeg: 5,
    lateralSustainedG: 11_000, lateralPeakG: 18_000, axialPeakG: 25_000, engineLength: 0.25, costCredits: 1_300,
    provenance: game('Fictional high-g storable-propellant stage. Isp typical of storable bipropellants; dry mass a game value.'),
  },
  'liquid-l1-light': {
    id: 'liquid-l1-light', name: 'Lightweight liquid stage L1-LT (lower g tolerance)', dryMass: 52, propellantMass: 560, propellantDensity: 1250,
    thrustVac: 22_000, ispVac: 318, ispSl: 265, minThrottle: 0.4, maxIgnitions: 3, gimbalMaxDeg: 5,
    lateralSustainedG: 6_000, lateralPeakG: 9_000, axialPeakG: 15_000, engineLength: 0.35, costCredits: 2_100,
    provenance: game('Same propulsion as L1 with less structural hardening: lighter, but a lower lateral-g envelope.'),
  },
};

export interface StackPreset {
  id: string;
  name: string;
  stages: string[];
}
export const UPPER_STAGE_STACKS: Record<string, StackPreset> = {
  none: { id: 'none', name: 'None (ballistic)', stages: [] },
  'kick-solid': { id: 'kick-solid', name: 'Single solid kick motor', stages: ['kick-solid'] },
  'l1': { id: 'l1', name: 'Single liquid stage L1', stages: ['liquid-l1'] },
  'l1-l2': { id: 'l1-l2', name: 'Two liquid stages L1 + L2', stages: ['liquid-l1', 'liquid-l2'] },
  'l1lt-l2': { id: 'l1lt-l2', name: 'Two stages L1-LT + L2 (lighter, lower g limit)', stages: ['liquid-l1-light', 'liquid-l2'] },
};

// ---------------------------------------------------------------- payloads
export interface PayloadPreset {
  id: string;
  name: string;
  lateralSustainedG: number;
  lateralPeakG: number;
  axialPeakG: number;
  /** Time a load may stay above the sustained limit (s). */
  sustainedDurationS: number;
  maxTemperatureK: number;
  bulkDensity: number;
  specificHeat: number;
  provenance: Provenance;
}
export const PAYLOAD_PRESETS: Record<string, PayloadPreset> = {
  'instrument-hardened': {
    id: 'instrument-hardened', name: 'Potted instrument package (high-g)', lateralSustainedG: 12_000, lateralPeakG: 20_000,
    axialPeakG: 25_000, sustainedDurationS: 5, maxTemperatureK: 340, bulkDensity: 1600, specificHeat: 900,
    provenance: game('Game envelope inspired by public statements that hardened electronics can tolerate ~10,000 g; not a qualification test result.'),
  },
  'smallsat-hardened': {
    id: 'smallsat-hardened', name: 'Hardened smallsat bus', lateralSustainedG: 11_000, lateralPeakG: 16_000,
    axialPeakG: 20_000, sustainedDurationS: 5, maxTemperatureK: 330, bulkDensity: 1100, specificHeat: 900,
    provenance: game('Game envelope for a satellite designed around kinetic launch.'),
  },
  'commercial-avionics': {
    id: 'commercial-avionics', name: 'Ordinary avionics (not hardened)', lateralSustainedG: 200, lateralPeakG: 500,
    axialPeakG: 500, sustainedDurationS: 5, maxTemperatureK: 330, bulkDensity: 900, specificHeat: 900,
    provenance: game('Illustrates why ordinary hardware cannot ride a centrifuge.'),
  },
};

// ---------------------------------------------------------------- RCS
export interface RcsPreset {
  id: string;
  name: string;
  dryMass: number;
  propellantMass: number;
  isp: number;
  /** Maximum control torque per axis, normalised by vehicle length (N m per m). */
  torquePerLength: number;
  provenance: Provenance;
}
export const RCS_PRESETS: Record<string, RcsPreset> = {
  none: { id: 'none', name: 'None', dryMass: 0, propellantMass: 0, isp: 1, torquePerLength: 0, provenance: game('No reaction control.') },
  'cold-gas': {
    id: 'cold-gas', name: 'Cold-gas thrusters', dryMass: 6, propellantMass: 4, isp: 65, torquePerLength: 40,
    provenance: game('Nitrogen cold gas, Isp typical (~65 s); thrust level a game value.'),
  },
  'hydrazine': {
    id: 'hydrazine', name: 'Monopropellant thrusters', dryMass: 9, propellantMass: 10, isp: 220, torquePerLength: 150,
    provenance: game('Hydrazine monoprop, Isp typical (~220 s); thrust level a game value.'),
  },
};

// ---------------------------------------------------------------- counterbalance designs
export interface BalancePreset {
  id: string;
  name: string;
  /** If true an equal ballast slug is released with the vehicle, keeping the rotor balanced. */
  releasesBallast: boolean;
  refurbCredits: number;
  provenance: Provenance;
}
export const BALANCE_PRESETS: Record<string, BalancePreset> = {
  'fixed-static': {
    id: 'fixed-static', name: 'Fixed static counterbalance', releasesBallast: false, refurbCredits: 0,
    provenance: prov('physical-law', [], 'Static balance before release. After release the rotor is unbalanced by the departed vehicle moment m R, loading the bearing with m omega^2 R.'),
  },
  'ballast-release': {
    id: 'ballast-release', name: 'Simultaneous ballast release into catch tube', releasesBallast: true, refurbCredits: 300,
    provenance: game('Fictional mechanism: an equal-moment ballast slug is released at the same instant into a separate catch tube. Keeps the bearing load bounded; consumes ballast and refurbishment.'),
  },
};

// ---------------------------------------------------------------- mounts
export interface MountPreset {
  id: string;
  name: string;
  /** Fraction of the rotor angular velocity retained by the vehicle at separation. */
  residualFraction: number;
  /** 1-sigma error of the residual pitch rate (rad/s), sampled once from the seed. */
  residualErrorStd: number;
  /** Cradle mass carried on the arm with the vehicle (stays on the rotor) = base + fraction x vehicle wet mass. */
  cradleBaseMass: number;
  cradleMassFraction: number;
  refurbCredits: number;
  provenance: Provenance;
}
export const MOUNT_PRESETS: Record<string, MountPreset> = {
  rigid: {
    id: 'rigid', name: 'Rigid cradle (vehicle inherits rotor rotation)', residualFraction: 1, residualErrorStd: 0,
    cradleBaseMass: 2, cradleMassFraction: 0.04, refurbCredits: 20,
    provenance: prov('physical-law', [], 'A rigidly attached body leaves with the rotor angular velocity: it keeps pitching at omega after release.'),
  },
  despin: {
    id: 'despin', name: 'Despin release cradle (fictional)', residualFraction: 0.01, residualErrorStd: 0.05,
    cradleBaseMass: 5, cradleMassFraction: 0.08, refurbCredits: 150,
    provenance: game('Fictional mechanism that imparts a counter-rotation at separation, leaving 1 % of rotor rate plus a seeded error. Not a description of any proprietary mechanism.'),
  },
};

export const ENERGY_PRICE_PER_MWH = 0.08; // credits per MWh (fictional)
export const PROPELLANT_CREDITS_PER_KG = 0.02;
export const MEMBRANE_CREDITS = 15;
