/**
 * Simplified aerothermal model [R8].
 *
 * Stagnation-point convective heat flux (Sutton-Graves form, Earth air):
 *     q_s = k sqrt(rho / r_n) V^3,   k = 1.7415e-4 (SI)
 * valid for hypersonic continuum flow over a blunt (spherical) nose. Outside
 * that domain the model reports a fidelity flag instead of pretending:
 *  - V < 2 km/s or M < 4: low-speed, flagged; a hot-wall enthalpy-difference
 *    factor (T_r - T_w)/(T_r - 300 K) prevents heating beyond recovery
 *    temperature.
 *  - rarefied flow (Kn > 0.01): flux bounded by the free-molecular limit
 *    0.5 rho V^3 (full accommodation).
 *
 * Thermal network (lumped, non-ablating):
 *  N1 stagnation surface layer   (per unit area at the stagnation point)
 *  N2 stagnation backing layer   (per unit area, rest of the nose-cap thickness)
 *  N3 body skin / body TPS       (per unit area, area-averaged heating fraction)
 *  N4 internal / payload         (lumped, whole vehicle interior)
 * Surface nodes re-radiate eps*sigma*(T^4 - T_sink^4). N2 and N3 conduct to
 * N4 through an insulation conductance. Peak local flux (N1) is distinguished
 * from area-averaged absorbed power (N3, N4).
 */
import { SIGMA_SB } from './constants';
import { prov, type Provenance } from './provenance';

export const SUTTON_GRAVES_K = 1.7415e-4;

export interface ThermalMaterial {
  id: string;
  name: string;
  density: number;
  specificHeat: number;
  conductivity: number;
  emissivity: number;
  /** Envelope temperature: exceeding it is a thermal-envelope failure. */
  maxTemperatureK: number;
  costPerKg: number;
  provenance: Provenance;
}

export interface ThermalParams {
  noseRadius: number;
  /** Nose cap area (m^2) for area-averaged conduction into the interior. */
  noseArea: number;
  /** Body (non-nose) protected area (m^2). */
  bodyArea: number;
  surfaceLayerThickness: number;
  backingThickness: number;
  noseMaterial: ThermalMaterial;
  /** Body TPS/skin areal heat capacity (J/(m^2 K)). */
  bodyArealHeatCapacity: number;
  bodyEmissivity: number;
  bodyMaxTemperatureK: number;
  /** Area-averaged body heating as a fraction of stagnation flux. */
  bodyHeatingFraction: number;
  /** Insulation conductance between outer structure and interior (W/(m^2 K)). */
  insulationConductance: number;
  /** Interior lumped heat capacity (J/K). */
  internalHeatCapacity: number;
  internalMaxTemperatureK: number;
  /** Radiative sink temperature (K); ignores solar and Earth IR. */
  sinkTemperatureK: number;
  /** Multiplier on the correlation (1 nominal; varied only by robustness experiments). */
  heatingMultiplier: number;
}

export const THERMAL_FLAG_LOW_SPEED = 1;
export const THERMAL_FLAG_RAREFIED = 2;

export interface HeatingSample {
  /** Cold-wall Sutton-Graves flux (W/m^2). */
  qColdWall: number;
  /** Stagnation flux applied to the surface node (W/m^2). */
  qStag: number;
  recoveryTemperature: number;
  flags: number;
}

/** Stagnation heating at wall temperature tWall. */
export function stagnationHeating(
  rho: number,
  vAir: number,
  noseRadius: number,
  airTemperature: number,
  speedOfSound: number,
  knudsen: number,
  tWall: number,
  out: HeatingSample,
): HeatingSample {
  const qcw = SUTTON_GRAVES_K * Math.sqrt(Math.max(rho, 0) / noseRadius) * vAir * vAir * vAir;
  // Stagnation (total) temperature with constant cp = 1005 J/(kg K).
  const tr = airTemperature + (vAir * vAir) / (2 * 1005);
  let q = qcw;
  if (tr > 300) {
    q *= Math.max(0, (tr - tWall) / (tr - 300));
  } else {
    q = 0;
  }
  let flags = 0;
  const mach = speedOfSound > 0 ? vAir / speedOfSound : 0;
  if (vAir < 2000 || mach < 4) flags |= THERMAL_FLAG_LOW_SPEED;
  const qFm = 0.5 * rho * vAir * vAir * vAir;
  if (knudsen > 0.01) flags |= THERMAL_FLAG_RAREFIED;
  if (q > qFm) q = qFm;
  out.qColdWall = Math.min(qcw, qFm);
  out.qStag = q;
  out.recoveryTemperature = tr;
  out.flags = flags;
  return out;
}

/** Node derivative dT/dt for the 4-node network; heat-flux arguments already evaluated per node. */
export function thermalDerivatives(
  p: ThermalParams,
  T: ArrayLike<number>,
  qSurface: number,
  qBody: number,
  attached: boolean,
  out: Float64Array,
  offset: number,
): void {
  const [t1, t2, t3, t4] = [T[0], T[1], T[2], T[3]];
  if (!attached) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 0;
    out[offset + 3] = 0;
    return;
  }
  const m = p.noseMaterial;
  const ts4 = p.sinkTemperatureK ** 4;
  const c1 = m.density * m.specificHeat * p.surfaceLayerThickness;
  const c2 = m.density * m.specificHeat * p.backingThickness;
  const g12 = m.conductivity / (0.5 * p.surfaceLayerThickness + 0.5 * p.backingThickness);
  const gi = p.insulationConductance;
  const rad1 = m.emissivity * SIGMA_SB * (t1 ** 4 - ts4);
  const rad3 = p.bodyEmissivity * SIGMA_SB * (t3 ** 4 - ts4);
  out[offset] = (qSurface - rad1 - g12 * (t1 - t2)) / c1;
  out[offset + 1] = (g12 * (t1 - t2) - gi * (t2 - t4)) / c2;
  out[offset + 2] = (qBody - rad3 - gi * (t3 - t4)) / p.bodyArealHeatCapacity;
  out[offset + 3] = (gi * p.noseArea * (t2 - t4) + gi * p.bodyArea * (t3 - t4)) / p.internalHeatCapacity;
}

export const THERMAL_PROVENANCE = prov(
  'engineering-approximation',
  ['R8'],
  'Sutton-Graves stagnation correlation (k = 1.7415e-4 SI) for hypersonic continuum flow over a spherical nose; enthalpy-difference hot-wall factor; free-molecular upper bound 0.5 rho V^3; 4-node lumped non-ablating network with re-radiation. Body heating fraction and insulation conductance are game-tunable approximations. Ablation is deferred.',
);
