/**
 * Minimal double-precision 3-vector helpers. Vectors are plain tuples so the
 * kernel can run in workers and tests without any rendering library.
 */
export type Vec3 = [number, number, number];

export const v3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
export const norm2 = (a: Vec3): number => a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
export const normalize = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n > 0 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
};
export const neg = (a: Vec3): Vec3 => [-a[0], -a[1], -a[2]];
export const dist = (a: Vec3, b: Vec3): number => norm(sub(a, b));

/** Rotate a vector about +Z by angle (right-handed). */
export const rotZ = (a: Vec3, ang: number): Vec3 => {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return [c * a[0] - s * a[1], s * a[0] + c * a[1], a[2]];
};

/** Component of a perpendicular to unit vector u. */
export const perp = (a: Vec3, u: Vec3): Vec3 => addScaled(a, u, -dot(a, u));

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Angle between two vectors in [0, pi], robust near 0 and pi. */
export const angleBetween = (a: Vec3, b: Vec3): number => Math.atan2(norm(cross(a, b)), dot(a, b));
