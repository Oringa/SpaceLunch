/**
 * Launcher view: a legible cutaway of the machine in the launcher-local frame
 * (origin at the hub; scene X = h horizontal launch direction, Y = u up,
 * Z = h x u = -a so the basis is right-handed and the launch direction reads
 * left-to-right from the default camera on the +Z side).
 *
 * Rotor phase: the vehicle sits at R (cos phi h - sin phi u), i.e. the rotor
 * group is rotated by -phi about scene Z. During the time-lapsed pump-down
 * and spin-up the true phase per frame is meaningless (aliasing), so the arm
 * turns at a perceptual display rate that grows with the true rate and
 * saturates at ~2.5 rev/s (see spin.ts), with speed cues that grow with the
 * true speed (fading ghost copies of the arm, a swept disc, a bright trail
 * behind the vehicle) and an honest caption. The true phase is drawn during
 * hold, the exit corridor and just after release, blended in continuously.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Scenario } from '../sim/build';
import { fmtPa } from '../sim/labels';
import type { Snapshot } from '../sim/session';
import { armArea, type ArmGeometry } from '../physics/rotor';
import { OMEGA_EARTH } from '../physics/constants';
import { qRotate } from '../physics/quat';
import { type Vec3, cross, rotZ, sub } from '../physics/vec3';
import { Projection, disposeTree, eciRowsToEcef, hasTrajectory, pxPerUnit } from './projection';
import { Track } from './track';
import { VehicleMesh } from './vehicleMesh';
import { BurstFx, type Collider, FailureClock, dustPuff, failureSeed, flightBurst, isMachineFailure, isQuietFailure } from './effects';
import { SpinDisplay, speedCue } from './spin';
import { COLORS, Overlay, fmtFixed, fmtInt, fmtKm, fmtLen, makeLabel, setLabelText, niceStep } from './style';
import {
  type FrameContext, type Insets, type Lights, type View, MAIN_ONLY_LAYER, NO_INSETS, addLights, applyFraming, makeGlow, makeRing, setDot, styleLights, usableFraction,
} from './viewBase';

/** Drawn spin (rad/s) above which labels riding on the rotor are hidden (unreadable while turning). */
const LABEL_SPIN_MAX = 0.8;
/** Drawn spin (rad/s) above which the force arrows' labels are hidden. */
const ARROW_SPIN_MAX = 3;
/** Fading ghost copies of the arm (motion smear). */
const GHOSTS = 4;
/** Room kept free at the top of the launcher view for the banner (CSS px). */
const TOP_ROOM = 44;
/** Tip trail resolution (segments). */
const TRAIL_SEGS = 72;

/** Machine palette: a warm, bright rotor against a cool, mid-grey chamber and a dark sky. */
const PAL = {
  sky: '#0a0f16',
  skyHorizon: '#1a2533',
  ground: '#121820',
  grid: '#1f2a37',
  backWall: '#283341',
  backRings: '#34455a',
  rimInner: '#66768c',
  cut: '#8a99ae',
  edge: '#c6d2e0',
  edgeBack: '#6f8299',
  concrete: '#3a424d',
  hub: '#b9c3cf',
  arm: '#ecd8b4',
  armEmissive: '#3a2810',
  accent: '#ff8a3d',
  counterweight: '#d4893f',
  cradle: '#93a5bb',
  smear: '#ffd9a8',
  trail: '#ffd48f',
  disc: '#a9bdd4',
  tunnelInner: '#3d4b60',
  tunnelOuter: '#93a3b8',
} as const;

const PHASE_NAME: Record<string, string> = {
  pumpdown: 'PUMP-DOWN', spinup: 'SPIN-UP', hold: 'HOLD (phase lock)', corridor: 'RELEASE · EXIT CORRIDOR', flight: 'FLIGHT', ended: 'ENDED',
};

/** Display coast-down time constant of the rotor after a failure (s, wall clock). */
const COAST_TAU = 1.3;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/**
 * Failure being shown in the cutaway (wall-clock choreography; see BurstFx).
 * Fragments released from the spinning rotor keep the velocity they had
 * (omega x r, i.e. tangential) and fly straight; the real speeds would cross
 * the chamber in milliseconds, so they are shown in slow motion.
 */
interface LauncherFailure {
  kind: string;
  /** No animation (reduced motion, or the machine was rebuilt mid-failure). */
  still: boolean;
  /** Displayed rotor angle when the failure was first seen. */
  phi0: number;
  /** Displayed rotor rate right after the failure (rad/s, decays with COAST_TAU). */
  omegaEff: number;
  /** Slow-motion factor (real / shown speed), for the engineer caption. */
  slow: number | null;
  vehicleGone: boolean;
  /** Broken-off outer arm + cradle + vehicle flying as one rigid body. */
  fling: { rcg: number; omega: number; hit: boolean } | null;
  /** Rotor shudder amplitude (m) and duration (s). */
  jitter: number;
  jitterT: number;
  /** Vehicle crumple (component-load). */
  crumple: boolean;
  /** Bearing sparks at the hub until this time (s). */
  hubSparksUntil: number;
  sparkAcc: number;
  /** Scheduled spawns (wall-clock seconds since the failure). */
  pending: Array<{ at: number; run: () => void }>;
  /** 'flight': effect group at the vehicle, one unit per screen pixel. */
  flightAnchor: THREE.Vector3 | null;
  tumble: boolean;
  heatUntil: number;
  /** Start of the in-flight sequence (after any camera move), s. */
  phaseStart: number;
  /** Display gravity (m/s^2) for debris in the chamber. */
  gD: number;
  /** The machine is not involved (e.g. a failure in flight): the rotor keeps coasting as before. */
  rotorFree: boolean;
}

/** Solid arrow (shaft + head) of unit design, re-posed every frame. */
class Arrow {
  readonly group = new THREE.Group();
  private readonly shaft: THREE.Mesh;
  private readonly head: THREE.Mesh;
  constructor(color: string) {
    const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
    const sg = new THREE.CylinderGeometry(1, 1, 1, 12);
    sg.translate(0, 0.5, 0);
    const hg = new THREE.ConeGeometry(1, 1, 16);
    hg.translate(0, 0.5, 0);
    this.shaft = new THREE.Mesh(sg, mat);
    this.head = new THREE.Mesh(hg, mat);
    this.shaft.renderOrder = 20;
    this.head.renderOrder = 20;
    this.group.add(this.shaft, this.head);
  }
  set(origin: THREE.Vector3, dir: THREE.Vector3, length: number, radius: number): void {
    this.group.position.copy(origin);
    this.group.quaternion.setFromUnitVectors(Y_AXIS, _v2.copy(dir).normalize());
    const headLen = Math.min(length * 0.35, radius * 7);
    this.shaft.scale.set(radius, Math.max(length - headLen, 1e-3), radius);
    this.head.position.set(0, length - headLen, 0);
    this.head.scale.set(radius * 2.6, headLen, radius * 2.6);
  }
}

/** Anchor a label so it sits beyond its point in screen-ish direction `dir` (scene XY ~ screen). */
function anchorBeyond(dir: THREE.Vector3, label: CSS2DObject, gap = 1.08): void {
  const g = gap - 1;
  const cx = dir.x > 0.35 ? -g : dir.x < -0.35 ? 1 + g : 0.5;
  const cy = dir.y > 0.35 ? 1 + g * 2 : dir.y < -0.35 ? -g * 2 : 0.5;
  label.center.set(cx, cy);
}

/** Rectangular bar along +X whose tangential chord and axial height vary with x. */
function taperedBar(stations: Array<{ x: number; w: number; h: number }>): THREE.BufferGeometry {
  const pos: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]): void => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  const corner = (s: { x: number; w: number; h: number }, sy: number, sz: number): number[] => [s.x, (sy * s.w) / 2, (sz * s.h) / 2];
  for (let i = 0; i < stations.length - 1; i++) {
    const s0 = stations[i], s1 = stations[i + 1];
    quad(corner(s0, -1, 1), corner(s1, -1, 1), corner(s1, 1, 1), corner(s0, 1, 1)); // +z face
    quad(corner(s0, 1, -1), corner(s1, 1, -1), corner(s1, -1, -1), corner(s0, -1, -1)); // -z face
    quad(corner(s0, 1, 1), corner(s1, 1, 1), corner(s1, 1, -1), corner(s0, 1, -1)); // +y face
    quad(corner(s0, -1, -1), corner(s1, -1, -1), corner(s1, -1, 1), corner(s0, -1, 1)); // -y face
  }
  const a = stations[0], b = stations[stations.length - 1];
  quad(corner(a, -1, -1), corner(a, 1, -1), corner(a, 1, 1), corner(a, -1, 1));
  quad(corner(b, -1, 1), corner(b, 1, 1), corner(b, 1, -1), corner(b, -1, -1));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function armStations(g: ArmGeometry, x0: number, x1: number, minW: number, minH: number, n = 14): Array<{ x: number; w: number; h: number }> {
  const out: Array<{ x: number; w: number; h: number }> = [];
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    const A = armArea(g, x);
    const h = Math.sqrt(A / g.sectionAspect); // axial (frontal) height
    const w = g.sectionAspect * h; // tangential chord
    out.push({ x, w: Math.max(w, minW), h: Math.max(h, minH) });
  }
  return out;
}

function circlePoints(r: number, z: number, n = 256, a0 = 0, a1 = Math.PI * 2): Vec3[] {
  const pts: Vec3[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    pts.push([r * Math.cos(a), r * Math.sin(a), z]);
  }
  return pts;
}

const VEHICLE_SHARDS = ['#e6edf3', '#d0d7de', '#aab3bd', '#8b949e'];
const ARM_SHARDS = ['#9aa7b8', '#7d8a9c', '#b4bfcc'];
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Velocity (scene) of point p on a rotor turning at w rad/s (clockwise seen from +Z, like phi). */
function rotorVel(p: THREE.Vector3, w: number, out: THREE.Vector3): THREE.Vector3 {
  return out.set(w * p.y, -w * p.x, 0);
}

/**
 * Corner of a freed rigid piece (rotor coords, CG at (rcg, 0)) after the rotor
 * would have turned by th: it keeps the rotor's angular rate and its CG moves
 * along the tangent (no centripetal force any more).
 */
function flungCorner(rcg: number, x: number, y: number, th: number, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(th), s = Math.sin(th);
  const dx = x - rcg;
  return out.set(rcg + c * dx + s * y, -th * rcg - s * dx + c * y, 0);
}

/** Rotor angle after which the first corner of a freed piece reaches radius lim. */
function flingHitAngle(rcg: number, corners: Array<[number, number]>, lim: number): number {
  for (let th = 0; th < 3; th += 0.005) {
    for (const [x, y] of corners) if (flungCorner(rcg, x, y, th, _v4).lengthSq() >= lim * lim) return th;
  }
  return 1;
}

/** Two significant figures (caption numbers). */
function niceRound(x: number): number {
  const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.max(x, 1))) - 1));
  return Math.round(x / p) * p;
}

