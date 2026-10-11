/**
 * Launcher geometry: a rotor turning in a vertical plane that contains the
 * launch azimuth, inside a disc-shaped vacuum chamber, with a straight exit
 * tunnel tangent to the vehicle circle at the release point.
 *
 * Rotor-plane basis at the hub (ECEF): h = horizontal launch direction,
 * u = local up, a = u x h (rotor axis). Vehicle CoM at rotor phase phi:
 *     r_rel = R (cos(phi) h - sin(phi) u)
 *     v_rel = omega R (-sin(phi) h - cos(phi) u)     (phi increases with time)
 * The velocity direction equals the commanded elevation e at
 *     phi_release = 3 pi / 2 - e,
 * which is where the exit port is cut. Changing elevation moves the port.
 */
import { R_EARTH } from './constants';
import { enuBasis, sphericalToEcef } from './frames';
import { type Vec3, add, addScaled, cross, dot, norm, scale, sub } from './vec3';

export interface LauncherGeometry {
  lat: number;
  lon: number;
  siteAltitude: number;
  hubHeight: number;
  hubEcef: Vec3;
  h: Vec3;
  u: Vec3;
  a: Vec3;
  armRadius: number;
  chamberRadius: number;
  chamberDepth: number;
  elevation: number;
  azimuth: number;
  phiRelease: number;
  tunnelOrigin: Vec3;
  tunnelDir: Vec3;
  sWall: number;
  sEnd: number;
  apertureRadius: number;
}

export function buildLauncherGeometry(p: {
  latDeg: number;
  lonDeg: number;
  siteAltitude: number;
  azimuthDeg: number;
  elevationDeg: number;
  armRadius: number;
  chamberRadius: number;
  chamberDepth: number;
  apertureRadius: number;
  tunnelLength: number;
}): LauncherGeometry {
  const lat = (p.latDeg * Math.PI) / 180;
  const lon = (p.lonDeg * Math.PI) / 180;
  const az = (p.azimuthDeg * Math.PI) / 180;
  const el = (p.elevationDeg * Math.PI) / 180;
  const enu = enuBasis(lat, lon);
  const h: Vec3 = add(scale(enu.n, Math.cos(az)), scale(enu.e, Math.sin(az)));
  const u = enu.u;
  const a = cross(u, h);
  const hubHeight = p.chamberRadius + 1.0;
  const hubEcef = sphericalToEcef(lat, lon, p.siteAltitude + hubHeight);
  const phiRelease = 1.5 * Math.PI - el;
  const R = p.armRadius;
  const tunnelOrigin = add(hubEcef, radialAt(h, u, phiRelease, R));
  const tunnelDir = tangentAt(h, u, phiRelease);
  const sWall = Math.sqrt(Math.max(0, p.chamberRadius * p.chamberRadius - R * R));
  return {
    lat, lon, siteAltitude: p.siteAltitude, hubHeight, hubEcef, h, u, a,
    armRadius: R, chamberRadius: p.chamberRadius, chamberDepth: p.chamberDepth,
    elevation: el, azimuth: az, phiRelease, tunnelOrigin, tunnelDir,
    sWall, sEnd: sWall + p.tunnelLength, apertureRadius: p.apertureRadius,
  };
}

export const radialUnit = (h: Vec3, u: Vec3, phi: number): Vec3 => sub(scale(h, Math.cos(phi)), scale(u, Math.sin(phi)));
export const tangentAt = (h: Vec3, u: Vec3, phi: number): Vec3 => sub(scale(h, -Math.sin(phi)), scale(u, Math.cos(phi)));
const radialAt = (h: Vec3, u: Vec3, phi: number, R: number): Vec3 => scale(radialUnit(h, u, phi), R);

/** Vehicle CoM position (ECEF) at rotor phase phi. */
export function vehiclePositionEcef(g: LauncherGeometry, phi: number): Vec3 {
  return add(g.hubEcef, radialAt(g.h, g.u, phi, g.armRadius));
}

/** Vehicle CoM velocity relative to the ground (ECEF) at phase phi and rate omega. */
export function vehicleVelocityEcef(g: LauncherGeometry, phi: number, omega: number): Vec3 {
  return scale(tangentAt(g.h, g.u, phi), omega * g.armRadius);
}

/** Point in launcher (tunnel) coordinates: s along the tunnel axis, d distance from it. */
export function tunnelCoords(g: LauncherGeometry, pEcef: Vec3): { s: number; d: number } {
  const rel = sub(pEcef, g.tunnelOrigin);
  const s = dot(rel, g.tunnelDir);
  const d = norm(addScaled(rel, g.tunnelDir, -s));
  return { s, d };
}

/**
 * Clearance (m) between a capsule (segment nose-tail, radius envelope) and the
 * exit tunnel wall over the part of the capsule that lies inside the tunnel's
 * axial extent [sWall, sEnd]. Distance from a line is convex along a segment,
 * so its maximum over the clipped segment lies at a clipped endpoint.
 * Returns +Infinity when no part of the capsule is in the tunnel.
 */
export function corridorClearance(g: LauncherGeometry, noseEcef: Vec3, tailEcef: Vec3, envelopeRadius: number): number {
  const n = tunnelCoords(g, noseEcef);
  const t = tunnelCoords(g, tailEcef);
  const lo = g.sWall, hi = g.sEnd;
  const sMin = Math.min(n.s, t.s), sMax = Math.max(n.s, t.s);
  if (sMax < lo || sMin > hi) return Infinity;
  // Clip parameter range along the segment tail -> nose.
  const ds = n.s - t.s;
  const evalAt = (u: number): number => {
    const p = add(tailEcef, scale(sub(noseEcef, tailEcef), u));
    return tunnelCoords(g, p).d;
  };
  let u0 = 0, u1 = 1;
  if (Math.abs(ds) > 1e-12) {
    const ua = (lo - t.s) / ds;
    const ub = (hi - t.s) / ds;
    u0 = Math.max(0, Math.min(ua, ub));
    u1 = Math.min(1, Math.max(ua, ub));
  }
  const dMax = Math.max(evalAt(u0), evalAt(u1));
  return g.apertureRadius - envelopeRadius - dMax;
}

/** Altitude of an ECEF point above the spherical surface. */
export const altitudeOf = (p: Vec3): number => norm(p) - R_EARTH;

/** Small-angle release direction error for a timing error dt at rotor rate omega (rad). */
export const releaseDirectionError = (omega: number, dt: number): number => omega * dt;
