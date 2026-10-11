/**
 * Orbital view: inertial (ECI) scene in kilometres, Earth rotated by the
 * Earth angle, flown path (solid, past), predicted path (dashed, future),
 * the osculating conic of the current state (thin dashed; continues to the
 * surface when Earth-intersecting), apsis markers, the orbital plane, the
 * mission orbit band and a plain-language status of what the trajectory is.
 *
 * Scene axes: X = ECI x, Y = ECI z (north pole up), Z = -ECI y.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Scenario } from '../sim/build';
import type { TelemetryTable } from '../sim/telemetry';
import { R_EARTH } from '../physics/constants';
import { conicSamples, orbitalElements, type OrbitElements } from '../physics/orbit';
import { type Vec3, cross, norm, normalize, rotZ, scale } from '../physics/vec3';
import { Projection, disposeTree, eciRows, hasTrajectory, pxPerUnit } from './projection';
import { Track, type RowMapper } from './track';
import { createEarthGeometry, createEarthMaterial, createShellMaterial, setGraticule } from './earth';
import { COLORS, Overlay, type BannerVariant, fmtInt, fmtKm, makeLabel, setLabelText } from './style';
import { type FrameContext, type View, makeDot, makeRing, setDot } from './viewBase';
import { maxRow } from './worldView';

const KM = 1e-3;
const _v = new THREE.Vector3();
const Z_AXIS = new THREE.Vector3(0, 0, 1);

/** Plain-language status of a trajectory from its osculating elements. */
export function orbitStatus(el: OrbitElements | null, altNow: number | null): { text: string; variant: BannerVariant } {
  if (!el) return { text: 'No trajectory yet', variant: 'default' };
  const km = (m: number): string => fmtInt(m / 1000);
  if (!el.bound) return { text: `Escape trajectory (${el.kind}) — unbound, will not return`, variant: 'info' };
  if (el.intersectsEarth) {
    if (altNow !== null && altNow >= 100_000) return { text: 'Above 100 km; Earth-intersecting trajectory (not an orbit)', variant: 'info' };
    return { text: `Suborbital: apoapsis ${km(el.apoapsisAltitude)} km; Earth-intersecting trajectory`, variant: 'info' };
  }
  const decay = el.periapsisAltitude < 120_000 ? ' — periapsis inside the atmosphere: orbit decays' : '';
  return { text: `Bound orbit ${km(el.periapsisAltitude)} × ${km(el.apoapsisAltitude)} km${decay}`, variant: decay ? 'warn' : 'ok' };
}

export class OrbitView implements View {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private readonly overlay: Overlay;
  private readonly proj = new Projection();
  private readonly earthMat = createEarthMaterial(0.35);
  private readonly earth: THREE.Mesh;
  private readonly shell: THREE.Mesh;
  private readonly labels = new THREE.Group();
  private readonly siteDot = makeDot('#e6edf3', 6);
  private readonly siteLabel = makeLabel('site', 'muted', [-0.1, 0.5]);
  private readonly flownTrack = new Track({ color: COLORS.flown, width: 2.6, renderOrder: 6 });
  private readonly predictedTrack = new Track({ color: COLORS.predicted, width: 2, dashed: true, opacity: 0.95, renderOrder: 5 });
  private readonly conicTrack = new Track({ color: COLORS.conic, width: 1.4, dashed: true, opacity: 0.75, renderOrder: 4 });
  private readonly ghostTracks = new Map<TelemetryTable, { track: Track; seen: boolean }>();
  private readonly apDot = makeDot('#f2cc60', 8);
  private readonly peDot = makeDot('#f2cc60', 8);
  private readonly apLabel = makeLabel('', 'release', [0.5, 1.3]);
  private readonly peLabel = makeLabel('', 'release', [0.5, 1.3]);
  private readonly plane: THREE.Mesh;
  private readonly bandFill: THREE.Mesh;
  private readonly bandInner = new Track({ color: COLORS.band, width: 1.4, opacity: 0.9 });
  private readonly bandOuter = new Track({ color: COLORS.band, width: 1.4, opacity: 0.9 });
  private readonly bandLabel = makeLabel('', 'band', [0, 0.5]);
  private readonly vehicleDot = makeDot(COLORS.flown, 8);
  private readonly vehicleLabel = makeLabel('', 'amber', [-0.1, 1.1]);
  private readonly cursorRing = makeRing('#ffffff', 14);
  private conicKey = '';
  private bandKey = '';
  private resetPending = true;
  private scenario: Scenario | null = null;
  private width = 1;
  private height = 1;

