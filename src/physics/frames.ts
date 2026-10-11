/**
 * Frames.
 *  ECI  : Earth-centred inertial. Aligned with ECEF at simulation time t = 0.
 *  ECEF : Earth-centred, Earth-fixed; rotates about +Z at OMEGA_EARTH.
 *  ENU  : local East/North/Up at a point on the spherical Earth.
 *
 * The ECI solver never adds Coriolis or centrifugal terms; those appear only
 * when a quantity is transformed into the rotating frame.
 */
import { OMEGA_EARTH, R_EARTH } from './constants';
import { type Vec3, cross, norm, rotZ } from './vec3';

export interface Enu {
  e: Vec3;
  n: Vec3;
  u: Vec3;
}

/** Earth rotation angle at time t (rad). */
export const earthAngle = (t: number, rotating = true): number => (rotating ? OMEGA_EARTH * t : 0);

export const ecefToEci = (r: Vec3, t: number, rotating = true): Vec3 => rotZ(r, earthAngle(t, rotating));
export const eciToEcef = (r: Vec3, t: number, rotating = true): Vec3 => rotZ(r, -earthAngle(t, rotating));

/** Earth angular-velocity vector in ECI. */
export const earthOmegaVec = (rotating = true): Vec3 => [0, 0, rotating ? OMEGA_EARTH : 0];

/** Position on the declared spherical Earth from geocentric latitude/longitude (rad). */
export function sphericalToEcef(lat: number, lon: number, altitude: number): Vec3 {
  const r = R_EARTH + altitude;
  const cl = Math.cos(lat);
  return [r * cl * Math.cos(lon), r * cl * Math.sin(lon), r * Math.sin(lat)];
}

export function ecefToSpherical(r: Vec3): { lat: number; lon: number; altitude: number } {
  const rn = norm(r);
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, r[2] / rn))),
    lon: Math.atan2(r[1], r[0]),
    altitude: rn - R_EARTH,
  };
}

/** ENU basis (in ECEF) at geocentric lat/lon. */
export function enuBasis(lat: number, lon: number): Enu {
  const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon);
  return {
    e: [-so, co, 0],
    n: [-sl * co, -sl * so, cl],
    u: [cl * co, cl * so, sl],
  };
}

/** Velocity of the Earth-fixed atmosphere at inertial position r (m/s, ECI). */
export const corotationVelocity = (r: Vec3, rotating = true): Vec3 => cross(earthOmegaVec(rotating), r);

/** Great-circle ground distance between two ECEF positions on the sphere (m). */
export function groundDistance(a: Vec3, b: Vec3): number {
  const c = cross(a, b);
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return R_EARTH * Math.atan2(norm(c), d);
}
