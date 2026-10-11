/**
 * U.S. Standard Atmosphere 1976 (USSA76) [R6].
 *
 * 0-86 km (geometric): the seven-layer geopotential model with tabulated base
 * temperatures, lapse rates and pressures. The small molecular-weight
 * correction between 80 and 86 km (< 0.04 %) is neglected.
 *
 * 86-1000 km: kinetic temperature from the USSA76 analytic segments
 * (isothermal, elliptical, linear, exponential). Pressure and density are
 * log-linearly interpolated from values transcribed from USSA76 Table I
 * (geometric altitude). This is the explicit upper-atmosphere extension:
 * air never switches off at 100 km.
 *
 * Above 1000 km density is extrapolated exponentially with the 900-1000 km
 * scale height (a labelled extrapolation; the mean profile is not a forecast
 * of real thermospheric density, which varies with solar activity by factors
 * of several).
 */
import { GAMMA_AIR, M0_AIR, R0_GEOPOTENTIAL, R_STAR_USSA76, K_BOLTZMANN, AIR_MOLECULE_DIAMETER } from './constants';
import { prov } from './provenance';

export interface AtmosphereSample {
  /** Kinetic temperature, K. */
  temperature: number;
  /** Pressure, Pa. */
  pressure: number;
  /** Density, kg/m^3. */
  density: number;
  /** Speed of sound, m/s (gamma = 1.4 everywhere; approximate above 86 km). */
  speedOfSound: number;
  /** Mean free path, m. */
  meanFreePath: number;
}

export const ATMOSPHERE_PROVENANCE = prov(
  'published-reference',
  ['R6'],
  'USSA76 layers 0-86 km computed from the defining equations; 86-1000 km pressure/density transcribed from Table I and interpolated log-linearly; temperature from the USSA76 analytic segments. Above 1000 km: exponential extrapolation (engineering approximation).',
);

/** Lower atmosphere layers: geopotential base altitude (m), base temperature (K), lapse (K/m), base pressure (Pa). */
const LAYERS: ReadonlyArray<[number, number, number, number]> = [
  [0, 288.15, -0.0065, 101325.0],
  [11000, 216.65, 0.0, 22632.06],
  [20000, 216.65, 0.001, 5474.889],
  [32000, 228.65, 0.0028, 868.0187],
  [47000, 270.65, 0.0, 110.9063],
  [51000, 270.65, -0.0028, 66.93887],
  [71000, 214.65, -0.002, 3.95642],
];
/** Geopotential top of the lower model (= 86 km geometric). */
const H_TOP = 84852.0;
/** g0 * M0 / R* for the hydrostatic exponent (1/m units with K). */
const GMR = (9.80665 * M0_AIR) / R_STAR_USSA76;

/** USSA76 Table I upper atmosphere: geometric altitude (km), pressure (Pa), density (kg/m^3). */
export const UPPER_TABLE: ReadonlyArray<[number, number, number]> = [
  [86, 3.7338e-1, 6.958e-6],
  [90, 1.8359e-1, 3.416e-6],
  [100, 3.2011e-2, 5.604e-7],
  [110, 7.1042e-3, 9.708e-8],
  [120, 2.5381e-3, 2.222e-8],
  [130, 1.2505e-3, 8.152e-9],
  [140, 7.2028e-4, 3.831e-9],
  [150, 4.5422e-4, 2.076e-9],
  [160, 3.0395e-4, 1.233e-9],
  [180, 1.5181e-4, 5.194e-10],
  [200, 8.4736e-5, 2.541e-10],
  [250, 2.4767e-5, 6.073e-11],
  [300, 8.7704e-6, 1.916e-11],
  [350, 3.4518e-6, 7.014e-12],
  [400, 1.4518e-6, 2.803e-12],
  [450, 6.4468e-7, 1.184e-12],
  [500, 3.0236e-7, 5.215e-13],
  [600, 8.213e-8, 1.137e-13],
  [700, 3.1908e-8, 3.07e-14],
  [800, 1.7036e-8, 1.136e-14],
  [900, 1.0873e-8, 5.759e-15],
  [1000, 7.5138e-9, 3.561e-15],
];
const UPPER_LN = UPPER_TABLE.map(([z, p, r]) => [z * 1000, Math.log(p), Math.log(r)] as const);

export const geometricToGeopotential = (z: number): number => (R0_GEOPOTENTIAL * z) / (R0_GEOPOTENTIAL + z);
export const geopotentialToGeometric = (h: number): number => (R0_GEOPOTENTIAL * h) / (R0_GEOPOTENTIAL - h);

