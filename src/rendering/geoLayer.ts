/**
 * Real geography on the 3D Earth: coastlines and country borders (and, up
 * close, US state lines) as thin lines a little above the surface, plus an equirectangular land mask for the
 * Earth shader's land tint (earth.ts). Data: the embedded Natural Earth map
 * (src/data/geo, a lazy chunk shared with the 2D map); lat/lon are geocentric
 * on the simulation's spherical Earth, exactly like sphericalToEcef.
 *
 * Vertices are ECEF metres on R_EARTH (Float32, ~1 m precision, like the
 * Earth mesh); views place the group with their Projection (camera-relative,
 * double-precision placement) exactly as they place the Earth, so the lines
 * are Earth-fixed and turn with the Earth. The vertex shader lifts each
 * vertex above the surface (and onto the launch-site plateau of the site cap
 * so nothing is buried there) and fades lines near the limb and far from the
 * camera, so dense coastlines never turn into noise at the horizon.
 *
 * The typed arrays and the land mask are built once per page (~60k
 * vertices); each view owns its GPU objects and disposes them.
 */
import * as THREE from 'three';
import { R_EARTH } from '../physics/constants';
import type { Vec3 } from '../physics/vec3';
import { loadWorld, type Line, type World } from '../data/geo/geo';
import { CAP_RADIUS, setEarthLand } from './earth';

/** Longest great-circle step between line vertices (deg): chords then sag < 10 m below the arc. */
const MAX_STEP_DEG = 0.25;
const LAND_W = 2048;
const LAND_H = 1024;

interface LineArrays {
  pos: Float32Array;
  index: Uint32Array;
}

export interface GeoData {
  coasts: LineArrays;
  borders: LineArrays;
  /** First-level subdivisions where the map has them (US states); faint, close range only. */
  states: LineArrays;
  /** Land mask (255 = land), equirectangular, one byte per texel, row 0 = south, lon -180 at the left edge. */
  land: { data: Uint8Array; w: number; h: number } | null;
}

const D2R = Math.PI / 180;
/** Longitude on the +-180 meridian (rings are unwrapped, so any multiple of 360 away). */
const onAntimeridian = (lon: number): boolean => Math.abs((((lon + 180) % 360) + 360) % 360 - 180) >= 179.99;

/**
 * Merge polylines into indexed segment pairs on the sphere, subdividing long
 * steps along the great circle; points closer than `minStepDeg` to the last
 * kept one are dropped (coarser copies for views that never zoom in close).
 */
function buildLines(lines: Line[], skipCuts: boolean, minStepDeg = 0): LineArrays {
  const pos: number[] = [];
  const index: number[] = [];
  const unit = (lon: number, lat: number, out: number[]): void => {
    const cl = Math.cos(lat * D2R);
    out[0] = cl * Math.cos(lon * D2R);
    out[1] = cl * Math.sin(lon * D2R);
    out[2] = Math.sin(lat * D2R);
  };
  const a = [0, 0, 0], b = [0, 0, 0];
  const push = (x: number, y: number, z: number): number => {
    const n = Math.hypot(x, y, z) || 1;
    pos.push((x / n) * R_EARTH, (y / n) * R_EARTH, (z / n) * R_EARTH);
    return pos.length / 3 - 1;
  };
  for (const L of lines) {
    const p = L.pts;
    let prev = -1;
    let lon0 = 0, lat0 = 0;
    for (let i = 0; i + 1 < p.length; i += 2) {
      const lon = p[i], lat = p[i + 1];
      if (prev < 0) {
        unit(lon, lat, a);
        prev = push(a[0], a[1], a[2]);
        lon0 = lon, lat0 = lat;
        continue;
      }
      if (minStepDeg > 0 && i + 2 < p.length && Math.hypot((lon - lon0) * Math.cos(lat * D2R), lat - lat0) < minStepDeg) continue;
      // Polygon edges that only exist because the data is cut at the antimeridian or the pole.
      const cut = skipCuts && ((onAntimeridian(lon) && onAntimeridian(lon0)) || (lat <= -89.99 && lat0 <= -89.99));
      const jump = Math.abs(lon - lon0) > 180;
      unit(lon, lat, b);
      lon0 = lon, lat0 = lat;
      if (cut || jump) {
        a[0] = b[0], a[1] = b[1], a[2] = b[2];
        prev = push(b[0], b[1], b[2]);
        continue;
      }
      const ang = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / D2R;
      const steps = Math.max(1, Math.ceil(ang / MAX_STEP_DEG));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const v = push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
        index.push(prev, v);
        prev = v;
      }
      a[0] = b[0], a[1] = b[1], a[2] = b[2];
    }
  }
  return { pos: Float32Array.from(pos), index: Uint32Array.from(index) };
}

