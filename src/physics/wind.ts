/**
 * Wind relative to the rotating Earth, as a deterministic function of
 * altitude. The mean profile is a piecewise-linear table of speed and
 * direction-from; optional seeded "structure" adds altitude-dependent
 * sinusoidal components whose phases are fixed by the weather seed.
 * Wind is never sampled per integration step.
 */
import { enuBasis, ecefToSpherical, eciToEcef, ecefToEci } from './frames';
import { prov } from './provenance';
import type { Vec3 } from './vec3';

export interface WindLayer {
  altitudeM: number;
  speedMps: number;
  /** Meteorological direction the wind blows FROM, degrees clockwise from north. */
  fromDeg: number;
}

export interface WindStructure {
  amplitudeMps: number;
  wavelengthM: number;
  phaseE: number;
  phaseN: number;
}

export interface WindModel {
  enabled: boolean;
  layers: WindLayer[];
  structure: WindStructure[];
}

export const WIND_PROVENANCE = prov(
  'engineering-approximation',
  [],
  'User-specified mean wind table with optional seeded altitude-periodic structure. Not a meteorological forecast. Wind is horizontal only.',
);

/** Wind in local ENU (m/s) at altitude z. */
export function windEnu(model: WindModel, z: number): [number, number] {
  if (!model.enabled || model.layers.length === 0) return [0, 0];
  const L = model.layers;
  let e: number, n: number;
  const toEN = (l: WindLayer): [number, number] => {
    const a = (l.fromDeg * Math.PI) / 180;
    // blowing FROM direction a => velocity points toward a + pi
    return [-l.speedMps * Math.sin(a), -l.speedMps * Math.cos(a)];
  };
  if (z <= L[0].altitudeM) [e, n] = toEN(L[0]);
  else if (z >= L[L.length - 1].altitudeM) [e, n] = toEN(L[L.length - 1]);
  else {
    let i = 0;
    while (i < L.length - 2 && z > L[i + 1].altitudeM) i++;
    const f = (z - L[i].altitudeM) / (L[i + 1].altitudeM - L[i].altitudeM);
    const a = toEN(L[i]);
    const b = toEN(L[i + 1]);
    e = a[0] + f * (b[0] - a[0]);
    n = a[1] + f * (b[1] - a[1]);
  }
  for (const s of model.structure) {
    const k = (2 * Math.PI * z) / s.wavelengthM;
    e += s.amplitudeMps * Math.sin(k + s.phaseE);
    n += s.amplitudeMps * Math.sin(k + s.phaseN);
  }
  return [e, n];
}

/**
 * Wind velocity relative to the Earth-fixed frame, expressed in ECI (m/s),
 * at ECI position r and time t.
 */
export function windEci(model: WindModel, r: Vec3, t: number, rotating: boolean): Vec3 {
  if (!model.enabled) return [0, 0, 0];
  const rf = eciToEcef(r, t, rotating);
  const { lat, lon, altitude } = ecefToSpherical(rf);
  const [we, wn] = windEnu(model, altitude);
  if (we === 0 && wn === 0) return [0, 0, 0];
  const b = enuBasis(lat, lon);
  const wEcef: Vec3 = [
    we * b.e[0] + wn * b.n[0],
    we * b.e[1] + wn * b.n[1],
    we * b.e[2] + wn * b.n[2],
  ];
  return ecefToEci(wEcef, t, rotating);
}
