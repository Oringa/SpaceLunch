/**
 * Osculating two-body orbital elements from an inertial state [R9].
 * Robust for radial, nearly circular, parabolic and hyperbolic trajectories:
 * no NaNs; unbound trajectories report infinite apoapsis and period.
 */
import { MU_EARTH, R_EARTH } from './constants';
import { type Vec3, cross, dot, norm, scale, sub, normalize } from './vec3';

export type OrbitKind = 'radial' | 'circular' | 'elliptic' | 'parabolic' | 'hyperbolic';

export interface OrbitElements {
  specificEnergy: number;
  hVector: Vec3;
  angularMomentum: number;
  eVector: Vec3;
  eccentricity: number;
  /** Semi-latus rectum p = h^2/mu (m). */
  semiLatusRectum: number;
  /** Semi-major axis (m); Infinity for parabolic; negative for hyperbolic. */
  semiMajorAxis: number;
  periapsisRadius: number;
  periapsisAltitude: number;
  /** Infinity when unbound. */
  apoapsisRadius: number;
  apoapsisAltitude: number;
  /** Infinity when unbound. */
  period: number;
  /** Inclination (rad), or null when the orbit plane is undefined (radial motion). */
  inclination: number | null;
  /** True anomaly (rad) or null when undefined (circular/radial). */
  trueAnomaly: number | null;
  bound: boolean;
  kind: OrbitKind;
  /** True when the osculating conic passes below the spherical surface. */
  intersectsEarth: boolean;
  /** Radial velocity sign: +1 ascending, -1 descending. */
  radialVelocity: number;
}

const EPS_CIRC = 1e-9;

export function orbitalElements(r: Vec3, v: Vec3, mu = MU_EARTH): OrbitElements {
  const rn = norm(r);
  const vn2 = dot(v, v);
  const E = vn2 / 2 - mu / rn;
  const hv = cross(r, v);
  const h = norm(hv);
  const ev = sub(scale(cross(v, hv), 1 / mu), scale(r, 1 / rn));
  let e = norm(ev);
  const p = (h * h) / mu;
  const vr = dot(r, v) / rn;
  // Radial: angular momentum negligible relative to r*v.
  const radial = h < 1e-10 * rn * Math.sqrt(vn2) + 1e-9;
  const scaleE = mu / rn;
  const parabolic = Math.abs(E) < 1e-12 * scaleE;
  let kind: OrbitKind;
  let a: number;
  let rp: number;
  let ra: number;
  let period: number;
  if (radial) {
    kind = 'radial';
    e = 1;
    rp = 0;
    if (E < 0 && !parabolic) {
      a = -mu / (2 * E);
      ra = 2 * a;
      period = 2 * Math.PI * Math.sqrt((a * a * a) / mu);
    } else {
      a = parabolic ? Infinity : -mu / (2 * E);
      ra = Infinity;
      period = Infinity;
    }
  } else if (parabolic) {
    kind = 'parabolic';
    a = Infinity;
    rp = p / 2;
    ra = Infinity;
    period = Infinity;
  } else if (E < 0) {
    a = -mu / (2 * E);
    rp = p / (1 + e);
    // r_a from energy avoids the 0/0 of p/(1-e) as e -> 1.
    ra = 2 * a - rp;
    period = 2 * Math.PI * Math.sqrt((a * a * a) / mu);
    kind = e < EPS_CIRC * 1e3 ? 'circular' : 'elliptic';
  } else {
    kind = 'hyperbolic';
    a = -mu / (2 * E);
    rp = p / (1 + e);
    ra = Infinity;
    period = Infinity;
  }
  const inclination = radial || h === 0 ? null : Math.acos(Math.max(-1, Math.min(1, hv[2] / h)));
  let nu: number | null = null;
  if (!radial && e > 1e-10) {
    const c = dot(ev, r) / (e * rn);
    nu = Math.acos(Math.max(-1, Math.min(1, c)));
    if (vr < 0) nu = 2 * Math.PI - nu;
  }
  return {
    specificEnergy: E,
    hVector: hv,
    angularMomentum: h,
    eVector: ev,
    eccentricity: e,
    semiLatusRectum: p,
    semiMajorAxis: a,
    periapsisRadius: rp,
    periapsisAltitude: rp - R_EARTH,
    apoapsisRadius: ra,
    apoapsisAltitude: ra === Infinity ? Infinity : ra - R_EARTH,
    period,
    inclination,
    trueAnomaly: nu,
    bound: E < 0 && !parabolic,
    kind,
    intersectsEarth: rp < R_EARTH,
    radialVelocity: vr >= 0 ? 1 : -1,
  };
}

