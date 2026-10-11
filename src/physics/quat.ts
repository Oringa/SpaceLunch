/**
 * Quaternion convention (verified in tests/attitude.test.ts):
 *  - Stored as [w, x, y, z], Hamilton product, unit norm.
 *  - q maps BODY-frame vectors to INERTIAL-frame vectors:
 *        v_inertial = q (x) [0, v_body] (x) conj(q)
 *  - Kinematics with body angular velocity omega_b:
 *        qdot = 0.5 * q (x) [0, omega_b]
 */
import type { Vec3 } from './vec3';

export type Quat = [number, number, number, number];

export const qIdentity = (): Quat => [1, 0, 0, 0];

export const qMul = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];

export const qConj = (q: Quat): Quat => [q[0], -q[1], -q[2], -q[3]];

export const qNorm = (q: Quat): number => Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);

export const qNormalize = (q: Quat): Quat => {
  const n = qNorm(q);
  return n > 0 ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : [1, 0, 0, 0];
};

/** Rotate body vector into inertial frame. */
export function qRotate(q: Quat, v: Vec3): Vec3 {
  const [w, x, y, z] = q;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** Rotate inertial vector into body frame. */
export function qRotateInv(q: Quat, v: Vec3): Vec3 {
  return qRotate([q[0], -q[1], -q[2], -q[3]], v);
}

/** Quaternion from rotation axis (unit) and angle. */
export function qFromAxisAngle(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}

/**
 * Quaternion from body axes expressed in the inertial frame
 * (columns of the body->inertial rotation matrix).
 */
export function qFromBasis(xb: Vec3, yb: Vec3, zb: Vec3): Quat {
  const m00 = xb[0], m01 = yb[0], m02 = zb[0];
  const m10 = xb[1], m11 = yb[1], m12 = zb[1];
  const m20 = xb[2], m21 = yb[2], m22 = zb[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
  }
  return qNormalize(q);
}

/** Time derivative of q given body angular velocity. */
export function qDot(q: Quat, w: Vec3): Quat {
  return [
    0.5 * (-q[1] * w[0] - q[2] * w[1] - q[3] * w[2]),
    0.5 * (q[0] * w[0] + q[2] * w[2] - q[3] * w[1]),
    0.5 * (q[0] * w[1] + q[3] * w[0] - q[1] * w[2]),
    0.5 * (q[0] * w[2] + q[1] * w[1] - q[2] * w[0]),
  ];
}
