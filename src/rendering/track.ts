/**
 * Polyline for trajectories (fat lines, pixel width, optional dashes).
 *
 * Points are cached in double precision in the view's physical frame; the
 * Float32 segment buffer holds scale * B (p - origin). When the source table
 * grows only the new segments are projected and uploaded (pre-allocated
 * buffer, instanceCount as draw range). When the projection changes (origin
 * rebase, basis change) the whole buffer is re-projected from the doubles.
 */
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { TelemetryTable } from '../sim/telemetry';
import type { Vec3 } from '../physics/vec3';
import type { Projection } from './projection';

/** Writes frame coordinates of rows [from, to) into out (3 per row). */
export type RowMapper = (table: TelemetryTable, from: number, to: number, out: Float64Array) => void;

export interface TrackOptions {
  color: THREE.ColorRepresentation;
  width: number;
  dashed?: boolean;
  opacity?: number;
  renderOrder?: number;
  depthTest?: boolean;
}

const _v = new THREE.Vector3();

export class Track {
  readonly object: LineSegments2;
  readonly material: LineMaterial;
  private geom: LineSegmentsGeometry;
  private seg = new Float32Array(0);
  private dist = new Float32Array(0);
  private segBuf!: THREE.InstancedInterleavedBuffer;
  private distBuf!: THREE.InstancedInterleavedBuffer;
  private cap = 0;
  /** Frame coordinates (double). */
  private pts = new Float64Array(0);
  private n = 0;
  private scratch = new Float64Array(3 * 256);
  private table: TelemetryTable | null = null;
  private projVersion = -1;
  private proj: Projection | null = null;
  private prevScene = new THREE.Vector3();
  private cum = 0;
  /** First segment awaiting upload (-1: none, 0: whole buffer). */
  private dirtyFrom = -1;
  private halo: LineSegments2 | null = null;
  private haloMat: LineMaterial | null = null;

  constructor(opts: TrackOptions) {
    this.material = new LineMaterial({
      color: new THREE.Color(opts.color).getHex(),
      linewidth: opts.width,
      dashed: !!opts.dashed,
      dashSize: 1,
      gapSize: 0.6,
      dashScale: 1,
      transparent: (opts.opacity ?? 1) < 1,
      opacity: opts.opacity ?? 1,
      worldUnits: false,
      depthTest: opts.depthTest ?? true,
    });
    this.geom = new LineSegmentsGeometry();
    this.object = new LineSegments2(this.geom, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = opts.renderOrder ?? 0;
    this.allocate(256);
  }

  get pointCount(): number {
    return this.n;
  }

  /** Frame coordinates of point i (copy). */
  point(i: number): Vec3 {
    return [this.pts[3 * i], this.pts[3 * i + 1], this.pts[3 * i + 2]];
  }

  setResolution(w: number, h: number): void {
    this.material.resolution.set(w, h);
    this.haloMat?.resolution.set(w, h);
  }

  /**
   * Soft additive halo drawn with the same geometry (cheap glow, no
   * post-processing). A stencil test lets each pixel receive the halo once, so
   * overlapping segments (dense telemetry rows) never accumulate into a solid
   * band. Needs a stencil buffer (SceneManager enables it).
   */
  setHalo(on: boolean, width = 9, opacity = 0.2): void {
    if (on && !this.halo) {
      this.haloMat = new LineMaterial({
        color: this.material.color.getHex(),
        linewidth: width,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        worldUnits: false,
        stencilWrite: true,
        stencilRef: 1,
        stencilFunc: THREE.NotEqualStencilFunc,
        stencilZPass: THREE.ReplaceStencilOp,
      });
      this.haloMat.resolution.copy(this.material.resolution);
      this.halo = new LineSegments2(this.geom, this.haloMat);
      this.halo.frustumCulled = false;
      this.halo.renderOrder = this.object.renderOrder - 1;
      this.object.add(this.halo);
    }
    if (this.halo) this.halo.visible = on;
  }

  /** Dash pattern in scene units (callers scale it with camera distance). */
  setDash(dash: number, gap: number): void {
    this.material.dashSize = dash;
    this.material.gapSize = gap;
  }

  private allocate(segCap: number): void {
    const seg = new Float32Array(segCap * 6);
    const dist = new Float32Array(segCap * 2);
    const nSeg = Math.max(0, this.n - 1);
    if (this.seg.length) {
      seg.set(this.seg.subarray(0, nSeg * 6));
      dist.set(this.dist.subarray(0, nSeg * 2));
    }
    this.seg = seg;
    this.dist = dist;
    this.cap = segCap;
    const old = this.geom;
    const g = new LineSegmentsGeometry();
    this.segBuf = new THREE.InstancedInterleavedBuffer(seg, 6, 1);
    this.distBuf = new THREE.InstancedInterleavedBuffer(dist, 2, 1);
    this.segBuf.setUsage(THREE.DynamicDrawUsage);
    this.distBuf.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('instanceStart', new THREE.InterleavedBufferAttribute(this.segBuf, 3, 0));
    g.setAttribute('instanceEnd', new THREE.InterleavedBufferAttribute(this.segBuf, 3, 3));
    g.setAttribute('instanceDistanceStart', new THREE.InterleavedBufferAttribute(this.distBuf, 1, 0));
    g.setAttribute('instanceDistanceEnd', new THREE.InterleavedBufferAttribute(this.distBuf, 1, 1));
    g.instanceCount = nSeg;
    this.segBuf.onUpload(() => {
      this.dirtyFrom = -1;
    });
    this.dirtyFrom = 0;
    this.geom = g;
    this.object.geometry = g;
    if (this.halo) this.halo.geometry = g;
    if (old !== g) old.dispose();
  }

  private ensurePoints(nPts: number): void {
    if (this.pts.length < nPts * 3) {
      const p = new Float64Array(Math.max(nPts * 3, this.pts.length * 2, 768));
      p.set(this.pts.subarray(0, this.n * 3));
      this.pts = p;
    }
    if (nPts - 1 > this.cap) {
      let c = this.cap;
      while (c < nPts - 1) c *= 2;
      this.allocate(c);
    }
  }

  clear(): void {
    this.n = 0;
    this.cum = 0;
    this.table = null;
    this.geom.instanceCount = 0;
  }

  /**
   * Follow a (possibly growing) telemetry table. Re-reads from scratch if the
   * table object changed or shrank; re-projects everything if the projection
   * changed. `limit` caps the number of rows used (e.g. ascent-only framing).
   */
  syncTable(table: TelemetryTable | null, map: RowMapper, proj: Projection, limit = Infinity): void {
    if (!table || table.length === 0) {
      if (this.n) this.clear();
      this.table = table;
      return;
    }
    const want = Math.min(table.length, limit);
    if (table !== this.table || want < this.n) {
      this.n = 0;
      this.cum = 0;
      this.table = table;
    }
    const projChanged = proj !== this.proj || proj.version !== this.projVersion;
    if (want > this.n) {
      const from = this.n;
      this.ensurePoints(want);
      for (let i = from; i < want; i += 256) {
        const j = Math.min(want, i + 256);
        map(table, i, j, this.scratch);
        // Guard non-finite samples by repeating the previous point.
        for (let k = 0; k < (j - i) * 3; k++) {
          const v = this.scratch[k];
          this.pts[i * 3 + k] = Number.isFinite(v) ? v : i * 3 + k >= 3 ? this.pts[i * 3 + k - 3] : 0;
        }
      }
      this.n = want;
      if (!projChanged) this.projectRange(from, proj);
    }
    if (projChanged) this.projectAll(proj);
  }

  /** Replace the points (frame coordinates). */
  setPoints(points: ArrayLike<Vec3>, proj: Projection): void {
    this.table = null;
    this.n = 0;
    this.ensurePoints(points.length);
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      this.pts[3 * i] = p[0];
      this.pts[3 * i + 1] = p[1];
      this.pts[3 * i + 2] = p[2];
    }
    this.n = points.length;
    this.projectAll(proj);
  }