/** Circular orbit speed at radius r. */
export const circularSpeed = (r: number, mu = MU_EARTH): number => Math.sqrt(mu / r);

/**
 * Sample the osculating conic in the inertial frame from the current true
 * anomaly forward. Stops at Earth's surface when the conic intersects it, or
 * after one revolution (bound) / at a radius cap (unbound). Returns points in
 * metres. Purely geometric display aid (gravity-only).
 */
export function conicSamples(
  r: Vec3,
  v: Vec3,
  n = 256,
  rCap = 6 * R_EARTH,
  mu = MU_EARTH,
): { points: Vec3[]; hitsEarth: boolean } {
  const el = orbitalElements(r, v, mu);
  const rn = norm(r);
  if (el.kind === 'radial') {
    // Straight line in/out along r.
    const u = normalize(r);
    const points: Vec3[] = [];
    const rMax = el.bound ? Math.min(el.apoapsisRadius, rCap) : rCap;
    const steps = n;
    if (el.radialVelocity > 0) {
      for (let i = 0; i <= steps; i++) points.push(scale(u, rn + ((rMax - rn) * i) / steps));
      for (let i = 0; i <= steps; i++) points.push(scale(u, rMax - ((rMax - R_EARTH) * i) / steps));
    } else {
      for (let i = 0; i <= steps; i++) points.push(scale(u, rn - ((rn - R_EARTH) * i) / steps));
    }
    return { points, hitsEarth: true };
  }
  const hHat = normalize(el.hVector);
  // In-plane basis: P toward periapsis (or r for circular), Q = h x P.
  const P = el.eccentricity > 1e-10 ? normalize(el.eVector) : normalize(r);
  const Q = cross(hHat, P);
  const nu0 = el.trueAnomaly ?? 0;
  const e = el.eccentricity;
  const p = el.semiLatusRectum;
  let nuEnd = nu0 + 2 * Math.PI;
  if (!el.bound) {
    // Asymptote limit
    const nuInf = e > 1 ? Math.acos(-1 / e) : Math.PI;
    const target = Math.min(rCap, 1e12);
    const cosNu = (p / target - 1) / e;
    const nuCap = Math.min(nuInf * 0.999, Math.acos(Math.max(-1, Math.min(1, cosNu))));
    const start = nu0 > Math.PI ? nu0 - 2 * Math.PI : nu0;
    nuEnd = Math.max(start, nuCap);
    return sweep(start, nuEnd);
  }
  return sweep(nu0, nuEnd);

  function sweep(a: number, b: number): { points: Vec3[]; hitsEarth: boolean } {
    const points: Vec3[] = [];
    let hitsEarth = false;
    for (let i = 0; i <= n; i++) {
      const nu = a + ((b - a) * i) / n;
      const rr = p / (1 + e * Math.cos(nu));
      if (!(rr > 0) || rr > rCap * 4) break;
      const pt: Vec3 = [
        rr * (Math.cos(nu) * P[0] + Math.sin(nu) * Q[0]),
        rr * (Math.cos(nu) * P[1] + Math.sin(nu) * Q[1]),
        rr * (Math.cos(nu) * P[2] + Math.sin(nu) * Q[2]),
      ];
      if (rr < R_EARTH && i > 0) {
        hitsEarth = true;
        // Place the final point on the surface.
        points.push(scale(normalize(pt), R_EARTH));
        break;
      }
      points.push(pt);
    }
    return { points, hitsEarth };
  }
}