/** Rasterise land polygons (holes and lakes cut out) into an equirectangular single-channel mask. */
function rasterLand(w: World): { data: Uint8Array; w: number; h: number } | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = LAND_W;
  c.height = LAND_H;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#000';
  g.fillRect(0, 0, LAND_W, LAND_H);
  const X = (lon: number): number => ((lon + 180) / 360) * LAND_W;
  const Y = (lat: number): number => ((90 - lat) / 180) * LAND_H;
  const ring = (r: Line, off: number): void => {
    const p = r.pts;
    for (let i = 0; i + 1 < p.length; i += 2) {
      if (i === 0) g.moveTo(X(p[i] + off), Y(p[i + 1]));
      else g.lineTo(X(p[i] + off), Y(p[i + 1]));
    }
    g.closePath();
  };
  // Rings may run past +-180 after unwrapping: draw each polygon at -360, 0 and +360.
  for (const [polys, color] of [[w.land, '#fff'], [w.lakes.map((l) => [l.ring]), '#000']] as const) {
    g.fillStyle = color;
    for (const poly of polys) {
      const o = poly[0];
      if (!o) continue;
      for (const off of [-360, 0, 360]) {
        if (o.maxLon + off < -180 || o.minLon + off > 180) continue;
        g.beginPath();
        for (const r of poly) ring(r, off);
        g.fill('evenodd');
      }
    }
  }
  const rgba = g.getImageData(0, 0, LAND_W, LAND_H).data;
  const data = new Uint8Array(LAND_W * LAND_H);
  for (let y = 0; y < LAND_H; y++) {
    const src = y * LAND_W * 4, dst = (LAND_H - 1 - y) * LAND_W;
    for (let x = 0; x < LAND_W; x++) data[dst + x] = rgba[src + 4 * x];
  }
  return { data, w: LAND_W, h: LAND_H };
}

let landMask: GeoData['land'] | undefined;
const pending = new Map<number, Promise<GeoData | null>>();
/**
 * Geometry arrays (decimated to `minStepDeg`) and the land mask, built once
 * per page from the embedded map; null if it cannot load.
 */
export function loadGeoData(minStepDeg = 0): Promise<GeoData | null> {
  let p = pending.get(minStepDeg);
  if (!p) {
    p = loadWorld()
      .then((w): GeoData => {
        const fromLand = !(w.coasts && w.coasts.length);
        const coastLines = fromLand ? w.land.map((poly) => poly[0]).filter((r): r is Line => !!r) : w.coasts;
        if (landMask === undefined) landMask = rasterLand(w);
        return {
          coasts: buildLines(coastLines, fromLand, minStepDeg),
          borders: buildLines(w.borders, false, minStepDeg),
          states: buildLines(w.states ?? [], false, minStepDeg),
          land: landMask,
        };
      })
      .catch((e: unknown) => {
        console.warn('[renderer] map data unavailable; Earth drawn without coastlines.', e);
        return null;
      });
    pending.set(minStepDeg, p);
  }
  return p;
}

const LINE_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 uSiteDir;
uniform float uPlateau;
uniform float uCapR;
uniform float uLift;
uniform vec2 uFade;
varying float vFade;
void main() {
  vec3 n = normalize(position);
  // Ride on the site cap's plateau (same easing as createSiteCap), plus a small lift.
  float s = 2.0 * asin(clamp(length(n - uSiteDir) * 0.5, 0.0, 1.0)) * ${R_EARTH.toFixed(1)};
  float x = clamp((s / uCapR - 0.25) / 0.75, 0.0, 1.0);
  float alt = uPlateau * (1.0 - x * x * (3.0 - 2.0 * x)) + uLift;
  vec4 mv = modelViewMatrix * vec4(position + n * alt, 1.0);
  vec3 nv = normalize(normalMatrix * n);
  float facing = dot(nv, normalize(-mv.xyz));
  float dist = length(mv.xyz);
  vFade = smoothstep(0.02, 0.3, facing) * (1.0 - smoothstep(uFade.x, uFade.y, dist));
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
  // Far hemisphere / fully faded: move the vertex beyond the far plane so the segment is clipped
  // before rasterisation (both ends always fade together: steps are < 0.25 deg, alpha is 0 near the limb).
  if (facing < 0.0 || dist > uFade.y) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}
`;

const LINE_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(uColor, uOpacity * vFade);
  #include <colorspace_fragment>
}
`;