/** USSA76 kinetic temperature above 86 km (geometric z in m). */
export function upperTemperature(z: number): number {
  const zk = z / 1000;
  if (zk < 91) return 186.8673;
  if (zk < 110) {
    const tc = 263.1905, a = -76.3232, aa = -19.9429;
    const x = (zk - 91) / aa;
    return tc + a * Math.sqrt(Math.max(0, 1 - x * x));
  }
  if (zk < 120) return 240 + 12 * (zk - 110);
  const re = 6356.766;
  const xi = ((zk - 120) * (re + 120)) / (re + zk);
  return 1000 - (1000 - 360) * Math.exp(-0.01875 * xi);
}

function lowerAtmosphere(z: number): { T: number; P: number } {
  const h = geometricToGeopotential(z);
  let i = LAYERS.length - 1;
  while (i > 0 && h < LAYERS[i][0]) i--;
  const [hb, tb, lapse, pb] = LAYERS[i];
  const dh = h - hb;
  if (lapse === 0) {
    return { T: tb, P: pb * Math.exp((-GMR * dh) / tb) };
  }
  const T = tb + lapse * dh;
  return { T, P: pb * Math.pow(tb / T, GMR / lapse) };
}

function fillSample(out: AtmosphereSample, T: number, P: number, rho: number): AtmosphereSample {
  out.temperature = T;
  out.pressure = P;
  out.density = rho;
  // a = sqrt(gamma * P / rho) is equivalent to sqrt(gamma R T / M) and stays
  // consistent above 86 km where the mean molar mass varies.
  out.speedOfSound = Math.sqrt((GAMMA_AIR * P) / rho);
  out.meanFreePath = (K_BOLTZMANN * T) / (Math.SQRT2 * Math.PI * AIR_MOLECULE_DIAMETER * AIR_MOLECULE_DIAMETER * P);
  return out;
}

/** Minimum altitude accepted by the standard model (m). Below it values are clamped. */
export const ATMOSPHERE_MIN_ALTITUDE = -5000;

/** Standard (unperturbed) USSA76 at geometric altitude z (m). */
export function ussa76(z: number, out: AtmosphereSample = emptySample()): AtmosphereSample {
  if (z < ATMOSPHERE_MIN_ALTITUDE) z = ATMOSPHERE_MIN_ALTITUDE;
  if (geometricToGeopotential(z) <= H_TOP) {
    const { T, P } = lowerAtmosphere(z);
    const rho = (P * M0_AIR) / (R_STAR_USSA76 * T);
    return fillSample(out, T, P, rho);
  }
  const T = upperTemperature(z);
  const n = UPPER_LN.length;
  if (z <= UPPER_LN[n - 1][0]) {
    let i = 0;
    while (i < n - 2 && z > UPPER_LN[i + 1][0]) i++;
    const [z0, lp0, lr0] = UPPER_LN[i];
    const [z1, lp1, lr1] = UPPER_LN[i + 1];
    const f = (z - z0) / (z1 - z0);
    return fillSample(out, T, Math.exp(lp0 + f * (lp1 - lp0)), Math.exp(lr0 + f * (lr1 - lr0)));
  }
  // Exponential extrapolation above 1000 km with the last segment's scale heights.
  const [za, lpa, lra] = UPPER_LN[n - 2];
  const [zb, lpb, lrb] = UPPER_LN[n - 1];
  const dz = z - zb;
  const sp = (lpb - lpa) / (zb - za);
  const sr = (lrb - lra) / (zb - za);
  return fillSample(out, 1000, Math.exp(lpb + sp * dz), Math.exp(lrb + sr * dz));
}

export function emptySample(): AtmosphereSample {
  return { temperature: 0, pressure: 0, density: 0, speedOfSound: 0, meanFreePath: 0 };
}

/**
 * A configured atmosphere: either the standard profile, or a perturbed profile
 * tabulated once at configuration time from a seeded temperature offset
 * profile, integrated hydrostatically so pressure, temperature and density
 * stay mutually consistent. Lookups are deterministic in altitude only.
 */
export interface AtmosphereModel {
  sample(z: number, out: AtmosphereSample): AtmosphereSample;
  readonly perturbed: boolean;
  readonly description: string;
}

export const standardAtmosphere: AtmosphereModel = {
  sample: ussa76,
  perturbed: false,
  description: 'USSA76 mean profile (unperturbed)',
};

