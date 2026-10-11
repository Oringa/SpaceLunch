/**
 * Camera-relative rendering support.
 *
 * Every view keeps its geometry in a double-precision physical frame (metres;
 * launcher-local, ECEF or ECI). A Projection maps a frame point p to scene
 * coordinates as  scale * B (p - origin),  computed in JS doubles; only the
 * result is written to Float32 attributes. The render origin is rebased when
 * the camera target moves far from it, so vertices near the camera always
 * carry sub-millimetre precision whatever the absolute distance from Earth's
 * centre. `version` changes whenever the mapping does, telling geometry
 * caches to re-project.
 */
import * as THREE from 'three';
import type { Vec3 } from '../physics/vec3';
import { OMEGA_EARTH } from '../physics/constants';
import type { TelemetryTable } from '../sim/telemetry';

export class Projection {
  readonly origin: Vec3 = [0, 0, 0];
  /** Rows of the frame -> scene rotation (scene X, Y, Z axes expressed in the frame). */
  bx: Vec3 = [1, 0, 0];
  by: Vec3 = [0, 1, 0];
  bz: Vec3 = [0, 0, 1];
  scale = 1;
  version = 0;

  setBasis(bx: Vec3, by: Vec3, bz: Vec3): void {
    this.bx = [...bx];
    this.by = [...by];
    this.bz = [...bz];
    this.version++;
  }

  setOrigin(o: Vec3): void {
    this.origin[0] = o[0];
    this.origin[1] = o[1];
    this.origin[2] = o[2];
    this.version++;
  }

  setScale(s: number): void {
    this.scale = s;
    this.version++;
  }

  /** Frame point (metres) -> scene coordinates. */
  toScene(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const dx = x - this.origin[0], dy = y - this.origin[1], dz = z - this.origin[2];
    const s = this.scale, a = this.bx, b = this.by, c = this.bz;
    return out.set(
      s * (a[0] * dx + a[1] * dy + a[2] * dz),
      s * (b[0] * dx + b[1] * dy + b[2] * dz),
      s * (c[0] * dx + c[1] * dy + c[2] * dz),
    );
  }

  toSceneV(p: Vec3, out: THREE.Vector3): THREE.Vector3 {
    return this.toScene(p[0], p[1], p[2], out);
  }

  /** Frame direction -> scene direction (rotation only, unscaled). */
  dirToScene(v: Vec3, out: THREE.Vector3): THREE.Vector3 {
    const a = this.bx, b = this.by, c = this.bz;
    return out.set(a[0] * v[0] + a[1] * v[1] + a[2] * v[2], b[0] * v[0] + b[1] * v[1] + b[2] * v[2], c[0] * v[0] + c[1] * v[1] + c[2] * v[2]);
  }

  /** Scene direction -> frame direction (inverse rotation). */
  dirToFrame(v: THREE.Vector3): Vec3 {
    const a = this.bx, b = this.by, c = this.bz;
    return [a[0] * v.x + b[0] * v.y + c[0] * v.z, a[1] * v.x + b[1] * v.y + c[1] * v.z, a[2] * v.x + b[2] * v.y + c[2] * v.z];
  }

  /** Quaternion rotating frame axes into scene axes (for meshes built in frame coordinates). */
  quaternion(out: THREE.Quaternion): THREE.Quaternion {
    const a = this.bx, b = this.by, c = this.bz;
    _m.set(a[0], a[1], a[2], 0, b[0], b[1], b[2], 0, c[0], c[1], c[2], 0, 0, 0, 0, 1);
    return out.setFromRotationMatrix(_m);
  }

  /**
   * Place a mesh whose vertices are in frame metres relative to `anchor` and
   * whose local axes are frame axes, optionally pre-rotated by `pre`.
   */
  place(obj: THREE.Object3D, anchor: Vec3, pre?: THREE.Quaternion): void {
    this.toSceneV(anchor, obj.position);
    this.quaternion(obj.quaternion);
    if (pre) obj.quaternion.multiply(pre);
    obj.scale.setScalar(this.scale);
  }
}

const _m = new THREE.Matrix4();

/** ECI -> ECEF rotation for each telemetry row (each sample uses its own t). */
export function eciRowsToEcef(table: TelemetryTable, from: number, to: number, rotating: boolean, out: Float64Array): void {
  const t = table.col('t'), x = table.col('x'), y = table.col('y'), z = table.col('z');
  for (let i = from, k = 0; i < to; i++, k += 3) {
    const ang = rotating ? -OMEGA_EARTH * t[i] : 0;
    const c = Math.cos(ang), s = Math.sin(ang);
    out[k] = c * x[i] - s * y[i];
    out[k + 1] = s * x[i] + c * y[i];
    out[k + 2] = z[i];
  }
}

/** Raw ECI rows. */
export function eciRows(table: TelemetryTable, from: number, to: number, out: Float64Array): void {
  const x = table.col('x'), y = table.col('y'), z = table.col('z');
  for (let i = from, k = 0; i < to; i++, k += 3) {
    out[k] = x[i];
    out[k + 1] = y[i];
    out[k + 2] = z[i];
  }
}

/** True when a table carries the channels a trajectory line needs. */
export const hasTrajectory = (t: TelemetryTable | null | undefined): t is TelemetryTable =>
  !!t && t.length > 0 && 'x' in t.index && 'y' in t.index && 'z' in t.index && 't' in t.index;

/** Pixels per scene unit at distance `dist` for a perspective camera of height `heightPx`. */
export function pxPerUnit(camera: THREE.PerspectiveCamera, dist: number, heightPx: number): number {
  return heightPx / 2 / (Math.max(dist, 1e-9) * Math.tan((camera.fov * Math.PI) / 360));
}

/** Dispose every geometry/material/texture below `root`. */
export function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = (m as { material?: THREE.Material | THREE.Material[] }).material;
    if (mat) {
      for (const mm of Array.isArray(mat) ? mat : [mat]) {
        for (const v of Object.values(mm)) if (v instanceof THREE.Texture) v.dispose();
        mm.dispose();
      }
    }
    if ((o as { isCSS2DObject?: boolean }).isCSS2DObject) (o as unknown as { element: HTMLElement }).element.remove();
  });
}
