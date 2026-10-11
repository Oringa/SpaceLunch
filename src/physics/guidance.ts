/**
 * Assisted guidance laws. They only choose a desired thrust DIRECTION; the
 * vehicle must still realise it with finite thrust, finite gimbal/RCS torque
 * and finite propellant. Nothing here rotates the velocity vector directly.
 *
 * assisted-insertion (apoapsis-rate steering): the pitch above the local
 * horizontal is chosen so the OSCULATING apoapsis approaches the target
 * altitude at a commanded rate:
 *     dh_apo/dt (desired) = (h_target - h_apo) / tau_a
 *     dh_apo/dt = grad_v(h_apo) . a_thrust(gamma)       (finite-difference gradient)
 * solved for gamma, taking the root nearest the horizon (most horizontal
 * acceleration), saturated by pitch limits. Once the apoapsis is at target
 * the vehicle burns as horizontally as possible while holding it, raising
 * the periapsis. The engine is cut off by an event when the osculating
 * periapsis reaches the cutoff altitude. This is a simple, honest assist, not
 * an optimal ascent: it reports failure when propulsion is insufficient, and
 * it never steers the velocity vector directly.
 */
import { MU_EARTH, R_EARTH } from './constants';
import { type Vec3, cross, dot, norm, normalize, scale, addScaled, clamp } from './vec3';

export type GuidanceMode = 'none' | 'assisted-insertion' | 'prograde' | 'pitch-program';

export interface GuidanceParams {
  mode: GuidanceMode;
  targetAltitude: number;
  cutoffPeriapsis: number;
  pitchProgram: Array<[number, number]>;
  /** Fallback horizontal direction when horizontal velocity is ~0 (ECI unit, launch plane). */
  fallbackHorizontal: Vec3;
}

export const GUIDANCE_GAINS = {
  /** Apoapsis convergence time constant (s). */
  tauA: 25,
  maxPitchUp: (70 * Math.PI) / 180,
  maxPitchDown: (-45 * Math.PI) / 180,
};

/** Osculating apoapsis altitude (m); Infinity when unbound. */
export function apoapsisAltitude(r: Vec3, v: Vec3): number {
  const rn = norm(r);
  const E = dot(v, v) / 2 - MU_EARTH / rn;
  if (E >= 0) return Infinity;
  const a = -MU_EARTH / (2 * E);
  const hm = norm(cross(r, v));
  const e = Math.sqrt(Math.max(0, 1 - (hm * hm) / (MU_EARTH * a)));
  return a * (1 + e) - R_EARTH;
}

/** Horizontal unit vector in the instantaneous plane of motion. */
export function horizontalDir(r: Vec3, v: Vec3, fallback: Vec3): Vec3 {
  const rh = normalize(r);
  const vh = addScaled(v, rh, -dot(v, rh));
  const n = norm(vh);
  if (n > 1) return scale(vh, 1 / n);
  const fh = addScaled(fallback, rh, -dot(fallback, rh));
  return normalize(fh);
}

/** Desired thrust direction (ECI unit vector). */
export function guidanceDirection(
  p: GuidanceParams,
  r: Vec3,
  v: Vec3,
  thrustAccel: number,
  timeSinceIgnition: number,
): Vec3 {
  const rn = norm(r);
  const rh = scale(r, 1 / rn);
  const hd = horizontalDir(r, v, p.fallbackHorizontal);
  switch (p.mode) {
    case 'prograde':
      return normalize(v);
    case 'pitch-program': {
      const prog = p.pitchProgram;
      let pitchDeg = prog.length ? prog[prog.length - 1][1] : 0;
      if (prog.length && timeSinceIgnition <= prog[0][0]) pitchDeg = prog[0][1];
      else {
        for (let i = 0; i < prog.length - 1; i++) {
          if (timeSinceIgnition >= prog[i][0] && timeSinceIgnition <= prog[i + 1][0]) {
            const f = (timeSinceIgnition - prog[i][0]) / (prog[i + 1][0] - prog[i][0]);
            pitchDeg = prog[i][1] + f * (prog[i + 1][1] - prog[i][1]);
            break;
          }
        }
      }
      const g = (pitchDeg * Math.PI) / 180;
      return normalize(addScaled(scale(hd, Math.cos(g)), rh, Math.sin(g)));
    }
    case 'assisted-insertion': {
      const G = GUIDANCE_GAINS;
      const hApo = apoapsisAltitude(r, v);
      if (!Number.isFinite(hApo)) return normalize(addScaled(scale(hd, Math.cos(G.maxPitchDown)), rh, Math.sin(G.maxPitchDown)));
      // Finite-difference gradient of apoapsis w.r.t. velocity along h and r.
      const dv = 0.5;
      const gH = (apoapsisAltitude(r, addScaled(v, hd, dv)) - hApo) / dv;
      const gR = (apoapsisAltitude(r, addScaled(v, rh, dv)) - hApo) / dv;
      const aT = Math.max(thrustAccel, 1e-6);
      const A = gH * aT, B = gR * aT;
      const C = (p.targetAltitude - hApo) / G.tauA;
      const Rm = Math.hypot(A, B);
      const phi = Math.atan2(B, A);
      let g: number;
      if (!Number.isFinite(Rm) || Rm < 1e-9) g = 0;
      else if (C >= Rm) g = phi;
      else if (C <= -Rm) g = phi + Math.PI;
      else {
        const d = Math.acos(C / Rm);
        const g1 = wrapAngle(phi + d), g2 = wrapAngle(phi - d);
        g = Math.abs(g1) < Math.abs(g2) ? g1 : g2;
      }
      g = clamp(wrapAngle(g), G.maxPitchDown, G.maxPitchUp);
      return normalize(addScaled(scale(hd, Math.cos(g)), rh, Math.sin(g)));
    }
    default:
      return normalize(v);
  }
}

/** Orbit-normal unit vector (for building a roll reference). */
export function orbitNormal(r: Vec3, v: Vec3): Vec3 {
  const h = cross(r, v);
  const n = norm(h);
  return n > 0 ? scale(h, 1 / n) : [0, 0, 1];
}

/** Attitude-autopilot gains (rate-command, torque-limited). */
export const AUTOPILOT = {
  kp: 1.2, // (rad/s) per rad of pointing error
  maxRate: 0.6, // rad/s commanded slew rate
  tauRate: 0.15, // s rate-loop time constant
  rollTau: 0.5, // s roll-rate damping time constant
};

function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}
