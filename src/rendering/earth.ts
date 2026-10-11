/**
 * Procedural Earth (no textures): dark-blue sphere with an analytic
 * latitude/longitude graticule computed per fragment, so lines stay crisp at
 * every zoom level, plus a finely tessellated spherical cap around the launch
 * site (a coarse sphere's facets sag by ~100 m, which would bury or float the
 * site at range scale) and translucent fresnel shells for atmosphere layers.
 *
 * Mesh-local coordinates are ECEF metres; the views place meshes with their
 * Projection (camera-relative, double-precision placement).
 */
import * as THREE from 'three';
import { R_EARTH } from '../physics/constants';
import { type Vec3, cross, normalize } from '../physics/vec3';

const EARTH_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 dir;
varying vec3 vDir;
varying vec3 vNormalV;
varying vec3 vViewPos;
void main() {
  vDir = dir;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  vNormalV = normalize(normalMatrix * dir);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const EARTH_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uMinor;
uniform float uMajor;
uniform float uRimStrength;
uniform vec3 uBase;
uniform vec3 uMinorColor;
uniform vec3 uMajorColor;
uniform vec3 uRim;
uniform vec3 uLight;
varying vec3 vDir;
varying vec3 vNormalV;
varying vec3 vViewPos;

float lineMask(float coord, float spacing, float fwCoord, float widthPx) {
  float v = coord / spacing;
  float fw = max(fwCoord / spacing, 1e-6);
  float d = abs(fract(v + 0.5) - 0.5) / fw;
  float m = 1.0 - smoothstep(widthPx * 0.5, widthPx * 0.5 + 1.0, d);
  // Fade when lines get denser than ~4 px apart.
  return m * (1.0 - smoothstep(0.12, 0.3, fw));
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 d = normalize(vDir);
  float lat = degrees(asin(clamp(d.z, -1.0, 1.0)));
  float lon = degrees(atan(d.y, d.x));
  float lon2 = mod(lon + 360.0, 360.0);
  float fwLat = fwidth(lat);
  float fwLon = min(fwidth(lon), fwidth(lon2));
  // Longitude spacing shrinks with cos(lat); keep line density sane near poles.
  float minorM = max(lineMask(lat, uMinor, fwLat, 1.0), lineMask(lon, uMinor, fwLon, 1.0));
  float majorM = max(lineMask(lat, uMajor, fwLat, 1.3), lineMask(lon, uMajor, fwLon, 1.3));
  float eq = lineMask(lat + 90.0, 180.0, fwLat, 1.8);
  vec3 n = normalize(vNormalV);
  vec3 v = normalize(-vViewPos);
  float ndl = max(dot(n, normalize(uLight)), 0.0);
  vec3 col = uBase * (0.6 + 0.6 * ndl);
  col = mix(col, uMinorColor, minorM * 0.45);
  col = mix(col, uMajorColor, max(majorM, eq) * 0.7);
  float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 4.0);
  col += uRim * rim * uRimStrength;
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const SHELL_VERT = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vNormalV;
varying vec3 vViewPos;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  vNormalV = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * mv;
  #include <logdepthbuf_vertex>
}
`;

const SHELL_FRAG = /* glsl */ `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uColor;
uniform float uStrength;
varying vec3 vNormalV;
varying vec3 vViewPos;
void main() {
  #include <logdepthbuf_fragment>
  vec3 n = normalize(vNormalV);
  vec3 v = normalize(-vViewPos);
  float g = 1.0 - abs(dot(n, v));
  float a = uStrength * (0.03 + 0.97 * pow(g, 5.0));
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
`;

export function createEarthMaterial(rimStrength = 0.35): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: EARTH_VERT,
    fragmentShader: EARTH_FRAG,
    uniforms: {
      uMinor: { value: 10 },
      uMajor: { value: 30 },
      uRimStrength: { value: rimStrength },
      uBase: { value: new THREE.Color('#0c233b') },
      uMinorColor: { value: new THREE.Color('#1f4566') },
      uMajorColor: { value: new THREE.Color('#3f7099') },
      uRim: { value: new THREE.Color('#3d7fc4') },
      uLight: { value: new THREE.Vector3(-0.35, 0.55, 0.75) },
    },
  });
}

/**
 * Graticule spacing (degrees) for a camera `distM` metres from the surface it
 * looks at: minor cells of roughly half that distance, 1-2-5 steps.
 */
export function setGraticule(mat: THREE.ShaderMaterial, distM: number): void {
  const deg = (Math.max(distM, 1) / 111_000) * 0.5;
  const p = Math.pow(10, Math.floor(Math.log10(deg)));
  const m = deg / p;
  const mant = m >= 5 ? 5 : m >= 2 ? 2 : 1;
  let minor = mant * p, major = mant === 5 ? minor * 6 : 10 * p;
  if (minor > 10) (minor = 10), (major = 30);
  if (minor < 1e-4) (minor = 1e-4), (major = 1e-3);
  mat.uniforms.uMinor.value = minor;
  mat.uniforms.uMajor.value = Math.min(major, 30);
}

/** Sphere of radius r with poles on local +Z (ECEF axes) and a `dir` attribute. */
export function createEarthGeometry(r: number, wSeg = 512, hSeg = 256): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(r, wSeg, hSeg);
  g.rotateX(Math.PI / 2);
  addDirAttribute(g);
  return g;
}

function addDirAttribute(g: THREE.BufferGeometry): void {
  const pos = g.getAttribute('position');
  const dir = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = Math.hypot(x, y, z) || 1;
    dir[3 * i] = x / n;
    dir[3 * i + 1] = y / n;
    dir[3 * i + 2] = z / n;
  }
  g.setAttribute('dir', new THREE.BufferAttribute(dir, 3));
}

/**
 * Exact spherical cap around `centerDir` (unit, ECEF), vertices in metres
 * relative to the anchor point R_EARTH * centerDir. The surface rises
 * smoothly to `plateauAlt` near the centre (the site's elevation above the
 * spherical datum) and returns to the datum at the rim.
 */
export function createSiteCap(centerDir: Vec3, plateauAlt: number, capRadius = 400_000, rings = 72, segs = 120): THREE.BufferGeometry {
  const up = normalize(centerDir);
  const ref: Vec3 = Math.abs(up[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = normalize(cross(ref, up));
  const e2 = cross(up, e1);
  const anchor: Vec3 = [up[0] * R_EARTH, up[1] * R_EARTH, up[2] * R_EARTH];
  const s0 = 5;
  const radii = [0];
  for (let k = 0; k <= rings; k++) radii.push(s0 * Math.pow(capRadius / s0, k / rings));
  const nv = 1 + (radii.length - 1) * segs;
  const pos = new Float32Array(nv * 3);
  const dir = new Float32Array(nv * 3);
  const put = (idx: number, d: Vec3, alt: number): void => {
    const r = R_EARTH + alt;
    pos[3 * idx] = d[0] * r - anchor[0];
    pos[3 * idx + 1] = d[1] * r - anchor[1];
    pos[3 * idx + 2] = d[2] * r - anchor[2];
    dir[3 * idx] = d[0];
    dir[3 * idx + 1] = d[1];
    dir[3 * idx + 2] = d[2];
  };
  const altAt = (s: number): number => {
    const x = Math.min(1, Math.max(0, (s / capRadius - 0.25) / 0.75));
    return plateauAlt * (1 - x * x * (3 - 2 * x));
  };
  put(0, up, altAt(0));
  let idx = 1;
  for (let k = 1; k < radii.length; k++) {
    const th = radii[k] / R_EARTH;
    const c = Math.cos(th), s = Math.sin(th);
    for (let j = 0; j < segs; j++) {
      const a = (2 * Math.PI * j) / segs;
      const ca = Math.cos(a), sa = Math.sin(a);
      const d: Vec3 = [
        c * up[0] + s * (ca * e1[0] + sa * e2[0]),
        c * up[1] + s * (ca * e1[1] + sa * e2[1]),
        c * up[2] + s * (ca * e1[2] + sa * e2[2]),
      ];
      put(idx++, d, altAt(radii[k]));
    }
  }
  const index: number[] = [];
  for (let j = 0; j < segs; j++) index.push(0, 1 + j, 1 + ((j + 1) % segs));
  for (let k = 1; k < radii.length - 1; k++) {
    const a0 = 1 + (k - 1) * segs, b0 = 1 + k * segs;
    for (let j = 0; j < segs; j++) {
      const j1 = (j + 1) % segs;
      index.push(a0 + j, b0 + j, b0 + j1, a0 + j, b0 + j1, a0 + j1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('dir', new THREE.BufferAttribute(dir, 3));
  g.setIndex(index);
  return g;
}

export function createShellMaterial(color: THREE.ColorRepresentation, strength: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    uniforms: { uColor: { value: new THREE.Color(color) }, uStrength: { value: strength } },
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}

/** Earth surface radius at the cap anchor (datum) for a site direction. */
export const capAnchor = (centerDir: Vec3): Vec3 => {
  const u = normalize(centerDir);
  return [u[0] * R_EARTH, u[1] * R_EARTH, u[2] * R_EARTH];
};