export interface AtmospherePerturbation {
  /** Surface pressure offset (fraction, e.g. 0.01 = +1 %). */
  surfacePressureFraction: number;
  /** Temperature offset at the surface (K). */
  surfaceTemperatureOffsetK: number;
  /** Altitude scale over which the temperature offset decays (m). */
  decayAltitudeM: number;
  /** Additional sinusoidal temperature structure amplitudes (K) and phases, from the seed. */
  waves: Array<{ amplitudeK: number; wavelengthM: number; phase: number }>;
  /** Relative density multiplier applied smoothly above 90 km (thermospheric variability). */
  thermosphereDensityFactor: number;
}

/**
 * Builds a perturbed atmosphere table from 0 to 90 km with 100 m spacing by
 * integrating dP/dz = -rho g with the perturbed temperature (g varies as
 * 1/r^2 consistent with geopotential altitude). Above 90 km the standard
 * profile is scaled by a smooth multiplier that is continuous at 90 km.
 */
export function buildPerturbedAtmosphere(p: AtmospherePerturbation): AtmosphereModel {
  const dz = 100;
  const zMin = ATMOSPHERE_MIN_ALTITUDE;
  const zMax = 90_000;
  const n = Math.round((zMax - zMin) / dz) + 1;
  const T = new Float64Array(n);
  const lnP = new Float64Array(n);
  const tmp = emptySample();
  const dT = (z: number): number => {
    let d = p.surfaceTemperatureOffsetK * Math.exp(-Math.max(0, z) / Math.max(1, p.decayAltitudeM));
    for (const w of p.waves) d += w.amplitudeK * Math.sin((2 * Math.PI * z) / w.wavelengthM + w.phase);
    return d;
  };
  const g = (z: number): number => 9.80665 * (R0_GEOPOTENTIAL / (R0_GEOPOTENTIAL + z)) ** 2;
  // Anchor at sea level with the perturbed surface pressure; integrate up and down.
  const i0 = Math.round((0 - zMin) / dz);
  const tAt = (z: number): number => Math.max(150, ussa76(z, tmp).temperature + dT(z));
  for (let i = 0; i < n; i++) T[i] = tAt(zMin + i * dz);
  lnP[i0] = Math.log(101325 * (1 + p.surfacePressureFraction));
  const rhs = (z: number): number => (-g(z) * M0_AIR) / (R_STAR_USSA76 * tAt(z)); // d lnP / dz
  for (let i = i0; i < n - 1; i++) {
    const z = zMin + i * dz;
    // RK4 on d lnP/dz (independent of lnP)
    lnP[i + 1] = lnP[i] + (dz / 6) * (rhs(z) + 4 * rhs(z + dz / 2) + rhs(z + dz));
  }
  for (let i = i0; i > 0; i--) {
    const z = zMin + i * dz;
    lnP[i - 1] = lnP[i] - (dz / 6) * (rhs(z) + 4 * rhs(z - dz / 2) + rhs(z - dz));
  }
  const std90 = ussa76(zMax, emptySample());
  const rho90 = Math.exp(lnP[n - 1]) * M0_AIR / (R_STAR_USSA76 * T[n - 1]);
  const ratioAt90 = rho90 / std90.density;
  const pRatioAt90 = Math.exp(lnP[n - 1]) / std90.pressure;
  return {
    perturbed: true,
    description: 'USSA76 with seeded hydrostatically consistent perturbation',
    sample(z: number, out: AtmosphereSample): AtmosphereSample {
      if (z < zMin) z = zMin;
      if (z <= zMax) {
        const x = (z - zMin) / dz;
        const i = Math.min(n - 2, Math.floor(x));
        const f = x - i;
        const t = T[i] + f * (T[i + 1] - T[i]);
        const pr = Math.exp(lnP[i] + f * (lnP[i + 1] - lnP[i]));
        return fillSample(out, t, pr, (pr * M0_AIR) / (R_STAR_USSA76 * t));
      }
      ussa76(z, out);
      // Blend from the value continuous at 90 km toward the thermospheric factor by 150 km.
      const w = Math.min(1, (z - zMax) / 60_000);
      const fr = ratioAt90 * (1 - w) + p.thermosphereDensityFactor * w;
      const fp = pRatioAt90 * (1 - w) + p.thermosphereDensityFactor * w;
      return fillSample(out, out.temperature, out.pressure * fp, out.density * fr);
    },
  };
}