function lineMaterial(color: string, opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: LINE_VERT,
    fragmentShader: LINE_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uSiteDir: { value: new THREE.Vector3(1, 0, 0) },
      uPlateau: { value: 0 },
      uCapR: { value: CAP_RADIUS },
      uLift: { value: 50 },
      uFade: { value: new THREE.Vector2(1e9, 2e9) },
    },
    transparent: true,
    depthWrite: false,
  });
}

/** Coastlines + borders for one view, and the land tint of that view's Earth material(s). */
export class GeoLayer {
  /** Place like the Earth mesh: vertices are ECEF metres. */
  readonly group = new THREE.Group();
  private readonly coastMat = lineMaterial('#8fb6dc', 0.85);
  private readonly borderMat = lineMaterial('#f2d89b', 0.8);
  private readonly stateMat = lineMaterial('#c9b88f', 0.3);
  private landTex: THREE.DataTexture | null = null;
  private disposed = false;
  private ready = false;

  /** `minStepDeg`: line decimation for views that never zoom in close (0 = full map resolution). */
  constructor(private readonly earthMats: THREE.ShaderMaterial[], minStepDeg = 0) {
    this.group.visible = false;
    void loadGeoData(minStepDeg).then((d) => this.attach(d));
  }

  get loaded(): boolean {
    return this.ready;
  }

  private attach(d: GeoData | null): void {
    if (this.disposed || !d) return;
    for (const [arr, mat, order] of [[d.coasts, this.coastMat, 2], [d.borders, this.borderMat, 1], [d.states, this.stateMat, 0]] as const) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(arr.pos, 3));
      g.setIndex(new THREE.BufferAttribute(arr.index, 1));
      const l = new THREE.LineSegments(g, mat);
      l.frustumCulled = false;
      l.renderOrder = order;
      this.group.add(l);
    }
    if (d.land) {
      const t = new THREE.DataTexture(d.land.data, d.land.w, d.land.h, THREE.RedFormat, THREE.UnsignedByteType);
      t.colorSpace = THREE.NoColorSpace;
      t.wrapS = THREE.RepeatWrapping;
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      this.landTex = t;
      for (const m of this.earthMats) setEarthLand(m, t);
    }
    this.group.visible = true;
    this.ready = true;
  }

  /** Launch site (unit ECEF) and its plateau altitude: lines ride on the site cap. */
  setSite(dir: Vec3, plateauAlt: number): void {
    for (const m of [this.coastMat, this.borderMat, this.stateMat]) {
      (m.uniforms.uSiteDir.value as THREE.Vector3).set(dir[0], dir[1], dir[2]);
      m.uniforms.uPlateau.value = plateauAlt;
    }
  }

  /**
   * Per frame: `camAltM` = camera altitude above the surface (m), `unitsPerM` =
   * scene units per metre. Lines are lifted a little more from afar (depth
   * resolution) and fade out beyond a few camera altitudes (dense coastlines
   * compressed towards the horizon); borders recede at globe scale.
   */
  update(camAltM: number, unitsPerM: number, borders = true): void {
    if (!this.ready) return;
    const h = Math.max(camAltM, 1_000);
    const lift = Math.min(3_000, Math.max(30, h * 2e-5));
    const near = (6 * h + 300_000) * unitsPerM, far = (18 * h + 900_000) * unitsPerM;
    const k = Math.min(1, Math.max(0, (Math.log10(h) - 5.5) / 1.3)); // 0 below ~300 km, 1 from ~6,000 km
    for (const m of [this.coastMat, this.borderMat, this.stateMat]) {
      m.uniforms.uLift.value = lift;
      (m.uniforms.uFade.value as THREE.Vector2).set(near, far);
    }
    this.coastMat.uniforms.uOpacity.value = 0.9 - 0.2 * k;
    this.borderMat.uniforms.uOpacity.value = 0.85 - 0.35 * k;
    // State lines only below ~2,500 km camera altitude, fading in as the camera comes closer.
    const ks = Math.min(1, Math.max(0, (6.4 - Math.log10(h)) / 0.6));
    this.stateMat.uniforms.uOpacity.value = 0.32 * ks;
    const b = this.group.children[1], st = this.group.children[2];
    if (b) b.visible = borders;
    if (st) st.visible = borders && ks > 0.01;
  }

  dispose(): void {
    this.disposed = true;
    for (const c of this.group.children) (c as THREE.LineSegments).geometry.dispose();
    this.group.clear();
    this.coastMat.dispose();
    this.borderMat.dispose();
    this.stateMat.dispose();
    this.landTex?.dispose();
    for (const m of this.earthMats) if (m.uniforms.uLand.value === this.landTex) setEarthLand(m, null);
    this.landTex = null;
  }
}