  constructor(dom: HTMLElement, overlayParent: HTMLElement) {
    this.scene.background = new THREE.Color(COLORS.background);
    this.camera = new THREE.PerspectiveCamera(40, 1, 1, 1e7);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enabled = false;
    this.controls.enablePan = false;
    this.controls.minDistance = R_EARTH * KM * 1.03;
    this.controls.maxDistance = 400_000;
    this.overlay = new Overlay(overlayParent);
    this.proj.setBasis([1, 0, 0], [0, 0, 1], [0, -1, 0]);
    this.proj.setScale(KM);
    this.earth = new THREE.Mesh(createEarthGeometry(R_EARTH, 256, 128), this.earthMat);
    this.shell = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH + 100_000, 128, 64), createShellMaterial(COLORS.karman, 0.25));
    this.shell.renderOrder = 2;
    this.plane = new THREE.Mesh(
      new THREE.CircleGeometry(1, 128),
      new THREE.MeshBasicMaterial({ color: '#8fb4ff', transparent: true, opacity: 0.035, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.plane.renderOrder = 1;
    this.bandFill = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1, 192, 1),
      new THREE.MeshBasicMaterial({ color: COLORS.band, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.bandFill.renderOrder = 1;
    this.scene.add(this.earth, this.shell, this.plane, this.bandFill);
    this.scene.add(this.flownTrack.object, this.predictedTrack.object, this.conicTrack.object, this.bandInner.object, this.bandOuter.object);
    this.scene.add(this.siteDot, this.apDot, this.peDot, this.vehicleDot, this.cursorRing);
    this.labels.add(this.siteLabel, this.apLabel, this.peLabel, this.bandLabel, this.vehicleLabel);
    this.scene.add(this.labels);
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
    this.width = w;
    this.height = h;
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
    for (const t of this.allTracks()) t.setResolution(w, h);
  }

  private allTracks(): Track[] {
    return [this.flownTrack, this.predictedTrack, this.conicTrack, this.bandInner, this.bandOuter, ...[...this.ghostTracks.values()].map((g) => g.track)];
  }

  resetCamera(): void {
    this.resetPending = true;
  }

  /** State the conic is drawn from: live vehicle, else the prediction at its highest point. */
  private conicState(ctx: FrameContext): { r: Vec3; v: Vec3; el: OrbitElements; live: boolean } | null {
    const veh = ctx.snap?.vehicle;
    if (veh) return { r: veh.r, v: veh.v, el: veh.orbit, live: true };
    const p = ctx.predicted;
    if (hasTrajectory(p) && 'vx' in p.index && 'alt' in p.index) {
      const row = maxRow(p, 'alt');
      if (row >= 0) {
        const r: Vec3 = [p.get('x', row), p.get('y', row), p.get('z', row)];
        const v: Vec3 = [p.get('vx', row), p.get('vy', row), p.get('vz', row)];
        return { r, v, el: orbitalElements(r, v), live: false };
      }
    }
    return null;
  }

  private applyCameraReset(ctx: FrameContext, st: { r: Vec3; el: OrbitElements } | null): void {
    let rFit = R_EARTH * 1.15;
    let n: Vec3 = [0, 0, 1];
    let m: Vec3 = [1, 0, 0];
    if (st) {
      const el = st.el;
      rFit = Math.max(rFit, Math.min(el.bound ? el.apoapsisRadius : norm(st.r) * 1.5, 6 * R_EARTH));
      if (el.angularMomentum > 0) n = normalize(el.hVector);
      m = normalize(st.r);
    } else if (ctx.scenario) {
      m = normalize(rotZ(ctx.scenario.geometry.hubEcef, ctx.snap?.earthAngle ?? 0));
      n = [0, 0, 1];
    }
    const nS = this.proj.dirToScene(n, new THREE.Vector3());
    if (nS.y < 0) nS.multiplyScalar(-1);
    const mS = this.proj.dirToScene(m, new THREE.Vector3());
    mS.addScaledVector(nS, -mS.dot(nS));
    if (mS.lengthSq() < 1e-8) mS.set(1, 0, 0);
    mS.normalize();
    const tilt = (52 * Math.PI) / 180;
    const dir = nS.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(mS, Math.sin(tilt)).normalize();
    const halfFov = (this.camera.fov * Math.PI) / 360;
    const fit = Math.min(Math.tan(halfFov), Math.tan(halfFov) * this.camera.aspect);
    const d = (1.08 * rFit * KM) / fit;
    this.controls.target.set(0, 0, 0);
    this.camera.position.copy(dir).multiplyScalar(d);
    this.camera.lookAt(0, 0, 0);
    this.controls.update();
  }

  update(ctx: FrameContext): void {
    const sc = ctx.scenario;
    if (sc !== this.scenario) this.scenario = sc;
    const snap = ctx.snap;
    const ang = snap?.earthAngle ?? 0;
    const st = this.conicState(ctx);
    if (this.resetPending) {
      this.resetPending = false;
      this.applyCameraReset(ctx, st);
    }
    this.controls.enableDamping = !ctx.reducedMotion;
    this.controls.update();
    const camDist = this.camera.position.length();
    this.camera.near = Math.max(1, (camDist - R_EARTH * KM * 1.2) * 0.01);
    this.camera.far = camDist * 10 + 1e5;
    this.camera.updateProjectionMatrix();
    const ppu = pxPerUnit(this.camera, camDist, this.height);

    // Earth rotated by the Earth angle (ECEF -> ECI is rotZ(+angle)).
    this.proj.place(this.earth, [0, 0, 0], new THREE.Quaternion().setFromAxisAngle(Z_AXIS, ang));
    setGraticule(this.earthMat, camDist / KM - R_EARTH);
    this.proj.place(this.shell, [0, 0, 0]);
    this.shell.visible = ctx.overlays.atmosphere;

    if (sc) {
      const site = rotZ(sc.geometry.hubEcef, ang);
      this.proj.toSceneV(site, _v);
      setDot(this.siteDot, _v);
      this.siteLabel.position.copy(_v);
    }
    this.siteDot.visible = !!sc;
    this.siteLabel.visible = !!sc && ctx.overlays.labels;

    // Paths.
    const map: RowMapper = (t, a, b, out) => eciRows(t, a, b, out);
    const flown = hasTrajectory(ctx.flown) ? ctx.flown : null;
    this.flownTrack.object.visible = !!flown;
    this.flownTrack.syncTable(flown, map, this.proj);
    const pred = ctx.overlays.predicted && hasTrajectory(ctx.predicted) ? ctx.predicted : null;
    this.predictedTrack.object.visible = !!pred;
    this.predictedTrack.syncTable(pred, map, this.proj);
    this.predictedTrack.setDash(12 / ppu, 8 / ppu);
    this.updateGhosts(ctx, map);

    // Osculating conic + apsides + plane + mission band.
    this.updateConic(st, ppu, ctx);

    // Vehicle.
    const veh = snap?.vehicle;
    this.vehicleDot.visible = !!veh;
    this.vehicleLabel.visible = !!veh && ctx.overlays.labels;
    if (veh) {
      this.proj.toSceneV(veh.r, _v);
      setDot(this.vehicleDot, _v);
      this.vehicleLabel.position.copy(_v);
      setLabelText(this.vehicleLabel, `vehicle ${fmtKm(veh.altitude)}\n${fmtInt(veh.vInertial)} m/s inertial${veh.thrust > 0 ? ' · ENGINE ON' : ''}`);
    }

    // Time cursor.
    const tc = ctx.source.cursorTime();
    let ct: TelemetryTable | null = null;
    if (tc !== null && Number.isFinite(tc)) ct = flown && tc >= flown.get('t', 0) && tc <= flown.lastTime() ? flown : hasTrajectory(ctx.predicted) ? ctx.predicted : flown;
    this.cursorRing.visible = !!ct;
    if (ct && tc !== null) {
      const row = ct.rowAt(tc);
      this.proj.toScene(ct.get('x', row), ct.get('y', row), ct.get('z', row), _v);
      setDot(this.cursorRing, _v);
    }

    const status = orbitStatus(st?.el ?? null, veh ? veh.altitude : null);
    const source = st ? (st.live ? 'osculating elements of the current state' : 'from the prediction at its highest point') : '';
    this.overlay.setCaption('ORBIT · inertial frame (ECI)', `${source}${source ? ' · ' : ''}camera ${fmtKm(camDist / KM - R_EARTH)} above surface`);
    if (snap?.failure) this.overlay.setBanner(`FAILURE — ${snap.failure.criterion}: ${snap.failure.message}`, 'warn');
    else this.overlay.setBanner(status.text, status.variant);
    this.overlay.setScale(null);
  }

  private updateGhosts(ctx: FrameContext, map: RowMapper): void {
    for (const g of this.ghostTracks.values()) g.seen = false;
    for (const gh of ctx.source.ghosts()) {
      if (!hasTrajectory(gh.table)) continue;
      let e = this.ghostTracks.get(gh.table);
      if (!e) {
        const track = new Track({ color: gh.color, width: 1.4, opacity: 0.7, renderOrder: 3 });
        track.setResolution(this.width, this.height);
        e = { track, seen: true };
        this.ghostTracks.set(gh.table, e);
        this.scene.add(track.object);
      }
      e.seen = true;
      e.track.object.visible = ctx.overlays.ghosts;
      if (ctx.overlays.ghosts) e.track.syncTable(gh.table, map, this.proj);
    }
    for (const [k, e] of this.ghostTracks) {
      if (e.seen) continue;
      this.scene.remove(e.track.object);
      e.track.dispose();
      this.ghostTracks.delete(k);
    }
  }

  private updateConic(st: { r: Vec3; v: Vec3; el: OrbitElements; live: boolean } | null, ppu: number, ctx: FrameContext): void {
    const showLabels = ctx.overlays.labels;
    if (!st) {
      this.conicTrack.object.visible = false;
      this.apDot.visible = this.peDot.visible = this.apLabel.visible = this.peLabel.visible = false;
      this.plane.visible = this.bandFill.visible = this.bandInner.object.visible = this.bandOuter.object.visible = this.bandLabel.visible = false;
      return;
    }
    const el = st.el;
    const key = `${st.r.join(',')}|${st.v.join(',')}`;
    if (key !== this.conicKey) {
      this.conicKey = key;
      const { points } = conicSamples(st.r, st.v, 720, 6 * R_EARTH);
      this.conicTrack.setPoints(points, this.proj);
    } else this.conicTrack.reproject(this.proj);
    this.conicTrack.object.visible = true;
    this.conicTrack.setDash(7 / ppu, 6 / ppu);

    const hasPlane = el.kind !== 'radial' && el.angularMomentum > 0;
    const hHat = hasPlane ? normalize(el.hVector) : ([0, 0, 1] as Vec3);
    const P: Vec3 = el.eccentricity > 1e-9 ? normalize(el.eVector) : normalize(st.r);
    const Q = cross(hHat, P);

    // Apsides.
    const showAp = el.bound && el.apoapsisRadius < 20 * R_EARTH && hasPlane;
    this.apDot.visible = showAp;
    this.apLabel.visible = showAp && showLabels;
    if (showAp) {
      this.proj.toSceneV(scale(P, -el.apoapsisRadius), _v);
      setDot(this.apDot, _v);
      this.apLabel.position.copy(_v);
      setLabelText(this.apLabel, `apoapsis ${fmtKm(el.apoapsisAltitude)}`);
    }
    const showPe = hasPlane && el.periapsisAltitude > 0 && el.eccentricity > 1e-6;
    this.peDot.visible = showPe;
    this.peLabel.visible = showPe && showLabels;
    if (showPe) {
      this.proj.toSceneV(scale(P, el.periapsisRadius), _v);
      setDot(this.peDot, _v);
      this.peLabel.position.copy(_v);
      setLabelText(this.peLabel, `periapsis ${fmtKm(el.periapsisAltitude)}`);
    }

    // Orbital plane (faint disc).
    this.plane.visible = hasPlane;
    const nS = this.proj.dirToScene(hHat, new THREE.Vector3()).normalize();
    const planeQ = new THREE.Quaternion().setFromUnitVectors(Z_AXIS, nS);
    if (hasPlane) {
      const rDisc = Math.min(Math.max(el.bound ? el.apoapsisRadius : norm(st.r), R_EARTH) * 1.3, 4 * R_EARTH);
      this.plane.position.set(0, 0, 0);
      this.plane.quaternion.copy(planeQ);
      this.plane.scale.setScalar(rDisc * KM);
    }

    // Mission orbit band in the current plane.
    const band = ctx.source.orbitBand();
    const showBand = !!band && hasPlane;
    this.bandFill.visible = this.bandInner.object.visible = this.bandOuter.object.visible = showBand;
    this.bandLabel.visible = showBand && showLabels;
    if (band && showBand) {
      const r0 = R_EARTH + band.periapsisMin, r1 = R_EARTH + band.apoapsisMax;
      const bkey = `${r0}|${r1}|${hHat.join(',')}`;
      const circle = (r: number): Vec3[] => {
        const pts: Vec3[] = [];
        for (let i = 0; i <= 256; i++) {
          const a = (2 * Math.PI * i) / 256;
          pts.push([r * (Math.cos(a) * P[0] + Math.sin(a) * Q[0]), r * (Math.cos(a) * P[1] + Math.sin(a) * Q[1]), r * (Math.cos(a) * P[2] + Math.sin(a) * Q[2])]);
        }
        return pts;
      };
      if (bkey !== this.bandKey) {
        this.bandKey = bkey;
        this.bandInner.setPoints(circle(r0), this.proj);
        this.bandOuter.setPoints(circle(r1), this.proj);
        const g = new THREE.RingGeometry(r0 / r1, 1, 256, 1);
        this.bandFill.geometry.dispose();
        this.bandFill.geometry = g;
      } else {
        this.bandInner.reproject(this.proj);
        this.bandOuter.reproject(this.proj);
      }
      this.bandFill.quaternion.copy(planeQ);
      this.bandFill.scale.setScalar(r1 * KM);
      const a = Math.PI * 0.5;
      this.proj.toSceneV(
        [r1 * (Math.cos(a) * P[0] + Math.sin(a) * Q[0]), r1 * (Math.cos(a) * P[1] + Math.sin(a) * Q[1]), r1 * (Math.cos(a) * P[2] + Math.sin(a) * Q[2])],
        this.bandLabel.position,
      );
      setLabelText(this.bandLabel, `MISSION BAND\nperiapsis ≥ ${fmtKm(band.periapsisMin)}, apoapsis ≤ ${fmtKm(band.apoapsisMax)}`);
    }
  }

  dispose(): void {
    this.controls.dispose();
    for (const t of this.allTracks()) t.dispose();
    disposeTree(this.scene);
    this.earthMat.dispose();
    this.overlay.dispose();
  }
}
