/**
 * Common view plumbing: per-frame context, the View contract that
 * SceneManager drives, and small shared scene helpers (screen-size markers,
 * lights).
 */
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Snapshot } from '../sim/session';
import type { Scenario } from '../sim/build';
import type { TelemetryTable } from '../sim/telemetry';
import type { Overlays, RenderSource } from './types';

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export const NO_INSETS: Insets = { top: 0, bottom: 0, left: 0, right: 0 };

export interface FrameContext {
  source: RenderSource;
  /** UI-occluded margins (CSS px). */
  insets: Insets;
  variant: 'engineer' | 'play';
  /** Mission goal altitude (m) or null. */
  goalAltitude: number | null;
  snap: Snapshot | null;
  scenario: Scenario | null;
  flown: TelemetryTable | null;
  predicted: TelemetryTable | null;
  overlays: Overlays;
  reducedMotion: boolean;
  /** Viewport size in CSS pixels. */
  width: number;
  height: number;
  /** Wall-clock seconds (monotonic) and the frame interval. */
  wall: number;
  dtWall: number;
}

export interface View {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  activate(): void;
  deactivate(): void;
  update(ctx: FrameContext): void;
  resize(w: number, h: number): void;
  resetCamera(ctx: FrameContext): void;
  /** Optional picture-in-picture: camera + viewport in CSS px (origin bottom-left). */
  inset?(): { camera: THREE.Camera; x: number; y: number; w: number; h: number } | null;
  dispose(): void;
}

/** Layer for main-camera-only helpers (arrows, screen markers) hidden from insets. */
export const MAIN_ONLY_LAYER = 1;

/** Constant-pixel-size dot(s) (Points, no attenuation). */
export function makeDot(color: THREE.ColorRepresentation, sizePx: number, n = 1): THREE.Points {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3 * n), 3));
  const tex = dotTexture();
  const m = new THREE.PointsMaterial({ color, size: sizePx, sizeAttenuation: false, map: tex, transparent: true, alphaTest: 0.05, depthWrite: false });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  return p;
}

let _dotCanvas: HTMLCanvasElement | null = null;
function dotTexture(): THREE.Texture {
  if (!_dotCanvas) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (g) {
      g.clearRect(0, 0, 64, 64);
      g.beginPath();
      g.arc(32, 32, 24, 0, Math.PI * 2);
      g.fillStyle = '#ffffff';
      g.fill();
      g.lineWidth = 6;
      g.strokeStyle = 'rgba(13,17,23,0.9)';
      g.stroke();
    }
    _dotCanvas = c;
  }
  const t = new THREE.CanvasTexture(_dotCanvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Ring-shaped marker texture (hollow), for cursor/vehicle highlights. */
export function makeRing(color: THREE.ColorRepresentation, sizePx: number): THREE.Points {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    g.beginPath();
    g.arc(32, 32, 26, 0, Math.PI * 2);
    g.lineWidth = 6;
    g.strokeStyle = '#ffffff';
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  const m = new THREE.PointsMaterial({ color, size: sizePx, sizeAttenuation: false, map: tex, transparent: true, depthWrite: false, depthTest: false });
  const p = new THREE.Points(geo, m);
  p.frustumCulled = false;
  p.renderOrder = 10;
  return p;
}

export function setDot(p: THREE.Points, v: THREE.Vector3, i = 0): void {
  const a = p.geometry.getAttribute('position') as THREE.BufferAttribute;
  a.setXYZ(i, v.x, v.y, v.z);
  a.needsUpdate = true;
}

export interface Lights {
  hemi: THREE.HemisphereLight;
  key: THREE.DirectionalLight;
}

export function addLights(scene: THREE.Scene, dir: THREE.Vector3 = new THREE.Vector3(0.4, 0.8, 0.6)): Lights {
  const hemi = new THREE.HemisphereLight(0xc8d8ff, 0x1a1f26, 1.1);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.9);
  key.position.copy(dir);
  scene.add(key);
  return { hemi, key };
}

/** Neutral instrument lighting, or a warmer key / cooler fill for the 'play' presentation. */
export function styleLights(l: Lights, variant: 'engineer' | 'play'): void {
  if (variant === 'play') {
    l.key.color.set('#ffe0bd');
    l.key.intensity = 2.3;
    l.hemi.color.set('#9fb8ff');
    l.hemi.intensity = 0.9;
  } else {
    l.key.color.set('#ffffff');
    l.key.intensity = 1.9;
    l.hemi.color.set('#c8d8ff');
    l.hemi.intensity = 1.1;
  }
}

/**
 * Put the camera's principal point (where the orbit target projects) at the
 * centre of the region not covered by UI insets, optionally shifted by
 * (dx, dy) CSS px (y down). Cheap: only the projection matrix changes.
 */
export function applyFraming(camera: THREE.PerspectiveCamera, w: number, h: number, insets: Insets, dx = 0, dy = 0): void {
  const cx = insets.left + (w - insets.left - insets.right) / 2 - w / 2 + dx;
  const cy = insets.top + (h - insets.top - insets.bottom) / 2 - h / 2 + dy;
  const v = camera.view;
  if (Math.abs(cx) < 0.5 && Math.abs(cy) < 0.5) {
    if (v && v.enabled) camera.clearViewOffset();
    return;
  }
  if (v && v.enabled && v.fullWidth === w && v.fullHeight === h && Math.abs(v.offsetX + cx) < 0.25 && Math.abs(v.offsetY + cy) < 0.25) return;
  camera.setViewOffset(w, h, -cx, -cy, w, h);
}

/** Fraction of the viewport height/width left free by the insets (for fit-to-view distances). */
export function usableFraction(w: number, h: number, insets: Insets): { fx: number; fy: number } {
  return {
    fx: Math.max(0.25, (w - insets.left - insets.right) / Math.max(w, 1)),
    fy: Math.max(0.25, (h - insets.top - insets.bottom) / Math.max(h, 1)),
  };
}

let _glowCanvas: HTMLCanvasElement | null = null;
/** Soft additive glow marker (constant pixel size) for the 'play' presentation. */
export function makeGlow(color: THREE.ColorRepresentation, sizePx: number): THREE.Points {
  if (!_glowCanvas) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (g) {
      const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(255,255,255,0.9)');
      grd.addColorStop(0.25, 'rgba(255,255,255,0.45)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
    }
    _glowCanvas = c;
  }
  const tex = new THREE.CanvasTexture(_glowCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  const m = new THREE.PointsMaterial({
    color, size: sizePx, sizeAttenuation: false, map: tex, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  });
  const p = new THREE.Points(geo, m);
  p.frustumCulled = false;
  p.renderOrder = 9;
  return p;
}