function lineLoop(r: number, z: number, color: THREE.ColorRepresentation, opacity = 1): THREE.LineLoop {
  const pts: number[] = [];
  for (let i = 0; i < 192; i++) {
    const a = (2 * Math.PI * i) / 192;
    pts.push(r * Math.cos(a), r * Math.sin(a), z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
}

/** Identity projection for scene-space helper lines (launcher scene is metres at the hub). */
const IDENTITY = new Projection();

/** Screen-space fat line (pixel width) through segment pairs [x0,y0,z0, x1,y1,z1, ...]. */
function fatLines(segs: number[], mat: LineMaterial): LineSegments2 {
  const g = new LineSegmentsGeometry();
  g.setPositions(segs);
  const l = new LineSegments2(g, mat);
  l.frustumCulled = false;
  l.layers.set(MAIN_ONLY_LAYER);
  return l;
}

/** Straight segment along an arm part's front face (rotor coords; sign -1 for the counter arm). */
function armFaceSeg(st: Array<{ x: number; w: number; h: number }>, sign: number, lift: number): number[] {
  let hMax = 0;
  for (const p of st) hMax = Math.max(hMax, p.h);
  const z = hMax / 2 + lift;
  return [sign * st[0].x, 0, z, sign * st[st.length - 1].x, 0, z];
}

/**
 * Annular strip in the rotor plane that starts at the drawn rotor angle and
 * extends backwards (against the spin), its alpha fading along the strip:
 * used for the tip trail and the motion smear of the arms. Positions are
 * rewritten every frame (a few hundred vertices).
 */
class ArcStrip {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
  private readonly n: number;
  constructor(color: string, segs: number, falloff: number, additive: boolean, renderOrder: number) {
    this.n = segs;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((segs + 1) * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const col = new Float32Array((segs + 1) * 2 * 4);
    const c = new THREE.Color(color);
    for (let k = 0; k <= segs; k++) {
      const a = Math.pow(1 - k / segs, falloff);
      for (let e = 0; e < 2; e++) col.set([c.r, c.g, c.b, a], (2 * k + e) * 4);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 4));
    const idx: number[] = [];
    for (let k = 0; k < segs; k++) idx.push(2 * k, 2 * k + 1, 2 * k + 2, 2 * k + 1, 2 * k + 3, 2 * k + 2);
    g.setIndex(idx);
    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(MAIN_ONLY_LAYER);
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
  }

  /** Strip between radii r0..r1 (sign -1: the opposite arm) from rotor angle phi back over len (rad). */
  set(phi: number, len: number, r0: number, r1: number, z: number, sign = 1): void {
    const pos = this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let j = 0; j <= this.n; j++) {
      const a = -(phi - (len * j) / this.n);
      const c = sign * Math.cos(a), sn = sign * Math.sin(a);
      pos.setXYZ(2 * j, r0 * c, r0 * sn, z);
      pos.setXYZ(2 * j + 1, r1 * c, r1 * sn, z);
    }
    pos.needsUpdate = true;
  }
}

export class LauncherView implements View {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private readonly overlay: Overlay;
  /** ECEF -> launcher scene (origin hub, basis h, u, h x u). */
  private readonly proj = new Projection();
  private scenario: Scenario | null = null;
  private machine = new THREE.Group();
  private rotor = new THREE.Group();
  private vehicle: VehicleMesh | null = null;
  private vehicleOnArm = new THREE.Group();
  private counterBlock: THREE.Object3D | null = null;
  private cwLabel: CSS2DObject | null = null;
  private armLabel: CSS2DObject | null = null;
  /** Swept disc (speed cue; not part of the rotating group). */
  private blurDisc = new THREE.Group();
  private discMat: THREE.MeshBasicMaterial | null = null;
  /** Perceptual display spin / true-phase handoff. */
  private readonly spin = new SpinDisplay();
  /** Fat-line materials of the current machine (resolution follows the viewport). */
  private lineMats: LineMaterial[] = [];
  /** Motion smear: fading copies of the arm and counterweight trailing the drawn arm. */
  private ghosts: Array<{ group: THREE.Group; line: LineMaterial; mesh: THREE.MeshBasicMaterial }> = [];
  /** Bright trail behind the vehicle at the tip, and the smooth smear wedges of both arms. */
  private trail: ArcStrip | null = null;
  private smearV: ArcStrip | null = null;
  private smearC: ArcStrip | null = null;
  private smearR = { hub: 0.5, v: 1, c: 1, z: 0 };
  private readonly labels = new THREE.Group();
  private readonly flownTrack = new Track({ color: COLORS.flown, width: 2.5, renderOrder: 5 });
  private readonly predictedTrack = new Track({ color: COLORS.predicted, width: 1.8, dashed: true, opacity: 0.9, renderOrder: 4 });
  private readonly pathCircle = new Track({ color: '#8b97a8', width: 1, dashed: true, opacity: 0.55 });
  private readonly releaseArc = new Track({ color: COLORS.release, width: 5, renderOrder: 6 });
  private readonly corridorLine = new Track({ color: COLORS.release, width: 1.5, dashed: true, opacity: 0.9 });
  private readonly tunnelWallA = new Track({ color: PAL.edge, width: 1.8 });
  private readonly tunnelWallB = new Track({ color: PAL.edge, width: 1.8 });
  private readonly vArrow = new Arrow(COLORS.velocity);
  private readonly aArrow = new Arrow(COLORS.accel);
  private readonly vLabel = makeLabel('', 'green', [0, 0.5]);
  private readonly aLabel = makeLabel('', 'violet', [0, 0.5]);
  private readonly vehicleLabel = makeLabel('VEHICLE', 'default', [0, 1.2]);
  private readonly vehicleRing = makeRing(COLORS.flown, 32);
  private readonly awayLabel = makeLabel('', 'amber', [0.5, 1.2]);
  private readonly fixedLabels: CSS2DObject[] = [];
  private ground = new THREE.Group();
  private resetPending = true;
  private height = 1;
  private tRelease = NaN;
  private builtRc = NaN;
  private lights: Lights;
  private variant: 'engineer' | 'play' = 'engineer';
  /** Short labels: 'play' variant or a narrow viewport. */
  private compact = false;
  private insets: Insets = NO_INSETS;
  /** Fixed label texts: full (engineer) and short ('play'; null hides it). */
  private readonly labelTexts = new Map<CSS2DObject, { full: string; short: string | null }>();
  private readonly vehicleGlow = makeGlow(COLORS.flown, 42);
  private width = 1;
  private readonly insetCam = new THREE.PerspectiveCamera(30, 1.5, 0.01, 1e5);
  private readonly insetDiv: HTMLDivElement;
  private readonly insetCaption: HTMLDivElement;
  private insetRect: { x: number; y: number; w: number; h: number } | null = null;
  // Failure effects.
  private readonly fx = new BurstFx({ sparkWidth: 3, glowSize: 10 });
  private readonly fxClock = new FailureClock();
  private fail: LauncherFailure | null = null;
  /** Camera move that frames a failure outside the view (wall-clock, from the failure). */
  private camTween: { p0: THREE.Vector3; t0: THREE.Vector3; p1: THREE.Vector3; t1: THREE.Vector3; dur: number } | null = null;
  private reframed = false;
  /** Restart the current failure without animation (machine rebuilt mid-failure). */
  private resumeStill = false;
  /** Outer vehicle arm + cradle + vehicle: the part that breaks off on a structural failure. */
  private outerPiece = new THREE.Group();
  private flingPivot = new THREE.Group();
  private flingBody = new THREE.Group();
  private dims = { Rc: 1, D: 1, hubR: 0.5, xBreak: 0.5, xArmEnd: 1, cradle: 0.3, minW: 0.1 };
  private readonly chamberCollider: Collider = {
    resolve: (p, r, n) => {
      const { Rc, D } = this.dims;
      let hit = false;
      n.set(0, 0, 0);
      const lim = Rc - r;
      const rr = Math.hypot(p.x, p.y);
      if (rr > lim && rr > 0) {
        p.x *= lim / rr;
        p.y *= lim / rr;
        n.x += p.x / lim;
        n.y += p.y / lim;
        hit = true;
      }
      const hz = D / 2 - r;
      if (p.z < -hz) {
        p.z = -hz;
        n.z -= 1;
        hit = true;
      } else if (p.z > hz) {
        p.z = hz;
        n.z += 1;
        hit = true;
      }
      if (hit) n.normalize();
      return hit;
    },
  };

  constructor(dom: HTMLElement, overlayParent: HTMLElement) {
    // Solid sky (a full-screen gradient costs ~25 % of the frame in software GL); the fogged
    // ground fades to a lighter horizon band, which gives the depth cue.
    this.scene.background = new THREE.Color(PAL.sky);
    this.scene.fog = new THREE.Fog(PAL.skyHorizon, 200, 800);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 2e6);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enabled = false;
    this.controls.screenSpacePanning = true;
    this.overlay = new Overlay(overlayParent);
    this.lights = addLights(this.scene, new THREE.Vector3(0.35, 0.8, 0.6));
    this.scene.add(this.machine, this.ground, this.labels);
    this.scene.add(this.flownTrack.object, this.predictedTrack.object, this.pathCircle.object, this.releaseArc.object, this.corridorLine.object, this.tunnelWallA.object, this.tunnelWallB.object);
    this.scene.add(this.vArrow.group, this.aArrow.group);
    this.labels.add(this.vLabel, this.aLabel, this.awayLabel, this.vehicleLabel);
    this.scene.add(this.vehicleRing, this.vehicleGlow, this.fx.group);
    this.vehicleGlow.layers.set(MAIN_ONLY_LAYER);
    // Main-camera-only helpers stay out of the detail inset.
    this.camera.layers.enable(MAIN_ONLY_LAYER);
    for (const o of [this.vArrow.group, this.aArrow.group, this.vehicleRing]) o.traverse((c) => c.layers.set(MAIN_ONLY_LAYER));
    this.insetDiv = document.createElement('div');
    Object.assign(this.insetDiv.style, {
      position: 'absolute', right: '14px', bottom: '14px', border: '1px solid rgba(139,148,158,.55)', borderRadius: '4px',
      pointerEvents: 'none', display: 'none', boxShadow: '0 0 0 1px rgba(13,17,23,.6)',
    });
    this.insetCaption = document.createElement('div');
    this.insetCaption.className = 'cf-label';
    Object.assign(this.insetCaption.style, { position: 'absolute', left: '6px', top: '6px' });
    this.insetDiv.appendChild(this.insetCaption);
    this.overlay.root.appendChild(this.insetDiv);
  }

  activate(): void {
    this.controls.enabled = true;
    this.overlay.show(true);
  }

  deactivate(): void {
    this.controls.enabled = false;
    this.overlay.show(false);
  }

  resize(w: number, h: number): void {
    this.height = h;
    this.width = w;
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
    for (const t of [this.flownTrack, this.predictedTrack, this.pathCircle, this.releaseArc, this.corridorLine, this.tunnelWallA, this.tunnelWallB]) t.setResolution(w, h);
    for (const m of this.lineMats) m.resolution.set(w, h);
    this.fx.setResolution(w, h);
  }

  resetCamera(): void {
    this.resetPending = true;
  }

  inset(): { camera: THREE.Camera; x: number; y: number; w: number; h: number } | null {
    return this.insetRect ? { camera: this.insetCam, ...this.insetRect } : null;
  }

  /** Detail inset: the vehicle at true scale, seen from the main camera's direction. */
  private updateInset(show: boolean, vehPos: THREE.Vector3, sc: Scenario): void {
    const ins = this.insets;
    const freeW = this.width - ins.left - ins.right, freeH = this.height - ins.top - ins.bottom;
    if (!show || freeW < 700 || freeH < 380) {
      this.insetRect = null;
      this.insetDiv.style.display = 'none';
      return;
    }
    const w = Math.round(Math.min(380, Math.max(220, freeW * 0.25, 0), (freeH * 0.4) / 0.64));
    const h = Math.round(w * 0.64);
    this.insetRect = { x: this.width - ins.right - 14 - w, y: ins.bottom + 14, w, h };
    this.insetDiv.style.display = '';
    this.insetDiv.style.right = `${ins.right + 14}px`;
    this.insetDiv.style.bottom = `${ins.bottom + 14}px`;
    this.insetDiv.style.width = `${w}px`;
    this.insetDiv.style.height = `${h}px`;
    const field = Math.max(sc.vehicle.length * 2.6, sc.geometry.apertureRadius * 8);
    this.insetCam.aspect = w / h;
    const dist = field / 2 / Math.tan((this.insetCam.fov * Math.PI) / 360) / Math.max(1, this.insetCam.aspect * 0.8);
    const dir = _v2.copy(this.camera.position).sub(this.controls.target).normalize();
    this.insetCam.position.copy(vehPos).addScaledVector(dir, dist);
    this.insetCam.up.set(0, 1, 0);
    this.insetCam.lookAt(vehPos);
    this.insetCam.near = dist * 0.02;
    this.insetCam.far = dist * 4000;
    this.insetCam.updateProjectionMatrix();
    const cap = `DETAIL · true scale · field ≈ ${fmtLen(field)}`;
    if (this.insetCaption.textContent !== cap) this.insetCaption.textContent = cap;
  }

  /**
   * Default framing: a 3/4 elevated view through the cut-away front wall that
   * shows the whole rotor disc (it reads as a slightly tilted ellipse, so the
   * spin is obvious) together with the exit tunnel, fitted to the region left
   * free by UI insets.
   */
  private applyCameraReset(): void {
    const sc = this.scenario;
    const Rc = sc ? sc.geometry.chamberRadius : 50;
    let cx = 0, cy = 0, halfW = Rc * 1.05, halfH = Rc * 1.05;
    if (sc) {
      const g = sc.geometry;
      const O = this.proj.toSceneV(g.tunnelOrigin, _v3);
      const dir = this.proj.dirToScene(g.tunnelDir, _v4).normalize();
      const ex = O.x + dir.x * g.sEnd, ey = O.y + dir.y * g.sEnd;
      const yLow = Math.max(-g.hubHeight, -Rc * 1.15);
      const x0 = Math.min(-Rc, ex), x1 = Math.max(Rc, ex), y0 = Math.min(yLow, ey), y1 = Math.max(Rc, ey);
      cx = (x0 + x1) / 2;
      cy = (y0 + y1) / 2;
      halfW = (x1 - x0) / 2 + Rc * 0.04;
      halfH = (y1 - y0) / 2 + Rc * 0.04;
    }
    const aspect = this.camera.aspect || 1.6;
    const { fx, fy: fy0 } = usableFraction(this.width, this.height, this.insets);
    const fy = Math.max(0.25, fy0 - TOP_ROOM / Math.max(this.height, 1));
    const az = 0.45, el = 0.28;
    const tanH = Math.tan((this.camera.fov * Math.PI) / 360);
    // Foreshortening of the rotor plane seen from (az, el) shrinks the box a little.
    const fitW = (halfW * Math.cos(az) + Rc * 0.35 * Math.sin(az)) / (tanH * aspect * fx);
    const fitH = (halfH * Math.cos(el) + Rc * 0.3 * Math.sin(el)) / (tanH * fy);
    const dist = Math.max(fitW, fitH) * 1.02;
    this.controls.target.set(cx, cy, 0);
    this.camera.position.set(cx + Math.sin(az) * Math.cos(el) * dist, cy + Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist);
    this.camera.lookAt(this.controls.target);
    this.controls.minDistance = 1;
    this.controls.maxDistance = Rc * 40;
    this.controls.update();
  }

  // ------------------------------------------------------------------ machine
  private build(sc: Scenario): void {
    // A failure on screen restarts without animation on the new machine.
    if (this.fail) {
      this.resetFailure();
      this.fxClock.forget();
      this.resumeStill = true;
    }
    disposeTree(this.machine);
    this.scene.remove(this.machine);
    for (const l of this.fixedLabels) {
      l.removeFromParent();
      l.element.remove();
    }
    this.fixedLabels.length = 0;
    this.vehicleOnArm.removeFromParent();
    this.vehicle?.dispose();
    this.machine = new THREE.Group();
    this.rotor = new THREE.Group();
    this.blurDisc = new THREE.Group();
    this.vehicleOnArm = new THREE.Group();
    this.outerPiece = new THREE.Group();
    this.flingPivot = new THREE.Group();
    this.flingBody = new THREE.Group();
    this.flingPivot.add(this.flingBody);
    this.scene.add(this.machine);

    const g = sc.geometry;
    const w: Vec3 = cross(g.h, g.u);
    this.proj.setBasis(g.h, g.u, w);
    this.proj.setOrigin(g.hubEcef);
    this.proj.setScale(1);

    const Rc = g.chamberRadius, D = g.chamberDepth, R = g.armRadius;
    const v = sc.vehicle;
    const wallT = Math.min(1.2, Math.max(0.25, 0.012 * Rc));
    const hubR = Math.min(2.5, Math.max(0.35, 0.035 * Rc));

    const steel = new THREE.MeshStandardMaterial({ color: PAL.rimInner, emissive: '#18212c', metalness: 0.4, roughness: 0.6, side: THREE.BackSide });
    const backWallMat = new THREE.MeshStandardMaterial({ color: PAL.backWall, metalness: 0.2, roughness: 0.85, side: THREE.DoubleSide });
    const cutMat = new THREE.MeshStandardMaterial({ color: PAL.cut, metalness: 0.2, roughness: 0.65, side: THREE.DoubleSide });
    const shellMat = new THREE.MeshStandardMaterial({ color: '#7d8da3', metalness: 0.4, roughness: 0.6, transparent: true, opacity: 0.14, depthWrite: false });
    const hubMat = new THREE.MeshStandardMaterial({ color: PAL.hub, metalness: 0.6, roughness: 0.35 });
    const armMat = new THREE.MeshStandardMaterial({ color: PAL.arm, emissive: PAL.armEmissive, metalness: 0.3, roughness: 0.42 });
    const cwMat = new THREE.MeshStandardMaterial({ color: PAL.counterweight, emissive: '#2a1606', metalness: 0.45, roughness: 0.4 });
    const concrete = new THREE.MeshStandardMaterial({ color: PAL.concrete, metalness: 0.05, roughness: 0.95 });

    // Chamber: back wall, inner rim (visible inner wall), cut section at the front edge, faint outer skin.
    const back = new THREE.Mesh(new THREE.CircleGeometry(Rc, 160), backWallMat);
    back.position.z = -D / 2;
    this.machine.add(back);
    for (const f of [0.5]) {
      const ring = lineLoop(Rc * f, -D / 2 + 0.02, PAL.backRings, 0.7);
      this.machine.add(ring);
    }
    const spokes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const a = (2 * Math.PI * i) / 12;
      spokes.push(hubR * 1.6 * Math.cos(a), hubR * 1.6 * Math.sin(a), -D / 2 + 0.02, Rc * Math.cos(a), Rc * Math.sin(a), -D / 2 + 0.02);
    }
    const spokeGeo = new THREE.BufferGeometry();
    spokeGeo.setAttribute('position', new THREE.Float32BufferAttribute(spokes, 3));
    this.machine.add(new THREE.LineSegments(spokeGeo, new THREE.LineBasicMaterial({ color: PAL.backRings, transparent: true, opacity: 0.45 })));
    const rimGeo = new THREE.CylinderGeometry(Rc, Rc, D, 192, 1, true);
    rimGeo.rotateX(Math.PI / 2);
    this.machine.add(new THREE.Mesh(rimGeo, steel));
    const skinGeo = new THREE.CylinderGeometry(Rc + wallT, Rc + wallT, D, 192, 1, true);
    skinGeo.rotateX(Math.PI / 2);
    this.machine.add(new THREE.Mesh(skinGeo, shellMat));
    const cut = new THREE.Mesh(new THREE.RingGeometry(Rc, Rc + wallT, 192), cutMat);
    cut.position.z = D / 2;
    this.machine.add(cut);
    const backCut = new THREE.Mesh(new THREE.RingGeometry(Rc, Rc + wallT, 192), cutMat);
    backCut.position.z = -D / 2;
    this.machine.add(backCut);
    this.machine.add(lineLoop(Rc, D / 2 + 0.01, PAL.edge, 0.95), lineLoop(Rc + wallT, D / 2 + 0.01, PAL.edge, 0.95));
    this.machine.add(lineLoop(Rc, -D / 2 + 0.03, PAL.edgeBack, 0.9));

    // Hub, shaft and bearing housing on the back wall.
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(hubR, hubR, D * 0.55, 40), hubMat);
    hub.rotation.x = Math.PI / 2;
    this.rotor.add(hub);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(hubR * 0.45, hubR * 0.45, D * 1.0 + 2, 24), hubMat);
    shaft.rotation.x = Math.PI / 2;
    shaft.position.z = -0.5;
    this.machine.add(shaft);
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(hubR * 1.5, hubR * 1.7, D * 0.12, 40), cutMat);
    housing.rotation.x = Math.PI / 2;
    housing.position.z = -D / 2 + D * 0.06;
    this.machine.add(housing);

    // Saddles and foundation (ground at y = -hubHeight).
    const yG = -g.hubHeight;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(Rc * 1.3, 0.6, D * 1.8), concrete);
    slab.position.set(0, yG + 0.3, 0);
    this.machine.add(slab);
    for (const sx of [-0.42, 0.42]) {
      const x = sx * Rc;
      const yTop = -Math.sqrt(Math.max(0, (Rc + wallT) ** 2 - x * x));
      const hgt = Math.max(0.3, yTop - (yG + 0.6));
      const saddle = new THREE.Mesh(new THREE.BoxGeometry(Rc * 0.12, hgt, D * 1.25), concrete);
      saddle.position.set(x, yG + 0.6 + hgt / 2, 0);
      this.machine.add(saddle);
    }

    // Arms (true section where legible; minimum display size for thin tips).
    const vArm = sc.rotor.vehicleArm, cArm = sc.rotor.counterArm;
    const minW = Math.max(0.1, 0.006 * R), minH = Math.max(0.08, 0.004 * R);
    const cradle = Math.max(0.3, v.diameter * 1.2);
    // Vehicle arm in two pieces split at the most-stressed station (kept to 25-70 % of the span),
    // so a structural failure can break the outer part off.
    const xA = hubR * 0.9, xB = R - v.diameter / 2 - cradle;
    const span = Math.max(xB - xA, 1e-3);
    const xBreak = Math.min(xA + 0.7 * span, Math.max(xA + 0.25 * span, sc.derived.stressMaxAt));
    const nIn = Math.max(3, Math.round((14 * (xBreak - xA)) / span));
    const stIn = armStations(vArm, xA, xBreak, minW, minH, nIn);
    const stOut = armStations(vArm, xBreak, xB, minW, minH, Math.max(3, 14 - nIn));
    const armV = new THREE.Mesh(taperedBar(stIn), armMat);
    this.rotor.add(armV);
    const armVOuter = new THREE.Mesh(taperedBar(stOut), armMat);
    this.outerPiece.add(armVOuter);
    this.rotor.add(this.outerPiece);
    this.dims = { Rc, D, hubR, xBreak, xArmEnd: xB, cradle, minW };
    const Rcw = sc.rotor.counterRadius;
    const cwSize = Math.max(Math.cbrt(sc.derived.counterMass / 7850), 0.03 * R);
    const stC = armStations(cArm, hubR * 0.9, Math.max(hubR * 1.2, Rcw - cwSize / 2), minW, minH);
    const armC = new THREE.Mesh(taperedBar(stC), armMat);
    armC.rotation.z = Math.PI;
    this.rotor.add(armC);
    const cwGeo = new THREE.BoxGeometry(cwSize, cwSize * 1.4, cwSize);
    const cw = new THREE.Mesh(cwGeo, cwMat);
    cw.position.x = -Rcw;
    this.rotor.add(cw);
    this.counterBlock = cw;
    const mount = new THREE.Mesh(
      new THREE.BoxGeometry(cradle, Math.max(v.length * 0.45, 0.5), Math.max(minH * 1.6, v.diameter * 1.3)),
      new THREE.MeshStandardMaterial({ color: PAL.cradle, metalness: 0.5, roughness: 0.4 }),
    );
    mount.position.x = R - v.diameter / 2 - cradle / 2;
    this.outerPiece.add(mount);

    // Accent stripe along the arms' front faces (main camera only; the true-scale inset stays plain):
    // a dark outline under a bright line, so the arm reads at a glance whatever its true section.
    this.lineMats = [];
    const lineMat = (color: string, width: number, opacity = 1): LineMaterial => {
      const m = new LineMaterial({ color: new THREE.Color(color).getHex(), linewidth: width, worldUnits: false, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
      m.resolution.set(this.width, this.height);
      this.lineMats.push(m);
      return m;
    };
    const lift = Math.max(0.01, 0.002 * R);
    const segIn = armFaceSeg(stIn, 1, lift), segOut = armFaceSeg(stOut, 1, lift), segC = armFaceSeg(stC, -1, lift);
    // Both in the transparent pass so renderOrder puts the stripe over its outline.
    const outline = lineMat('#0a0d12', 7, 0.6), stripe = lineMat(PAL.accent, 3, 0.999);
    for (const [segs, parent] of [[segIn, this.rotor], [segOut, this.outerPiece], [segC, this.rotor]] as const) {
      const o = fatLines(segs, outline);
      o.renderOrder = 3;
      const l = fatLines(segs, stripe);
      l.renderOrder = 4;
      parent.add(o, l);
    }

    // Vehicle on the arm: nose along the tangential direction (-Y at phase 0).
    this.vehicle = new VehicleMesh(v);
    this.vehicleOnArm.position.set(R, 0, 0);
    this.vehicleOnArm.rotation.z = -Math.PI / 2;
    this.vehicleOnArm.add(this.vehicle.group);
    this.outerPiece.add(this.vehicleOnArm);
    this.machine.add(this.rotor, this.flingPivot);

    // Speed cues (not part of the rotating group): swept disc, ghost copies of the arm, tip trail.
    const discR = Math.max(R + v.length / 2, Rcw + cwSize);
    this.discMat = new THREE.MeshBasicMaterial({ color: PAL.disc, transparent: true, opacity: 0.05, depthWrite: false, side: THREE.DoubleSide });
    const disc = new THREE.Mesh(new THREE.RingGeometry(hubR, discR, 160, 1), this.discMat);
    disc.position.z = 0.02;
    disc.renderOrder = 1;
    this.blurDisc.add(disc);
    this.blurDisc.visible = false;
    this.machine.add(this.blurDisc);
    // Ghost copies: one straight stroke per arm (no joints, so no beading where strokes overlap).
    const ghostSegs = [hubR, 0, lift, R + v.length * 0.1, 0, lift, -hubR, 0, lift, -Rcw, 0, lift];
    const ghostGeo = new LineSegmentsGeometry();
    ghostGeo.setPositions(ghostSegs);
    this.ghosts = [];
    for (let i = 0; i < GHOSTS; i++) {
      const group = new THREE.Group();
      const line = lineMat(PAL.smear, 4, 0.3);
      line.depthWrite = false;
      const gl = new LineSegments2(ghostGeo, line);
      gl.frustumCulled = false;
      gl.layers.set(MAIN_ONLY_LAYER);
      gl.renderOrder = 2;
      const mesh = new THREE.MeshBasicMaterial({ color: PAL.counterweight, transparent: true, opacity: 0.3, depthWrite: false });
      const gcw = new THREE.Mesh(cwGeo, mesh);
      gcw.position.x = -Rcw;
      gcw.layers.set(MAIN_ONLY_LAYER);
      gcw.renderOrder = 2;
      group.add(gl, gcw);
      group.visible = false;
      this.machine.add(group);
      this.ghosts.push({ group, line, mesh });
    }
    this.smearV = new ArcStrip(PAL.smear, 48, 1.8, false, 1);
    this.smearC = new ArcStrip(PAL.smear, 48, 1.8, false, 1);
    this.trail = new ArcStrip(PAL.trail, TRAIL_SEGS, 1.5, true, 5);
    this.smearR = { hub: hubR, v: R, c: Rcw + cwSize * 0.5, z: lift };
    this.machine.add(this.smearV.mesh, this.smearC.mesh, this.trail.mesh);

    // Exit tunnel: from the aperture in the wall (s = sWall) to sEnd.
    const O = this.proj.toSceneV(g.tunnelOrigin, new THREE.Vector3());
    const dir = this.proj.dirToScene(g.tunnelDir, new THREE.Vector3()).normalize();
    const ap = g.apertureRadius;
    const tLen = g.sEnd - g.sWall;
    const tw = Math.max(0.25, ap * 0.7);
    const tq = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir);
    const mid = O.clone().addScaledVector(dir, (g.sWall + g.sEnd) / 2);
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(ap, ap, tLen, 40, 1, true), new THREE.MeshStandardMaterial({ color: PAL.tunnelInner, metalness: 0.4, roughness: 0.6, side: THREE.BackSide }));
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(ap + tw, ap + tw, tLen, 40, 1, true), new THREE.MeshStandardMaterial({ color: PAL.tunnelOuter, transparent: true, opacity: 0.45, depthWrite: false }));
    for (const m of [inner, outer]) {
      m.position.copy(mid);
      m.quaternion.copy(tq);
      this.machine.add(m);
    }
    const ringAt = (s: number, r: number, color: string, tube: number): THREE.Mesh => {
      const t = new THREE.Mesh(new THREE.TorusGeometry(r, tube, 10, 48), new THREE.MeshBasicMaterial({ color }));
      t.position.copy(O).addScaledVector(dir, s);
      t.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      return t;
    };
    this.machine.add(ringAt(g.sWall, ap, COLORS.release, Math.max(0.04, ap * 0.12)));
    // Tunnel walls drawn as outline lines in the rotor plane (legible at overview scale).
    const perp = new THREE.Vector3(-dir.y, dir.x, 0).normalize().multiplyScalar(ap + tw);
    const wallPts = (sign: number): Vec3[] => {
      const a0 = O.clone().addScaledVector(dir, g.sWall).addScaledVector(perp, sign);
      const a1 = O.clone().addScaledVector(dir, g.sEnd).addScaledVector(perp, sign);
      return [[a0.x, a0.y, 0.15], [a1.x, a1.y, 0.15]];
    };
    this.tunnelWallA.setPoints(wallPts(1), IDENTITY);
    this.tunnelWallB.setPoints(wallPts(-1), IDENTITY);
    this.machine.add(ringAt(g.sEnd, ap + tw * 0.5, PAL.edge, Math.max(0.03, ap * 0.06)));

    // Static guides: vehicle circle, release window arc, exit corridor (s = 0 .. sWall).
    this.pathCircle.setPoints(circlePoints(R, 0.05, 256), IDENTITY);
    const win = (2.5 * Math.PI) / 180;
    const arc: Vec3[] = [];
    for (let i = 0; i <= 24; i++) {
      const ph = g.phiRelease - win + (2 * win * i) / 24;
      arc.push([R * Math.cos(ph), -R * Math.sin(ph), 0.1]);
    }
    this.releaseArc.setPoints(arc, IDENTITY);
    const endWall = O.clone().addScaledVector(dir, g.sWall);
    this.corridorLine.setPoints([[O.x, O.y, O.z + 0.12], [endWall.x, endWall.y, endWall.z + 0.12]], IDENTITY);

    // Ground: a plain plane with a sparse, faint grid (it fades into the horizon fog).
    disposeTree(this.ground);
    this.scene.remove(this.ground);
    this.ground = new THREE.Group();
    const cell = niceStep(Rc / 2);
    const size = cell * 64;
    const groundSize = Math.max(size, Rc * 80);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), new THREE.MeshStandardMaterial({ color: PAL.ground, roughness: 1, metalness: 0 }));
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = yG;
    const grid = new THREE.GridHelper(size, 16, PAL.grid, PAL.grid);
    grid.position.y = yG + 0.04;
    const gm = grid.material as THREE.LineBasicMaterial;
    gm.transparent = true;
    gm.opacity = 0.7;
    this.ground.add(plane, grid);
    this.scene.add(this.ground);

    // Fixed labels.
    this.labelTexts.clear();
    const addFixed = (text: string, short: string | null, pos: THREE.Vector3, variant: Parameters<typeof makeLabel>[1] = 'default', center: [number, number] = [0.5, 1]): void => {
      const l = makeLabel(text, variant, center);
      l.position.copy(pos);
      this.labels.add(l);
      this.fixedLabels.push(l);
      this.labelTexts.set(l, { full: text, short });
    };
    addFixed(`VACUUM CHAMBER  Ø ${fmtLen(2 * Rc)} × ${fmtLen(D)} deep\nfront wall cut away`, 'VACUUM CHAMBER', new THREE.Vector3(Rc * 0.45, Rc * 0.92, D / 2), 'muted', [0, 1]);
    addFixed(`HUB · ${fmtInt(sc.rotor.motor.electricalPowerW / 1e6)} MW drive`, null, new THREE.Vector3(0, -hubR * 1.4, D / 2), 'muted', [0.5, 0]);
    // Release label outside the rim, on the release radius: clear of the vehicle's path.
    const relDir = new THREE.Vector3(Math.cos(g.phiRelease), -Math.sin(g.phiRelease), 0);
    const relLabel = relDir.clone().multiplyScalar(Rc + wallT * 2);
    relLabel.z = D / 2;
    addFixed(`RELEASE POINT\nelevation ${fmtFixed((g.elevation * 180) / Math.PI, 0)}°`, 'RELEASE', relLabel, 'release', [0.5, 0.5]);
    anchorBeyond(relDir, this.fixedLabels[this.fixedLabels.length - 1], 1.12);
    // Exit tunnel label beside the outer part of the tunnel, on the side away from the hub
    // (clear of the banner at the top of the view and of the vehicle's path).
    const sLab = g.sWall + Math.max(0.6 * tLen, Math.min(tLen, Rc * 0.1));
    const tMid = O.clone().addScaledVector(dir, sLab);
    const side = new THREE.Vector3(-dir.y, dir.x, 0).normalize();
    if (side.dot(tMid) < 0) side.multiplyScalar(-1);
    tMid.addScaledVector(side, (ap + tw) * 1.5);
    addFixed(`EXIT TUNNEL ${fmtLen(tLen)}\naperture Ø ${fmtLen(2 * ap)}`, 'EXIT TUNNEL', tMid, 'muted', [0.5, 0.5]);
    anchorBeyond(side, this.fixedLabels[this.fixedLabels.length - 1], 1.1);
    const cwLabel = (this.cwLabel = makeLabel(`COUNTERWEIGHT\n${fmtInt(sc.derived.counterMass)} kg at ${fmtLen(Rcw)}`, 'muted', [0.5, -0.25]));
    cwLabel.position.set(-Rcw, 0, 0);
    this.rotor.add(cwLabel);
    this.fixedLabels.push(cwLabel);
    this.labelTexts.set(cwLabel, { full: cwLabel.element.textContent ?? '', short: 'COUNTERWEIGHT' });
    const armLabel = (this.armLabel = makeLabel(`ARM R = ${fmtLen(R)}`, 'muted', [0.5, -0.5]));
    armLabel.position.set(R * 0.38, 0, 0);
    this.rotor.add(armLabel);
    this.fixedLabels.push(armLabel);
    this.labelTexts.set(armLabel, { full: armLabel.element.textContent ?? '', short: null });
    this.labelTexts.set(this.vehicleLabel, { full: `VEHICLE ${fmtLen(v.length)} · ${fmtInt(sc.derived.wetMass)} kg`, short: 'VEHICLE' });
    this.applyVariantText();

    this.scene.fog = new THREE.Fog(PAL.skyHorizon, Rc * 4, Rc * 14);
    // Keep the user's camera across config edits unless the machine's scale changed a lot.
    if (!(Math.abs(Rc - this.builtRc) <= 0.25 * this.builtRc)) {
      this.builtRc = Rc;
      this.resetPending = true;
    }
  }

  private applyVariantText(): void {
    for (const [l, t] of this.labelTexts) setLabelText(l, this.compact ? t.short ?? t.full : t.full);
  }

  private labelShown(l: CSS2DObject, labelsOn: boolean): boolean {
    const t = this.labelTexts.get(l);
    return labelsOn && !(this.compact && t && t.short === null);
  }

  // ------------------------------------------------------------------ frame
  update(ctx: FrameContext): void {
    const sc = ctx.scenario;
    this.insets = ctx.insets;
    if (ctx.variant !== this.variant) {
      this.variant = ctx.variant;
      styleLights(this.lights, this.variant);
      this.flownTrack.setHalo(this.variant === 'play');
      (this.vehicleGlow.material as THREE.PointsMaterial).size = this.variant === 'play' ? 60 : 42;
    }
    const compact = ctx.variant === 'play' || ctx.width < 640;
    if (compact !== this.compact) {
      this.compact = compact;
      this.applyVariantText();
    }
    if (sc !== this.scenario) {
      this.scenario = sc;
      if (sc) this.build(sc);
    }
    if (this.resetPending) {
      this.resetPending = false;
      this.applyCameraReset();
    }
    if (this.camTween) {
      const tw = this.camTween;
      const u = Math.min(1, this.fxClock.t / tw.dur);
      const e = u * u * (3 - 2 * u);
      this.camera.position.lerpVectors(tw.p0, tw.p1, e);
      this.controls.target.lerpVectors(tw.t0, tw.t1, e);
      if (u >= 1 || !ctx.snap?.failure) this.camTween = null;
    }
    this.controls.enableDamping = !ctx.reducedMotion;
    this.controls.update();
    // Content a little below centre: the banner sits at the top of the view.
    applyFraming(this.camera, this.width, this.height, ctx.insets, 0, TOP_ROOM / 2);
    this.overlay.layout(ctx.insets, ctx.variant);
    this.fx.group.visible = !!sc;
    if (!sc || !this.vehicle) {
      this.machine.visible = false;
      this.overlay.setCaption('LAUNCHER', 'no valid configuration');
      this.overlay.setBanner('Configuration invalid — nothing to draw', 'warn');
      return;
    }
    this.machine.visible = true;
    const snap = ctx.snap;
    const g = sc.geometry;
    const R = g.armRadius;
    const rotating = sc.config.physics.earthRotation;
    this.labels.visible = ctx.overlays.labels;
    for (const l of this.fixedLabels) l.visible = this.labelShown(l, ctx.overlays.labels);

    // Release time = first row of the live flight table.
    const flown = hasTrajectory(ctx.flown) ? ctx.flown : null;
    this.tRelease = flown ? flown.get('t', 0) : NaN;
    const veh = snap?.vehicle;
    const released = !!veh && snap?.rotor.attached === false;
    const omega = snap ? snap.rotor.omega : 0;
    const phase = snap?.phase ?? 'idle';
    const sinceRelease = released && Number.isFinite(this.tRelease) ? snap!.t - this.tRelease : Infinity;
    const truePhaseWindow = phase === 'hold' || phase === 'corridor' || sinceRelease < 0.3;

    // Rotor display angle: a perceptual display spin while the playback is time-lapsed, the true
    // phase (blended in continuously) in hold, the exit corridor and just after release.
    this.spin.update({
      wall: ctx.wall, dtWall: ctx.dtWall, snapT: snap ? snap.t : null, phi: snap ? snap.rotor.phi : Math.PI / 2,
      omega, truePhase: truePhaseWindow, reduced: ctx.reducedMotion,
    });
    let phiDisp = snap ? this.spin.angle : Math.PI / 2;
    let drawnRate = snap ? Math.max(0, this.spin.rate) : 0;
    const fstate = this.fxClock.sync(snap, ctx.dtWall);
    if (fstate === 'start' || fstate === 'reset') this.resetFailure();
    // After a machine failure the display coasts to rest from where it was; failures elsewhere leave the rotor turning.
    const coasting = !!this.fail && !this.fail.rotorFree;
    if (this.fail && coasting) {
      const e = Math.exp(-this.fxClock.t / COAST_TAU);
      phiDisp = this.fail.phi0 + this.fail.omegaEff * COAST_TAU * (1 - e);
      drawnRate = this.fail.omegaEff * e;
    }
    this.rotor.rotation.z = -phiDisp;
    const synthetic = !!snap && this.spin.synthetic && !coasting;
    const ballastGone = released && sc.release.balance.releasesBallast;
    if (this.counterBlock) this.counterBlock.visible = !ballastGone;

    // Vehicle: on the arm, or free (ECI -> ECEF -> launcher local).
    const vm = this.vehicle;
    const vehPos = new THREE.Vector3();
    const vehVelDir = new THREE.Vector3();
    let speed = 0;
    if (released && veh) {
      if (this.vehicleOnArm.parent !== this.scene) this.scene.add(this.vehicleOnArm);
      const ang = snap!.earthAngle;
      const rE = rotZ(veh.r, -ang);
      this.proj.toSceneV(rE, vehPos);
      this.vehicleOnArm.position.copy(vehPos);
      // Attitude: body axes -> ECI -> ECEF -> scene.
      const xb = this.proj.dirToScene(rotZ(qRotate(veh.q, [1, 0, 0]), -ang), new THREE.Vector3());
      const yb = this.proj.dirToScene(rotZ(qRotate(veh.q, [0, 1, 0]), -ang), new THREE.Vector3());
      const zb = new THREE.Vector3().crossVectors(xb, yb);
      const m = new THREE.Matrix4().makeBasis(xb, yb, zb);
      this.vehicleOnArm.quaternion.setFromRotationMatrix(m);
      const om = rotating ? OMEGA_EARTH : 0;
      const vRel: Vec3 = sub(veh.v, [-om * veh.r[1], om * veh.r[0], 0]);
      this.proj.dirToScene(rotZ(vRel, -ang), vehVelDir);
      speed = vehVelDir.length();
      vehVelDir.normalize();
      vm.setAeroshell(veh.aeroshell);
      vm.setHeat(veh.temps[0]);
      vm.setThrust(veh.thrust);
    } else {
      if (this.vehicleOnArm.parent !== this.outerPiece) this.outerPiece.add(this.vehicleOnArm);
      this.vehicleOnArm.position.set(R, 0, 0);
      this.vehicleOnArm.rotation.set(0, 0, -Math.PI / 2);
      vehPos.set(R * Math.cos(phiDisp), -R * Math.sin(phiDisp), 0);
      vehVelDir.set(-Math.sin(phiDisp), -Math.cos(phiDisp), 0);
      speed = omega * R;
      vm.setAeroshell(true);
      vm.setHeat(293);
      vm.setThrust(0);
    }

    // Failure effects (wall clock from the first frame the failure is seen).
    if (fstate === 'start' && snap?.failure) {
      this.beginFailure(ctx, sc, snap, phiDisp, drawnRate, released, vehPos, vehVelDir, speed);
      this.resumeStill = false;
    }
    if (this.fail) this.updateFailure(ctx, sc);
    const fail = this.fail;
    const vehicleLost = !!fail && (fail.vehicleGone || fail.fling !== null);

    // Speed cues, growing with the TRUE rotor speed: swept disc, smear of the arm, trail at the tip.
    this.updateSpeedCues(ctx, sc, snap, phiDisp, drawnRate, released, ballastGone, vehPos, !!fail && !fail.rotorFree);

    // Force overlays (arrows ride on the vehicle; their labels only while it turns slowly enough to read).
    const showForces = ctx.overlays.forces && !!snap && speed > 0.01 && !snap.failure;
    const awayDist = vehPos.length();
    const near = awayDist < g.sEnd + g.chamberRadius * 0.6;
    const slowArm = released || drawnRate < ARROW_SPIN_MAX;
    const armArrows = slowArm || (ctx.variant === 'engineer' && truePhaseWindow);
    this.vArrow.group.visible = showForces && near && armArrows;
    this.aArrow.group.visible = showForces && !released && armArrows;
    this.vLabel.visible = this.vArrow.group.visible && slowArm;
    this.aLabel.visible = this.aArrow.group.visible && slowArm;
    if (this.vArrow.group.visible) {
      const len = R * 0.24, rad = Math.max(0.05, R * 0.0045);
      this.vArrow.set(vehPos, vehVelDir, len, rad);
      this.vLabel.position.copy(vehPos).addScaledVector(vehVelDir, len * 1.04);
      setLabelText(this.vLabel, `v = ${fmtInt(speed)} m/s\n${released ? 'ground-relative' : 'tangential'}`);
      anchorBeyond(vehVelDir, this.vLabel);
    }
    if (this.aArrow.group.visible) {
      const inward = _v.copy(vehPos).multiplyScalar(-1).normalize();
      const len = R * 0.2, rad = Math.max(0.05, R * 0.0045);
      const start = _v2.copy(vehPos);
      this.aArrow.set(start, inward, len, rad);
      this.aLabel.position.copy(vehPos).addScaledVector(inward, len * 1.06);
      setLabelText(this.aLabel, `a = ${fmtInt(snap!.rotor.aRadialG)} g\ncentripetal → hub`);
      anchorBeyond(inward, this.aLabel);
    }

    // Trajectory lines (flown solid, predicted dashed), in the launcher frame.
    const map = (t: Parameters<typeof eciRowsToEcef>[0], a: number, b: number, out: Float64Array): void => eciRowsToEcef(t, a, b, rotating, out);
    this.flownTrack.object.visible = !!flown && released;
    if (flown && released) this.flownTrack.syncTable(flown, map, this.proj);
    const pred = ctx.overlays.predicted && hasTrajectory(ctx.predicted) && !released ? ctx.predicted : null;
    this.predictedTrack.object.visible = !!pred;
    if (pred) this.predictedTrack.syncTable(pred, map, this.proj);

    // Dash scale tied to the camera distance.
    const camDist = this.camera.position.distanceTo(this.controls.target);
    const ppu = pxPerUnit(this.camera, camDist, this.height);
    for (const t of [this.pathCircle, this.corridorLine, this.predictedTrack]) t.setDash(9 / ppu, 7 / ppu);
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = Math.max(camDist * 1.6, g.chamberRadius * 3);
      this.scene.fog.far = this.scene.fog.near * 3.5;
    }

    // Vehicle far away: pointer at the tunnel exit.
    const far = released && !near;
    this.awayLabel.visible = far;
    vm.group.visible = !fail?.vehicleGone;
    if (far && veh) {
      // At the tunnel mouth, on the hub side (the tunnel label sits on the outer side).
      const O = this.proj.toSceneV(g.tunnelOrigin, _v);
      const dir = this.proj.dirToScene(g.tunnelDir, _v2).normalize();
      const pos = this.awayLabel.position.copy(O).addScaledVector(dir, g.sEnd);
      const side = _v3.set(-dir.y, dir.x, 0).normalize();
      if (side.dot(pos) > 0) side.multiplyScalar(-1);
      pos.addScaledVector(side, g.apertureRadius * 3 + g.chamberRadius * 0.03);
      anchorBeyond(side, this.awayLabel, 1.1);
      setLabelText(
        this.awayLabel,
        fail?.vehicleGone ? `vehicle lost at ${fmtKm(veh.altitude)} altitude` : `vehicle ↗ ${fmtKm(veh.altitude)} altitude · ${fmtInt(speed)} m/s\nsee World view`,
      );
    }
    // Labels riding on the rotor are hidden while it turns (a label racing round is unreadable).
    const turning = drawnRate > LABEL_SPIN_MAX;
    this.vehicleLabel.visible = !far && ctx.overlays.labels && !vehicleLost && (released || !turning);
    if (this.cwLabel) this.cwLabel.visible = this.labelShown(this.cwLabel, ctx.overlays.labels) && !ballastGone && !turning;
    if (this.armLabel) this.armLabel.visible = this.labelShown(this.armLabel, ctx.overlays.labels) && !turning;
    this.vehicleGlow.visible = !far && !vehicleLost;
    setDot(this.vehicleGlow, vehPos);
    this.vehicleRing.visible = !far && !vehicleLost;
    setDot(this.vehicleRing, vehPos);
    this.vehicleLabel.position.copy(vehPos);
    const outward = _v.copy(vehPos);
    if (released) outward.copy(vehVelDir).multiplyScalar(-1);
    anchorBeyond(outward.lengthSq() > 0 ? outward.normalize() : outward.set(0, -1, 0), this.vehicleLabel, 1.4);

    this.updateInset(!far && !vehicleLost, vehPos, sc);
    this.updateText(snap, sc, synthetic, drawnRate, released, sinceRelease, ctx.variant);
    this.overlay.setScale(ppu);
  }

  /**
   * Speed cues for the spinning rotor, all scaled by the TRUE speed (tanh(omega / SPIN_REF)):
   * a faint swept disc, fading ghost copies of the arm and counterweight trailing the drawn arm
   * (spread = drawn rate x a ~75 ms exposure), and a bright arc behind the vehicle at the tip.
   * No smear or trail with reduced motion; none while a broken machine coasts down.
   */
  private updateSpeedCues(
    ctx: FrameContext, sc: Scenario, snap: Snapshot | null, phiDisp: number, rate: number, released: boolean, ballastGone: boolean,
    vehPos: THREE.Vector3, broken: boolean,
  ): void {
    const k = snap && !broken ? speedCue(snap.rotor.omega) : 0;
    const cues = k > 0.02;
    this.blurDisc.visible = cues;
    if (this.discMat) this.discMat.opacity = 0.025 + 0.085 * k * k;
    const smear = cues && !ctx.reducedMotion && rate > 0.4;
    // Exposure of the "camera": the smear covers the angle swept in ~80 ms (or one slow frame).
    const spread = Math.min(1.4, rate * Math.max(0.08, Math.min(this.spin.frameTime, 0.25)));
    for (let i = 0; i < this.ghosts.length; i++) {
      const gh = this.ghosts[i];
      gh.group.visible = smear;
      if (!smear) continue;
      gh.group.rotation.z = -(phiDisp - (spread * (i + 1)) / (this.ghosts.length + 1));
      const a = k * 0.4 * Math.pow(1 - (i + 1) / (this.ghosts.length + 1), 1.2);
      gh.line.opacity = a;
      gh.mesh.opacity = ballastGone ? 0 : a * 0.8;
    }
    const sr = this.smearR;
    for (const [st, r1, sign] of [[this.smearV, sr.v, 1], [this.smearC, sr.c, -1]] as const) {
      if (!st) continue;
      st.mesh.visible = smear && !(sign < 0 && ballastGone);
      if (!st.mesh.visible) continue;
      st.set(phiDisp, spread * 1.15, sr.hub, r1, sr.z * 0.5, sign);
      st.material.opacity = 0.3 * k;
    }
    const trail = this.trail;
    if (!trail) return;
    trail.mesh.visible = smear && !released;
    if (!trail.mesh.visible) return;
    const R = sc.geometry.armRadius;
    // Constant-ish on screen: at least ~8 px wide, never thinner than the vehicle.
    const w = Math.max(sc.vehicle.diameter * 1.4, 8 * this.mpp(vehPos));
    trail.set(phiDisp, Math.min(1.7 * Math.PI, rate * 0.2), R - w / 2, R + w / 2, sr.z);
    trail.material.opacity = Math.min(1, 0.3 + 0.8 * k);
  }

  // ------------------------------------------------------------------ failure effects
  private resetFailure(): void {
    // A camera pulled back to show a failure returns to the default framing for the next run.
    if (this.reframed) {
      this.reframed = false;
      this.resetPending = true;
    }
    this.fail = null;
    this.camTween = null;
    this.fx.clear();
    this.fx.collider = null;
    this.fx.group.position.set(0, 0, 0);
    this.fx.group.scale.setScalar(1);
    if (this.outerPiece.parent !== this.rotor) this.rotor.add(this.outerPiece);
    this.outerPiece.position.set(0, 0, 0);
    this.outerPiece.visible = true;
    this.vehicle?.group.scale.set(1, 1, 1);
    this.vehicle?.group.rotation.set(0, 0, 0);
    this.rotor.position.set(0, 0, 0);
    this.rotor.rotation.x = 0;
    this.rotor.rotation.y = 0;
  }

  /** Metres per screen pixel at scene point p. */
  private mpp(p: THREE.Vector3): number {
    return 1 / pxPerUnit(this.camera, Math.max(this.camera.position.distanceTo(p), 1e-3), this.height);
  }

  /** Corners of the vehicle on the arm (rotor coords): what touches the wall first. */
  private vehicleCorners(sc: Scenario): Array<[number, number]> {
    const R = sc.geometry.armRadius, v = sc.vehicle;
    return [[R + v.diameter / 2, v.length / 2], [R + v.diameter / 2, -v.length / 2]];
  }

  private beginFailure(
    ctx: FrameContext, sc: Scenario, snap: Snapshot, phi0: number, drawnRate: number, released: boolean,
    vehPos: THREE.Vector3, vehVelDir: THREE.Vector3, speed: number,
  ): void {
    const kind = String(snap.failure?.kind ?? '');
    const still = ctx.reducedMotion || this.resumeStill;
    const { Rc } = this.dims;
    // A failure away from the machine (in flight, at the exit) leaves the released rotor coasting as drawn.
    const rotorFree = released && !isMachineFailure(kind);
    const fail: LauncherFailure = {
      kind, still, phi0, omegaEff: 0, slow: null, vehicleGone: false, fling: null, jitter: 0, jitterT: 0, crumple: false,
      hubSparksUntil: 0, sparkAcc: 0, pending: [], flightAnchor: null, tumble: false, heatUntil: 0, phaseStart: 0, gD: 0.3 * Rc,
      rotorFree,
    };
    this.fail = fail;
    this.fx.seed(failureSeed(snap));
    this.fx.collider = this.chamberCollider;
    this.fx.restSpeed = 0.03 * Rc;
    const omega = snap.rotor.omega;
    // Without a failure-specific motion the display coasts to rest from the rate it was drawn at.
    fail.omegaEff = still ? 0 : drawnRate;
    if (!released) {
      if (kind === 'structural-limit') return this.beginArmBreak(fail, sc, omega);
      if (kind === 'component-load') return this.beginCrush(fail, sc, omega, vehPos);
      if (kind === 'drive-stall') return this.beginStall(fail);
    }
    if (kind === 'bearing-envelope') return this.beginBearing(fail);
    if (kind === 'drive-stall' || isQuietFailure(kind)) return;
    if (kind === 'exit-collision' && released) return this.beginExitCollision(fail, sc, vehPos, vehVelDir, speed);
    // In flight (or an unknown kind): breakup / dust at the vehicle, one effect unit per screen pixel.
    fail.flightAnchor = vehPos.clone();
    this.fx.collider = null;
    const velDir = vehVelDir.clone();
    const burst = (): void => {
      fail.vehicleGone = released;
      if (kind === 'ground-contact') dustPuff(this.fx, Y_AXIS, still);
      else flightBurst(this.fx, { kind, velDir, down: _v3.set(0, -1, 0), reduced: still, scale: released ? 1 : 0.6 });
    };
    // Vehicle already out of the picture: pull the camera back to show where it breaks up, then play it.
    const delay = released && this.frameFailure(vehPos, ctx, sc) ? 0.9 : 0;
    fail.phaseStart = delay;
    if (still || !released) return burst();
    if (kind === 'unstable-flight') {
      fail.tumble = true;
      fail.pending.push({ at: delay + 0.45, run: burst });
    } else if (kind === 'thermal-envelope') {
      fail.heatUntil = delay + 0.4;
      fail.pending.push({ at: delay + 0.4, run: burst });
    } else if (delay > 0) fail.pending.push({ at: delay, run: burst });
    else burst();
  }

  /**
   * Re-frame the camera on the hub and the vehicle when the vehicle is out of
   * view (same viewing direction). Tweened over 0.9 s (returns true), or cut
   * immediately with reduced motion. No-op when the vehicle is too far away.
   */
  private frameFailure(p: THREE.Vector3, ctx: FrameContext, sc: Scenario): boolean {
    const g = sc.geometry;
    const Rc = g.chamberRadius;
    this.camera.updateMatrixWorld();
    const ndc = _v3.copy(p).project(this.camera);
    const offscreen = Math.abs(ndc.x) > 0.9 || Math.abs(ndc.y) > 0.9 || ndc.z > 1;
    if (!offscreen && p.length() < g.sEnd + Rc * 0.6) return false;
    // Vehicle a little above the centre: room for the debris thrown along its path.
    const target = p.clone().multiplyScalar(0.62);
    const extent = p.length() * 0.62 + Rc * 0.8;
    const halfFov = (this.camera.fov * Math.PI) / 360;
    const { fx, fy } = usableFraction(this.width, this.height, ctx.insets);
    const fit = Math.min(Math.tan(halfFov) * fy, Math.tan(halfFov) * this.camera.aspect * fx);
    const dist = (extent * 1.1) / fit;
    if (!(dist < this.controls.maxDistance * 0.95)) return false;
    const dir = _v4.copy(this.camera.position).sub(this.controls.target).normalize();
    const pos = target.clone().addScaledVector(dir, dist);
    this.reframed = true;
    if (ctx.reducedMotion) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.controls.update();
      return false;
    }
    this.camTween = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pos, t1: target, dur: 0.9 };
    return true;
  }

  /** Static debris resting on the chamber floor (reduced motion / settled state). */
  private floorScatter(count: number, colors: string[], size: number): void {
    const { Rc, D } = this.dims;
    for (let i = 0; i < count; i++) {
      const a = -Math.PI / 2 + (this.fx.random() - 0.5) * 0.9;
      const r = Rc - size * 0.35;
      this.fx.spawnShards({ at: _v3.set(r * Math.cos(a), r * Math.sin(a), (this.fx.random() - 0.5) * D * 0.6), count: 1, size, color: colors, still: true });
    }
  }

  /**
   * Arm overstressed: the outer arm, cradle and vehicle break off at the
   * most-stressed station and fly as one rigid body (CG velocity omega x r_cg,
   * still turning at omega) until a corner meets the chamber wall, where the
   * piece shatters and the fragments skid along the wall.
   */
  private beginArmBreak(fail: LauncherFailure, sc: Scenario, omega: number): void {
    const R = sc.geometry.armRadius;
    const { Rc, xBreak, minW } = this.dims;
    const rcg = xBreak + (R - xBreak) * 0.75;
    const thHit = flingHitAngle(rcg, this.vehicleCorners(sc), Rc * 0.995);
    const w = clamp(thHit / 1.0, 0.12, 3);
    fail.slow = omega > 0 ? omega / w : null;
    fail.jitter = fail.still ? 0 : Math.max(0.04, 0.005 * Rc);
    fail.jitterT = 1.6;
    const mpp = this.mpp(this.controls.target);
    if (fail.still) {
      fail.omegaEff = 0;
      fail.vehicleGone = true;
      this.outerPiece.visible = false;
      this.floorScatter(10, ARM_SHARDS, Math.max(minW * 1.3, 7 * mpp));
      this.floorScatter(8, VEHICLE_SHARDS, Math.max(sc.vehicle.diameter, 7 * mpp));
      return;
    }
    fail.omegaEff = w;
    this.flingPivot.rotation.set(0, 0, -fail.phi0);
    this.flingBody.position.set(rcg, 0, 0);
    this.flingBody.rotation.set(0, 0, 0);
    this.flingBody.add(this.outerPiece);
    this.outerPiece.position.set(-rcg, 0, 0);
    fail.fling = { rcg, omega: w, hit: false };
    // Fracture: sparks and a few chips at the break, carried at the local rim speed.
    const pB = new THREE.Vector3(xBreak, 0, 0).applyAxisAngle(Z_AXIS, -fail.phi0);
    const grav = new THREE.Vector3(0, -fail.gD, 0);
    this.fx.spawnSprite({ at: pB, size: Math.max(minW * 5, 24 * mpp), size1: Math.max(minW * 12, 64 * mpp), life: 0.45, color: '#fff1d0', opacity: 1, kind: 'flash' });
    this.fx.spawnSprite({ at: pB, size: Math.max(minW * 8, 40 * mpp), size1: Math.max(minW * 16, 90 * mpp), life: 0.7, color: '#ff9a3c', opacity: 0.45, kind: 'flash' });
    this.fx.spawnSparks({ at: pB, count: 36, vel: rotorVel(pB, w, new THREE.Vector3()), speed: Math.max(w * xBreak * 0.6, 0.12 * Rc), life: 0.8, streak: 0.1, gravity: grav, glow: 0.45 });
    this.fx.spawnShards({
      at: pB, count: 7, velAt: (p, o) => rotorVel(p, w, o), speed: w * xBreak * 0.2, size: Math.max(minW * 1.1, 6 * mpp), color: ARM_SHARDS,
      collide: true, sparkSpeed: 0.2 * w * R, spin: 10, gravity: grav,
    });
  }

  /** The flung piece reached the wall: shatter it into fragments with its rigid-body velocities. */
  private shatter(fail: LauncherFailure, sc: Scenario, hitLocal: [number, number]): void {
    const fl = fail.fling;
    if (!fl) return;
    fl.hit = true;
    fail.vehicleGone = true;
    const R = sc.geometry.armRadius, v = sc.vehicle;
    const { xBreak, xArmEnd, cradle, minW } = this.dims;
    this.flingPivot.updateMatrixWorld(true);
    const c = this.flingBody.getWorldPosition(new THREE.Vector3());
    const w = fl.omega;
    const vcg = new THREE.Vector3(0, -w * fl.rcg, 0).applyAxisAngle(Z_AXIS, -fail.phi0);
    const velAt = (p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 => out.set(w * (p.y - c.y), -w * (p.x - c.x), 0).add(vcg);
    const local = (x: number, y: number): THREE.Vector3 => this.outerPiece.localToWorld(new THREE.Vector3(x, y, 0));
    this.outerPiece.visible = false;
    const mpp = this.mpp(c);
    const grav = new THREE.Vector3(0, -fail.gD, 0);
    const vTip = w * R;
    const common = { velAt, collide: true, sparkSpeed: 0.15 * vTip, gravity: grav, spin: 9 } as const;
    this.fx.spawnShards({ ...common, at: local(R, -v.length / 2), to: local(R, v.length / 2), count: 22, speed: vTip * 0.1, size: Math.max(v.diameter * 1.1, 7 * mpp), color: VEHICLE_SHARDS });
    this.fx.spawnShards({ ...common, at: local(xBreak, 0), to: local(xArmEnd, 0), count: 24, speed: vTip * 0.06, size: Math.max(minW * 1.3, 7 * mpp), color: ARM_SHARDS });
    this.fx.spawnShards({ ...common, at: local(xArmEnd + cradle / 2, 0), count: 5, speed: vTip * 0.08, size: Math.max(cradle * 0.45, 7.5 * mpp), color: '#5c6b7e' });
    // Impact: flash and a fan of sparks along the wall.
    const pHit = local(hitLocal[0], hitLocal[1]);
    const vHit = velAt(pHit, new THREE.Vector3());
    const radial = new THREE.Vector3(pHit.x, pHit.y, 0).normalize();
    const along = vHit.clone().addScaledVector(radial, -vHit.dot(radial));
    const alongDir = along.lengthSq() > 0 ? along.clone().normalize() : new THREE.Vector3(1, 0, 0);
    this.fx.spawnSprite({ at: pHit, size: Math.max(v.length * 0.5, 22 * mpp), size1: Math.max(v.length * 1.4, 60 * mpp), life: 0.35, color: '#ffe2b0', opacity: 0.95, kind: 'flash' });
    this.fx.spawnSparks({
      at: pHit, count: 64, vel: along.multiplyScalar(0.8), cone: { dir: alongDir, angle: 0.45, speed: vTip * 0.6 }, speed: vTip * 0.15,
      life: 0.8, streak: 0.1, gravity: grav, glow: 0.45,
    });
  }

  /**
   * Payload crushed by the spin load: a flash, the vehicle crumples onto its
   * cradle and comes apart; the pieces leave tangentially (rim speed).
   */
  private beginCrush(fail: LauncherFailure, sc: Scenario, omega: number, vehPos: THREE.Vector3): void {
    const R = sc.geometry.armRadius, v = sc.vehicle;
    const { Rc } = this.dims;
    const d = Math.sqrt(Math.max(Rc * Rc - R * R, (0.1 * Rc) ** 2));
    const w = clamp(d / (0.7 * R), 0.15, 3);
    fail.slow = omega > 0 ? omega / w : null;
    fail.crumple = true;
    fail.omegaEff = fail.still ? 0 : w;
    if (fail.still) return;
    const mpp = this.mpp(vehPos);
    this.fx.spawnSprite({ at: vehPos, size: Math.max(v.length * 0.6, 20 * mpp), size1: Math.max(v.length * 1.6, 56 * mpp), life: 0.3, color: '#fff4dc', opacity: 1, kind: 'flash' });
    this.fx.spawnSprite({ at: vehPos, size: Math.max(v.length, 36 * mpp), size1: Math.max(v.length * 2.6, 90 * mpp), life: 0.55, color: '#ff9a3c', opacity: 0.55, kind: 'flash' });
    fail.pending.push({
      at: 0.18,
      run: () => {
        fail.vehicleGone = true;
        const wNow = w * Math.exp(-0.18 / COAST_TAU);
        const a = this.vehicleOnArm.localToWorld(new THREE.Vector3(-v.length / 2, 0, 0));
        const b = this.vehicleOnArm.localToWorld(new THREE.Vector3(v.length / 2, 0, 0));
        const mid = a.clone().add(b).multiplyScalar(0.5);
        const grav = new THREE.Vector3(0, -fail.gD, 0);
        const m = this.mpp(mid);
        this.fx.spawnShards({
          at: a, to: b, count: 20, velAt: (p, o) => rotorVel(p, wNow, o), speed: wNow * R * 0.22, size: Math.max(v.diameter, 6 * m), color: VEHICLE_SHARDS,
          collide: true, sparkSpeed: 0.15 * wNow * R, spin: 11, gravity: grav,
        });
        this.fx.spawnSparks({ at: mid, count: 26, vel: rotorVel(mid, wNow, new THREE.Vector3()), speed: wNow * R * 0.35, life: 0.45, streak: 0.08, gravity: grav, glow: 0.4 });
      },
    });
  }

  /** Bearing overload right after release: the whole rotor shudders, sparks from the bearing housing. */
  private beginBearing(fail: LauncherFailure): void {
    if (fail.still) return;
    const { Rc, D, hubR } = this.dims;
    fail.jitter = Math.max(0.05, 0.007 * Rc);
    fail.jitterT = 1.6;
    fail.hubSparksUntil = 1.6;
    this.fx.collider = null;
    const u = Math.max(hubR, 14 * this.mpp(this.controls.target));
    this.fx.spawnSprite({ at: new THREE.Vector3(0, 0, -D / 2 + D * 0.16), size: u * 4, size1: u * 6, life: 1.8, color: '#ff7a2a', opacity: 0.75, kind: 'glow' });
  }

  /** Drive too weak: no break-up. The rotor coasts to rest; a faint wisp of smoke and heat at the drive. */
  private beginStall(fail: LauncherFailure): void {
    // The rotor coasts down from the speed it was drawn at (omegaEff set by beginFailure).
    if (fail.still) return;
    const { D, hubR } = this.dims;
    this.fx.collider = null;
    // At the front bearing of the hub (facing the camera); at least a few tens of pixels across.
    const z = D * 0.3;
    const u = Math.max(hubR, 14 * this.mpp(this.controls.target));
    for (let i = 0; i < 6; i++) {
      const r = this.fx.random() - 0.5;
      this.fx.spawnSprite({
        at: new THREE.Vector3(u * r * 0.6, u * 0.5, z), size: u * 0.8, size1: u * 3.2, life: 2.4, color: '#aab3bd', opacity: 0.42, kind: 'puff',
        vel: new THREE.Vector3(u * r * 0.4, u * 0.8, u * 0.2), drag: 0.35, delay: i * 0.4,
      });
    }
    this.fx.spawnSprite({ at: new THREE.Vector3(0, 0, z), size: u * 2, size1: u * 3, life: 3, color: '#ff8a3c', opacity: 0.4, kind: 'glow' });
  }

  /** Vehicle meets the exit port / tunnel wall: sparks where it touches, fragments carried down the tunnel. */
  private beginExitCollision(fail: LauncherFailure, sc: Scenario, vehPos: THREE.Vector3, vehVelDir: THREE.Vector3, speed: number): void {
    const g = sc.geometry, v = sc.vehicle;
    const { Rc } = this.dims;
    const ap = g.apertureRadius;
    const O = this.proj.toSceneV(g.tunnelOrigin, new THREE.Vector3());
    const dir = this.proj.dirToScene(g.tunnelDir, new THREE.Vector3()).normalize();
    const s = _v3.copy(vehPos).sub(O).dot(dir);
    const lat = _v3.copy(vehPos).sub(O).addScaledVector(dir, -s);
    const latDir = new THREE.Vector3();
    if (lat.length() > 0.15 * ap) latDir.copy(lat).normalize();
    else {
      // Centred but pitched: the nose swings into the wall on the side it points to.
      const xb = _v4.set(1, 0, 0).applyQuaternion(this.vehicleOnArm.quaternion);
      latDir.copy(xb).addScaledVector(dir, -xb.dot(dir));
      if (latDir.lengthSq() < 1e-6) latDir.set(-dir.y, dir.x, 0);
      latDir.normalize();
    }
    const C = O.clone().addScaledVector(dir, clamp(s, g.sWall, g.sEnd)).addScaledVector(latDir, ap);
    const tLen = Math.max(g.sEnd - g.sWall, 1);
    const vD = clamp(tLen / 0.9, 3, Rc);
    fail.slow = speed > 0 ? speed / vD : null;
    fail.vehicleGone = true;
    this.fx.collider = null;
    const mpp = this.mpp(C);
    const size = Math.max(v.diameter * 0.9, 7 * mpp);
    const fwd = (vehVelDir.lengthSq() > 0 ? vehVelDir : dir).clone().normalize();
    const xb = new THREE.Vector3(1, 0, 0).applyQuaternion(this.vehicleOnArm.quaternion);
    const a = vehPos.clone().addScaledVector(xb, -v.length / 2), b = vehPos.clone().addScaledVector(xb, v.length / 2);
    if (fail.still) {
      this.fx.spawnShards({ at: C.clone().addScaledVector(latDir, -size), count: 8, spread: Math.max(ap, 6 * mpp), size, color: VEHICLE_SHARDS, still: true });
      return;
    }
    // Slow motion: gravity is negligible on this time scale; fragments carry on out of the tunnel.
    this.fx.spawnSprite({ at: C, size: Math.max(ap * 3, 30 * mpp), size1: Math.max(ap * 8, 80 * mpp), life: 0.4, color: '#fff1d0', opacity: 1, kind: 'flash' });
    this.fx.spawnSprite({ at: C, size: Math.max(ap * 5, 50 * mpp), size1: Math.max(ap * 12, 120 * mpp), life: 0.7, color: '#ff9a3c', opacity: 0.5, kind: 'flash' });
    this.fx.spawnSparks({
      at: C, count: 70, vel: fwd.clone().multiplyScalar(vD * 0.8).addScaledVector(latDir, -vD * 0.2), cone: { dir: fwd, angle: 0.5, speed: vD * 0.7 },
      life: 0.8, streak: 0.1, drag: 0.4, glow: 0.45,
    });
    this.fx.spawnShards({
      at: a, to: b, count: 22, vel: fwd.clone().multiplyScalar(vD * 0.75), speed: vD * 0.22, drag: 0.35, life: 2.4, fade: 0.8, size, color: VEHICLE_SHARDS, spin: 9,
    });
  }

  private updateFailure(ctx: FrameContext, sc: Scenario): void {
    const fail = this.fail;
    if (!fail) return;
    const t = this.fxClock.t;
    const dt = FailureClock.step(ctx.dtWall);
    if (fail.pending.length) {
      const due = fail.pending.filter((p) => p.at <= t);
      if (due.length) {
        fail.pending = fail.pending.filter((p) => p.at > t);
        for (const p of due) p.run();
      }
    }
    // Broken-off piece in flight.
    const fl = fail.fling;
    if (fl && !fl.hit) {
      const th = fl.omega * t;
      this.flingBody.position.set(fl.rcg, -th * fl.rcg, 0);
      this.flingBody.rotation.set(0, 0, -th);
      const lim = this.dims.Rc * 0.995;
      for (const [x, y] of this.vehicleCorners(sc)) {
        if (flungCorner(fl.rcg, x, y, th, _v4).lengthSq() >= lim * lim) {
          this.shatter(fail, sc, [x, y]);
          break;
        }
      }
    }
    if (fail.crumple && this.vehicle) {
      const u = fail.still ? 1 : Math.min(1, t / 0.18);
      this.vehicle.group.scale.set(1 - 0.25 * u, 1 - 0.6 * u, 1 - 0.45 * u);
    }
    // Shudder (unbalanced rotor / failing bearing).
    if (fail.jitter > 0 && t < fail.jitterT && !ctx.reducedMotion) {
      const a = fail.jitter * (1 - t / fail.jitterT) ** 2;
      this.rotor.position.set((Math.random() * 2 - 1) * a, (Math.random() * 2 - 1) * a, 0);
      this.rotor.rotation.x = ((Math.random() * 2 - 1) * a) / this.dims.Rc;
      this.rotor.rotation.y = ((Math.random() * 2 - 1) * a) / this.dims.Rc;
    } else if (this.rotor.position.lengthSq() > 0 || this.rotor.rotation.x !== 0) {
      this.rotor.position.set(0, 0, 0);
      this.rotor.rotation.x = 0;
      this.rotor.rotation.y = 0;
    }
    // Bearing sparks from the housing.
    if (t < fail.hubSparksUntil) {
      const { Rc, D, hubR } = this.dims;
      fail.sparkAcc += dt * 150 * (1 - t / fail.hubSparksUntil);
      const n = Math.floor(fail.sparkAcc);
      if (n > 0) {
        fail.sparkAcc -= n;
        const a = this.fx.random() * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const vs = 0.22 * Rc;
        this.fx.spawnSparks({
          at: _v3.set(hubR * 1.55 * ca, hubR * 1.55 * sa, -D / 2 + D * 0.13), count: n,
          vel: _v4.set(sa * vs + ca * 0.5 * vs, -ca * vs + sa * 0.5 * vs, 0.4 * vs), speed: vs * 0.5, life: 0.65, streak: 0.07,
          gravity: _v2.set(0, -fail.gD, 0), glow: 0.35,
        });
      }
    }
    if (this.vehicle) {
      const tp = t - fail.phaseStart;
      if (fail.tumble && tp >= 0 && !fail.vehicleGone) this.vehicle.group.rotation.set(0, 0, 0.5 * 30 * tp * tp);
      if (tp >= 0 && t < fail.heatUntil) this.vehicle.setHeat(1300 + 1700 * Math.min(1, tp / Math.max(fail.heatUntil - fail.phaseStart, 1e-3)));
    }
    // Flight-scale effects: group at the vehicle, one unit per screen pixel (at least L/40).
    if (fail.flightAnchor) {
      const k = clamp(this.height / 720, 0.7, 1.3);
      this.fx.group.position.copy(fail.flightAnchor);
      this.fx.group.scale.setScalar(Math.max(this.mpp(fail.flightAnchor), sc.vehicle.length / 40) * k);
    }
    this.fx.update(dt);
  }

  private updateText(
    snap: Snapshot | null, sc: Scenario, synthetic: boolean, drawnRate: number, released: boolean, sinceRelease: number, variant: 'engineer' | 'play',
  ): void {
    if (!snap) {
      this.overlay.setCaption('LAUNCHER · cutaway', `at rest · target ${fmtInt(sc.derived.tipSpeed)} m/s tip speed, ${fmtFixed(sc.derived.rpm, 1)} rpm`);
      this.overlay.setBanner(null);
      return;
    }
    const r = snap.rotor;
    const parts = [PHASE_NAME[snap.phase] ?? snap.phase];
    if (snap.phase === 'pumpdown') parts.push(`chamber ${fmtPa(r.pressure)}`);
    parts.push(`${fmtFixed(r.rpm, 1)} rpm`, `tip ${fmtInt(r.tipSpeed)} m/s`, `${fmtInt(r.aRadialG)} g`);
    let detail = parts.join(' · ');
    const slow = this.fail && !this.fail.still ? this.fail.slow : null;
    if (slow && Number.isFinite(slow) && slow > 1.5 && this.fxClock.t < 4) detail += `\nSLOW MOTION · debris shown at ≈ 1/${fmtInt(niceRound(slow))} of real speed`;
    const play = variant === 'play';
    // Honest labelling of the synthetic display spin (the drawn arm turns slower than the real one).
    const spinNote = synthetic && r.omega > 0.05;
    if (spinNote) {
      detail += `\nspin drawn at ${fmtFixed(drawnRate / (2 * Math.PI), 1)} rev/s for the eye · real ${fmtFixed(r.rpm / 60, 1)} rev/s`;
    }
    this.overlay.setCaption('LAUNCHER · cutaway', detail);
    if (snap.failure) {
      // 'play': the game HUD tells the story; the engineer banner stays short.
      this.overlay.setBanner(play ? null : `FAILURE — ${snap.failure.criterion}`, 'warn');
    } else if (released && sinceRelease < 0.3) {
      this.overlay.setBanner(play ? 'RELEASED · true speed, slow motion' : `RELEASED — true phase, t + ${fmtFixed(sinceRelease * 1000, 1)} ms`, 'info');
    } else if (snap.phase === 'hold' || snap.phase === 'corridor') {
      this.overlay.setBanner(play ? `${snap.phase === 'hold' ? 'HOLD' : 'RELEASE'} · true spin, slow motion` : `TRUE PHASE — ${PHASE_NAME[snap.phase]} (playback slowed)`, 'info');
    } else if (spinNote) {
      this.overlay.setBanner(
        play
          ? `spin shown slowed · real ${fmtInt(r.rpm)} rpm`
          : `SPIN SHOWN SLOWED (time-lapse) — real rotor ${fmtInt(r.rpm)} rpm · tip ${fmtInt(r.tipSpeed)} m/s`,
        'note',
      );
    } else {
      this.overlay.setBanner(null);
    }
  }

  dispose(): void {
    this.controls.dispose();
    this.vehicle?.dispose();
    this.fx.dispose();
    for (const t of [this.flownTrack, this.predictedTrack, this.pathCircle, this.releaseArc, this.corridorLine, this.tunnelWallA, this.tunnelWallB]) t.dispose();
    disposeTree(this.scene);
    this.overlay.dispose();
  }
}
