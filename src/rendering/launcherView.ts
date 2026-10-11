/**
 * Launcher view: a legible cutaway of the machine in the launcher-local frame
 * (origin at the hub; scene X = h horizontal launch direction, Y = u up,
 * Z = h x u = -a so the basis is right-handed and the launch direction reads
 * left-to-right from the default camera on the +Z side).
 *
 * Rotor phase: the vehicle sits at R (cos phi h - sin phi u), i.e. the rotor
 * group is rotated by -phi about scene Z. Above ~2 rad/s the true phase
 * cannot be shown honestly at display frame rates, so the rotor is drawn at a
 * clearly labelled stroboscopic angle with a translucent swept disc; true
 * phase returns during hold, the exit corridor and just after release.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Scenario } from '../sim/build';
import { fmtPa, type Snapshot } from '../sim/session';
import { armArea, type ArmGeometry } from '../physics/rotor';
import { OMEGA_EARTH } from '../physics/constants';
import { qRotate } from '../physics/quat';
import { type Vec3, cross, rotZ, sub } from '../physics/vec3';
import { Projection, disposeTree, eciRowsToEcef, hasTrajectory, pxPerUnit } from './projection';
import { Track } from './track';
import { VehicleMesh } from './vehicleMesh';
import { COLORS, Overlay, fmtFixed, fmtInt, fmtKm, fmtLen, makeLabel, setLabelText, niceStep } from './style';
import {
  type FrameContext, type Insets, type Lights, type View, MAIN_ONLY_LAYER, NO_INSETS, addLights, applyFraming, makeGlow, makeRing, setDot, styleLights, usableFraction,
} from './viewBase';

const STROBE_OMEGA = 2; // rad/s
const PHASE_NAME: Record<string, string> = {
  pumpdown: 'PUMP-DOWN', spinup: 'SPIN-UP', hold: 'HOLD (phase lock)', corridor: 'RELEASE · EXIT CORRIDOR', flight: 'FLIGHT', ended: 'ENDED',
};

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

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
  private blurDisc = new THREE.Group();
  private readonly labels = new THREE.Group();
  private readonly flownTrack = new Track({ color: COLORS.flown, width: 2.5, renderOrder: 5 });
  private readonly predictedTrack = new Track({ color: COLORS.predicted, width: 1.8, dashed: true, opacity: 0.9, renderOrder: 4 });
  private readonly pathCircle = new Track({ color: '#6e7681', width: 1, dashed: true, opacity: 0.8 });
  private readonly releaseArc = new Track({ color: COLORS.release, width: 5, renderOrder: 6 });
  private readonly corridorLine = new Track({ color: COLORS.release, width: 1.5, dashed: true, opacity: 0.9 });
  private readonly tunnelWallA = new Track({ color: '#9aa7b8', width: 1.6 });
  private readonly tunnelWallB = new Track({ color: '#9aa7b8', width: 1.6 });
  private readonly vArrow = new Arrow(COLORS.velocity);
  private readonly aArrow = new Arrow(COLORS.accel);
  private readonly vLabel = makeLabel('', 'green', [0, 0.5]);
  private readonly aLabel = makeLabel('', 'violet', [0, 0.5]);
  private readonly vehicleLabel = makeLabel('VEHICLE', 'default', [0, 1.2]);
  private readonly vehicleRing = makeRing(COLORS.flown, 30);
  private readonly awayLabel = makeLabel('', 'amber', [0.5, 1.2]);
  private readonly fixedLabels: CSS2DObject[] = [];
  private ground = new THREE.Group();
  private resetPending = true;
  private height = 1;
  private tRelease = NaN;
  private lights: Lights;
  private variant: 'engineer' | 'play' = 'engineer';
  private insets: Insets = NO_INSETS;
  /** Fixed label texts: full (engineer) and short ('play'; null hides it). */
  private readonly labelTexts = new Map<CSS2DObject, { full: string; short: string | null }>();
  private readonly vehicleGlow = makeGlow(COLORS.flown, 46);
  private width = 1;
  private readonly insetCam = new THREE.PerspectiveCamera(30, 1.5, 0.01, 1e5);
  private readonly insetDiv: HTMLDivElement;
  private readonly insetCaption: HTMLDivElement;
  private insetRect: { x: number; y: number; w: number; h: number } | null = null;

  constructor(dom: HTMLElement, overlayParent: HTMLElement) {
    this.scene.background = new THREE.Color(COLORS.background);
    this.scene.fog = new THREE.Fog(COLORS.background, 200, 800);
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
    this.scene.add(this.vehicleRing, this.vehicleGlow);
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

  private applyCameraReset(): void {
    const sc = this.scenario;
    const Rc = sc ? sc.geometry.chamberRadius : 50;
    const aspect = this.camera.aspect || 1.6;
    const { fx, fy } = usableFraction(this.width, this.height, this.insets);
    const dist = Rc * 3.9 * Math.max(1 / fy, 1.25 / (aspect * fx));
    const az = 0.3, el = 0.2;
    this.controls.target.set(0, Rc * 0.02, 0);
    this.camera.position.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist + Rc * 0.02, Math.cos(az) * Math.cos(el) * dist);
    this.camera.lookAt(this.controls.target);
    this.controls.minDistance = 1;
    this.controls.maxDistance = Rc * 40;
    this.controls.update();
  }

  // ------------------------------------------------------------------ machine
  private build(sc: Scenario): void {
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

    const steel = new THREE.MeshStandardMaterial({ color: '#4a586c', emissive: '#121a24', metalness: 0.45, roughness: 0.6, side: THREE.BackSide });
    const backWallMat = new THREE.MeshStandardMaterial({ color: '#141b25', metalness: 0.3, roughness: 0.85, side: THREE.DoubleSide });
    const cutMat = new THREE.MeshStandardMaterial({ color: '#4a5668', metalness: 0.2, roughness: 0.7, side: THREE.DoubleSide });
    const shellMat = new THREE.MeshStandardMaterial({ color: '#58667a', metalness: 0.4, roughness: 0.6, transparent: true, opacity: 0.12, depthWrite: false });
    const hubMat = new THREE.MeshStandardMaterial({ color: '#8b949e', metalness: 0.7, roughness: 0.35 });
    const armMat = new THREE.MeshStandardMaterial({ color: '#6b7787', metalness: 0.45, roughness: 0.45 });
    const cwMat = new THREE.MeshStandardMaterial({ color: '#9e6a3a', metalness: 0.6, roughness: 0.4 });
    const concrete = new THREE.MeshStandardMaterial({ color: '#2a2f36', metalness: 0.05, roughness: 0.95 });

    // Chamber: back wall, inner rim (visible inner wall), cut section at the front edge, faint outer skin.
    const back = new THREE.Mesh(new THREE.CircleGeometry(Rc, 160), backWallMat);
    back.position.z = -D / 2;
    this.machine.add(back);
    for (const f of [0.25, 0.5, 0.75]) {
      const ring = lineLoop(Rc * f, -D / 2 + 0.02, '#223042');
      this.machine.add(ring);
    }
    const spokes: number[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (2 * Math.PI * i) / 24;
      spokes.push(hubR * 1.6 * Math.cos(a), hubR * 1.6 * Math.sin(a), -D / 2 + 0.02, Rc * Math.cos(a), Rc * Math.sin(a), -D / 2 + 0.02);
    }
    const spokeGeo = new THREE.BufferGeometry();
    spokeGeo.setAttribute('position', new THREE.Float32BufferAttribute(spokes, 3));
    this.machine.add(new THREE.LineSegments(spokeGeo, new THREE.LineBasicMaterial({ color: '#1d2836' })));
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
    this.machine.add(lineLoop(Rc, D / 2 + 0.01, '#9aa7b8', 0.9), lineLoop(Rc + wallT, D / 2 + 0.01, '#9aa7b8', 0.9));
    this.machine.add(lineLoop(Rc, -D / 2 + 0.03, '#56657a', 0.9));

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
    const armV = new THREE.Mesh(taperedBar(armStations(vArm, hubR * 0.9, R - v.diameter / 2 - cradle, minW, minH)), armMat);
    this.rotor.add(armV);
    const Rcw = sc.rotor.counterRadius;
    const cwSize = Math.max(Math.cbrt(sc.derived.counterMass / 7850), 0.03 * R);
    const armC = new THREE.Mesh(taperedBar(armStations(cArm, hubR * 0.9, Math.max(hubR * 1.2, Rcw - cwSize / 2), minW, minH)), armMat);
    armC.rotation.z = Math.PI;
    this.rotor.add(armC);
    const cw = new THREE.Mesh(new THREE.BoxGeometry(cwSize, cwSize * 1.4, cwSize), cwMat);
    cw.position.x = -Rcw;
    this.rotor.add(cw);
    this.counterBlock = cw;
    const mount = new THREE.Mesh(new THREE.BoxGeometry(cradle, Math.max(v.length * 0.45, 0.5), Math.max(minH * 1.6, v.diameter * 1.3)), cwMat.clone());
    (mount.material as THREE.MeshStandardMaterial).color.set('#5c6b7e');
    mount.position.x = R - v.diameter / 2 - cradle / 2;
    this.rotor.add(mount);

    // Vehicle on the arm: nose along the tangential direction (-Y at phase 0).
    this.vehicle = new VehicleMesh(v);
    this.vehicleOnArm.position.set(R, 0, 0);
    this.vehicleOnArm.rotation.z = -Math.PI / 2;
    this.vehicleOnArm.add(this.vehicle.group);
    this.rotor.add(this.vehicleOnArm);
    this.machine.add(this.rotor);

    // Stroboscopic swept disc (not part of the rotating group).
    const discR = Math.max(R + v.length / 2, Rcw + cwSize);
    const disc = new THREE.Mesh(
      new THREE.RingGeometry(hubR, discR, 160, 1),
      new THREE.MeshBasicMaterial({ color: '#9fb3c8', transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }),
    );
    const trail = new THREE.Mesh(
      new THREE.RingGeometry(R - v.diameter, R + v.diameter * 1.5, 192, 1),
      new THREE.MeshBasicMaterial({ color: '#e6edf3', transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }),
    );
    disc.position.z = 0.02;
    trail.position.z = 0.03;
    this.blurDisc.add(disc, trail);
    this.blurDisc.visible = false;
    this.machine.add(this.blurDisc);

    // Exit tunnel: from the aperture in the wall (s = sWall) to sEnd.
    const O = this.proj.toSceneV(g.tunnelOrigin, new THREE.Vector3());
    const dir = this.proj.dirToScene(g.tunnelDir, new THREE.Vector3()).normalize();
    const ap = g.apertureRadius;
    const tLen = g.sEnd - g.sWall;
    const tw = Math.max(0.25, ap * 0.7);
    const tq = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir);
    const mid = O.clone().addScaledVector(dir, (g.sWall + g.sEnd) / 2);
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(ap, ap, tLen, 40, 1, true), new THREE.MeshStandardMaterial({ color: '#334055', metalness: 0.4, roughness: 0.6, side: THREE.BackSide }));
    const outer = new THREE.Mesh(new THREE.CylinderGeometry(ap + tw, ap + tw, tLen, 40, 1, true), new THREE.MeshStandardMaterial({ color: '#7d8a9c', transparent: true, opacity: 0.38, depthWrite: false }));
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
    this.machine.add(ringAt(g.sEnd, ap + tw * 0.5, '#9aa7b8', Math.max(0.03, ap * 0.06)));

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

    // Ground with a subtle grid.
    disposeTree(this.ground);
    this.scene.remove(this.ground);
    this.ground = new THREE.Group();
    const cell = niceStep(Rc / 5);
    const size = cell * 120;
    const groundSize = Math.max(size, Rc * 80);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), new THREE.MeshStandardMaterial({ color: '#0f141b', roughness: 1, metalness: 0 }));
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = yG;
    const minor = new THREE.GridHelper(size, 120, '#18202a', '#18202a');
    minor.position.y = yG + 0.02;
    const major = new THREE.GridHelper(size, 24, '#253141', '#253141');
    major.position.y = yG + 0.04;
    this.ground.add(plane, minor, major);
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
    const relPos = new THREE.Vector3(R * Math.cos(g.phiRelease), -R * Math.sin(g.phiRelease), 0);
    const outward = relPos.x < 0 ? [1.08, 0] as [number, number] : [-0.08, 0] as [number, number];
    addFixed(`RELEASE POINT\nelevation ${fmtFixed((g.elevation * 180) / Math.PI, 0)}°`, 'RELEASE', relPos, 'release', [outward[0], 0.5]);
    const tEnd = O.clone().addScaledVector(dir, g.sEnd + 1.5);
    addFixed(`EXIT TUNNEL ${fmtLen(tLen)}\naperture Ø ${fmtLen(2 * ap)}`, 'EXIT TUNNEL', tEnd, 'muted', [dir.x >= 0 ? 1.08 : -0.08, 0.5]);
    const cwLabel = (this.cwLabel = makeLabel(`COUNTERWEIGHT\n${fmtInt(sc.derived.counterMass)} kg at ${fmtLen(Rcw)}`, 'muted', [0.5, -0.25]));
    cwLabel.position.set(-Rcw, 0, 0);
    this.rotor.add(cwLabel);
    this.fixedLabels.push(cwLabel);
    this.labelTexts.set(cwLabel, { full: cwLabel.element.textContent ?? '', short: 'COUNTERWEIGHT' });
    const armLabel = makeLabel(`ARM R = ${fmtLen(R)}`, 'muted', [0.5, -0.5]);
    armLabel.position.set(R * 0.38, 0, 0);
    this.rotor.add(armLabel);
    this.fixedLabels.push(armLabel);
    this.labelTexts.set(armLabel, { full: armLabel.element.textContent ?? '', short: null });
    this.labelTexts.set(this.vehicleLabel, { full: `VEHICLE ${fmtLen(v.length)} · ${fmtInt(sc.derived.wetMass)} kg`, short: 'VEHICLE' });
    this.applyVariantText();

    this.scene.fog = new THREE.Fog(COLORS.background, Rc * 4, Rc * 14);
    this.resetPending = true;
  }

  private applyVariantText(): void {
    for (const [l, t] of this.labelTexts) setLabelText(l, this.variant === 'play' ? t.short ?? t.full : t.full);
  }

  private labelShown(l: CSS2DObject, labelsOn: boolean): boolean {
    const t = this.labelTexts.get(l);
    return labelsOn && !(this.variant === 'play' && t && t.short === null);
  }

  // ------------------------------------------------------------------ frame
  update(ctx: FrameContext): void {
    const sc = ctx.scenario;
    this.insets = ctx.insets;
    if (ctx.variant !== this.variant) {
      this.variant = ctx.variant;
      styleLights(this.lights, this.variant);
      this.applyVariantText();
      this.flownTrack.setHalo(this.variant === 'play');
    }
    if (sc !== this.scenario) {
      this.scenario = sc;
      if (sc) this.build(sc);
    }
    if (this.resetPending) {
      this.resetPending = false;
      this.applyCameraReset();
    }
    this.controls.enableDamping = !ctx.reducedMotion;
    this.controls.update();
    applyFraming(this.camera, this.width, this.height, ctx.insets);
    this.overlay.layout(ctx.insets, ctx.variant);
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
    const strobe = !!snap && omega > STROBE_OMEGA && !truePhaseWindow;

    // Rotor display angle.
    let phiDisp = snap ? snap.rotor.phi : Math.PI / 2;
    if (strobe) phiDisp = g.phiRelease - Math.PI / 2 + (ctx.reducedMotion ? 0 : 0.12 * ctx.wall);
    this.rotor.rotation.z = -phiDisp;
    this.blurDisc.visible = strobe && !ctx.reducedMotion;
    if (this.blurDisc.visible) {
      const k = Math.min(1, omega / 40);
      ((this.blurDisc.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.06 + 0.08 * k;
      ((this.blurDisc.children[1] as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.14 + 0.18 * k;
    }
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
      if (this.vehicleOnArm.parent !== this.rotor) this.rotor.add(this.vehicleOnArm);
      this.vehicleOnArm.position.set(R, 0, 0);
      this.vehicleOnArm.rotation.set(0, 0, -Math.PI / 2);
      vehPos.set(R * Math.cos(phiDisp), -R * Math.sin(phiDisp), 0);
      vehVelDir.set(-Math.sin(phiDisp), -Math.cos(phiDisp), 0);
      speed = omega * R;
      vm.setAeroshell(true);
      vm.setHeat(293);
      vm.setThrust(0);
    }

    // Force overlays.
    const showForces = ctx.overlays.forces && !!snap && speed > 0.01;
    const awayDist = vehPos.length();
    const near = awayDist < g.sEnd + g.chamberRadius * 0.6;
    this.vArrow.group.visible = showForces && near;
    this.aArrow.group.visible = showForces && !released;
    this.vLabel.visible = this.vArrow.group.visible;
    this.aLabel.visible = this.aArrow.group.visible;
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
    vm.group.visible = true;
    if (far && veh) {
      const O = this.proj.toSceneV(g.tunnelOrigin, _v);
      const dir = this.proj.dirToScene(g.tunnelDir, _v2).normalize();
      this.awayLabel.position.copy(O).addScaledVector(dir, g.sEnd + g.chamberRadius * 0.25);
      setLabelText(this.awayLabel, `vehicle ↗ ${fmtKm(veh.altitude)} altitude · ${fmtInt(speed)} m/s\nsee World view`);
    }
    this.vehicleLabel.visible = !far && ctx.overlays.labels;
    if (this.cwLabel) this.cwLabel.visible = this.labelShown(this.cwLabel, ctx.overlays.labels) && !(released && sc.release.balance.releasesBallast);
    this.vehicleGlow.visible = this.variant === 'play' && !far;
    setDot(this.vehicleGlow, vehPos);
    this.vehicleRing.visible = !far;
    setDot(this.vehicleRing, vehPos);
    this.vehicleLabel.position.copy(vehPos);
    const outward = _v.copy(vehPos);
    if (released) outward.copy(vehVelDir).multiplyScalar(-1);
    anchorBeyond(outward.lengthSq() > 0 ? outward.normalize() : outward.set(0, -1, 0), this.vehicleLabel, 1.4);

    this.updateInset(!far, vehPos, sc);
    this.updateText(snap, sc, strobe, released, sinceRelease);
    this.overlay.setScale(ppu);
  }

  private updateText(snap: Snapshot | null, sc: Scenario, strobe: boolean, released: boolean, sinceRelease: number): void {
    if (!snap) {
      this.overlay.setCaption('LAUNCHER · cutaway', `at rest · target ${fmtInt(sc.derived.tipSpeed)} m/s tip speed, ${fmtFixed(sc.derived.rpm, 1)} rpm`);
      this.overlay.setBanner(null);
      return;
    }
    const r = snap.rotor;
    const parts = [PHASE_NAME[snap.phase] ?? snap.phase];
    if (snap.phase === 'pumpdown') parts.push(`chamber ${fmtPa(r.pressure)}`);
    parts.push(`${fmtFixed(r.rpm, 1)} rpm`, `tip ${fmtInt(r.tipSpeed)} m/s`, `${fmtInt(r.aRadialG)} g`);
    this.overlay.setCaption('LAUNCHER · cutaway', parts.join(' · '));
    if (snap.failure) {
      this.overlay.setBanner(`FAILURE — ${snap.failure.criterion}: ${snap.failure.message}`, 'warn');
    } else if (strobe) {
      this.overlay.setBanner(
        `STROBOSCOPIC VIEW — actual rotor ${fmtFixed(r.rpm, 1)} rpm (ω ${fmtFixed(r.omega, 1)} rad/s)\narm drawn at strobe flashes; it is not slowing down`,
        'strobe',
      );
    } else if (released && sinceRelease < 0.3) {
      this.overlay.setBanner(`RELEASED — true phase, t + ${fmtFixed(sinceRelease * 1000, 1)} ms`, 'info');
    } else if (snap.phase === 'hold' || snap.phase === 'corridor') {
      this.overlay.setBanner(`TRUE PHASE — ${PHASE_NAME[snap.phase]} (playback slowed)`, 'info');
    } else {
      this.overlay.setBanner(null);
    }
  }

  dispose(): void {
    this.controls.dispose();
    this.vehicle?.dispose();
    for (const t of [this.flownTrack, this.predictedTrack, this.pathCircle, this.releaseArc, this.corridorLine, this.tunnelWallA, this.tunnelWallB]) t.dispose();
    disposeTree(this.scene);
    this.overlay.dispose();
  }
}