  /** Re-project if the projection changed since the last write. */
  reproject(proj: Projection): void {
    if (proj !== this.proj || proj.version !== this.projVersion) this.projectAll(proj);
  }

  private projectAll(proj: Projection): void {
    this.proj = proj;
    this.projVersion = proj.version;
    this.cum = 0;
    this.projectRange(0, proj);
  }

  /** Project points from index `from` on (segments from - 1 ...). */
  private projectRange(from: number, proj: Projection): void {
    const n = this.n;
    if (n < 2) {
      this.geom.instanceCount = 0;
      if (n === 1) {
        proj.toScene(this.pts[0], this.pts[1], this.pts[2], this.prevScene);
        this.cum = 0;
      }
      return;
    }
    const start = Math.max(1, from);
    if (start === 1) {
      proj.toScene(this.pts[0], this.pts[1], this.pts[2], this.prevScene);
      this.cum = 0;
    }
    const seg = this.seg, dist = this.dist, prev = this.prevScene;
    for (let i = start; i < n; i++) {
      proj.toScene(this.pts[3 * i], this.pts[3 * i + 1], this.pts[3 * i + 2], _v);
      const s = (i - 1) * 6;
      seg[s] = prev.x;
      seg[s + 1] = prev.y;
      seg[s + 2] = prev.z;
      seg[s + 3] = _v.x;
      seg[s + 4] = _v.y;
      seg[s + 5] = _v.z;
      const d0 = this.cum;
      this.cum += prev.distanceTo(_v);
      dist[(i - 1) * 2] = d0;
      dist[(i - 1) * 2 + 1] = this.cum;
      prev.copy(_v);
    }
    this.geom.instanceCount = n - 1;
    this.markDirty(start - 1);
  }

  /** Record that segments from `firstSeg` on must be uploaded (merged until the next upload). */
  private markDirty(firstSeg: number): void {
    this.dirtyFrom = this.dirtyFrom < 0 ? firstSeg : Math.min(this.dirtyFrom, firstSeg);
    const nSeg = Math.max(0, this.n - 1);
    this.segBuf.clearUpdateRanges();
    this.distBuf.clearUpdateRanges();
    if (this.dirtyFrom > 0 && nSeg > this.dirtyFrom) {
      this.segBuf.addUpdateRange(this.dirtyFrom * 6, (nSeg - this.dirtyFrom) * 6);
      this.distBuf.addUpdateRange(this.dirtyFrom * 2, (nSeg - this.dirtyFrom) * 2);
    }
    this.segBuf.needsUpdate = true;
    this.distBuf.needsUpdate = true;
  }

  dispose(): void {
    this.geom.dispose();
    this.material.dispose();
    this.haloMat?.dispose();
  }
}
