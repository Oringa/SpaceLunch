/**
 * World view: an Earth-fixed (ECEF) scene for watching the launch from afar.
 *
 * Scene axes are the site's launch basis (X = h downrange, Y = local up,
 * Z = h x u) so OrbitControls' "up" is the local vertical; scene units are
 * kilometres. All geometry is projected camera-relative from double-precision
 * ECEF metres, and the render origin is rebased onto the follow target
 * (vehicle when a run is live, otherwise the launch site) when it drifts far
 * relative to the camera distance, so the same scene works from a 50 m
 * close-up of the vehicle to the whole globe.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Scenario } from '../sim/build';
import type { Snapshot } from '../sim/session';
import type { TelemetryTable } from '../sim/telemetry';
import { R_EARTH, OMEGA_EARTH } from '../physics/constants';
import { qRotate } from '../physics/quat';
import { type Vec3, add, cross, dot, norm, normalize, rotZ, scale, sub } from '../physics/vec3';
import { Projection, disposeTree, eciRowsToEcef, hasTrajectory, pxPerUnit } from './projection';
import { Track, type RowMapper } from './track';
import { VehicleMesh } from './vehicleMesh';
import { capAnchor, createEarthGeometry, createEarthMaterial, createShellMaterial, createSiteCap, setGraticule } from './earth';
import { COLORS, Overlay, fmtFixed, fmtInt, fmtKm, makeLabel, niceStep, setLabelText } from './style';
import { type FrameContext, type View, addLights, makeDot, makeRing, setDot } from './viewBase';

const KM = 1e-3; // scene units per metre
const SHELLS: Array<{ alt: number; label: string; color: string; strength: number }> = [
  { alt: 11_000, label: '11 km · tropopause', color: COLORS.shell, strength: 0.07 },
  { alt: 50_000, label: '50 km · stratopause', color: COLORS.shell, strength: 0.07 },
  { alt: 86_000, label: '86 km · mesopause', color: COLORS.shell, strength: 0.08 },
  { alt: 100_000, label: '100 km · Kármán line', color: COLORS.karman, strength: 0.12 },
];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

interface GhostEntry {
  track: Track;
  label: CSS2DObject;
  seen: boolean;
  apoRow: number;
  apoLen: number;
}

export class WorldView implements View {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  private readonly overlay: Overlay;
  private readonly proj = new Projection();
  private readonly earthMat = createEarthMaterial(0.08);
  private readonly earth: THREE.Mesh;
  private cap: THREE.Mesh | null = null;
  private readonly shells: THREE.Mesh[] = [];
  private readonly arcs: Track[] = [];
  private readonly arcLabels: CSS2DObject[] = [];
  private readonly atmo = new THREE.Group();
  private readonly labels = new THREE.Group();
  private readonly site = new THREE.Group();
  private readonly siteDot = makeDot('#e6edf3', 7);
  private readonly siteLabel = makeLabel('LAUNCH SITE', 'default', [-0.06, 1.1]);
  private facility = new THREE.Group();
  private readonly flownTrack = new Track({ color: COLORS.flown, width: 2.6, renderOrder: 6 });
  private readonly predictedTrack = new Track({ color: COLORS.predicted, width: 2, dashed: true, opacity: 0.95, renderOrder: 5 });
  private readonly ghosts = new Map<TelemetryTable, GhostEntry>();
  private readonly apoDot = makeDot(COLORS.predicted, 7);
  private readonly apoLabel = makeLabel('', 'cyan', [0.5, 1.35]);
  private apoCache: { table: TelemetryTable | null; len: number; row: number } = { table: null, len: 0, row: -1 };
  private vehicle: VehicleMesh | null = null;
  private readonly vehicleHolder = new THREE.Group();
  private readonly vehicleDot = makeRing(COLORS.flown, 22);
  private readonly vehicleLabel = makeLabel('', 'amber', [-0.08, 1.15]);
  private readonly cursorRing = makeRing('#ffffff', 16);
  private scenario: Scenario | null = null;
  private siteKey = '';
  private siteGround: Vec3 = [R_EARTH, 0, 0];
  private siteUp: Vec3 = [1, 0, 0];
  private launchH: Vec3 = [0, 1, 0];
  private arcRange = { a0: NaN, a1: NaN };
  private resetPending = true;
  private width = 1;
  private height = 1;
  private following: 'vehicle' | 'site' = 'site';

  constructor(dom: HTMLElement, overlayParent: HTMLElement) {
    this.scene.background = new THREE.Color(COLORS.background);
    this.camera = new THREE.PerspectiveCamera(45, 1, 1e-5, 1e7);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enabled = false;
    this.controls.enablePan = false;
    this.controls.minDistance = 0.05; // 50 m
    this.controls.maxDistance = 60_000; // 60,000 km
    this.controls.zoomSpeed = 1.3;
    this.overlay = new Overlay(overlayParent);
    this.proj.setScale(KM);
    addLights(this.scene, new THREE.Vector3(0.3, 0.9, 0.5));

    this.earth = new THREE.Mesh(createEarthGeometry(R_EARTH - 150), this.earthMat);
    this.scene.add(this.earth);
    for (const s of SHELLS) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH + s.alt, 192, 96), createShellMaterial(s.color, s.strength));
      m.renderOrder = 2;
      this.shells.push(m);
      this.atmo.add(m);
      const arc = new Track({ color: s.alt === 100_000 ? '#a9c4ff' : '#7fa3dc', width: s.alt === 100_000 ? 1.8 : 1.3, opacity: s.alt === 100_000 ? 0.95 : 0.8, renderOrder: 3 });
      this.arcs.push(arc);
      this.atmo.add(arc.object);
      const l = makeLabel(s.label, 'blue', [1.04, 0.5]);
      this.arcLabels.push(l);
      this.atmo.add(l);
    }
    this.scene.add(this.atmo);
    this.site.add(this.siteDot, this.siteLabel);
    this.scene.add(this.site);
    this.scene.add(this.flownTrack.object, this.predictedTrack.object);
    this.scene.add(this.apoDot, this.vehicleHolder, this.vehicleDot, this.cursorRing);
    this.labels.add(this.apoLabel, this.vehicleLabel);
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
    // Shift the principal point down so the follow target sits low in the frame (the arc rises above it).
    this.camera.setViewOffset(w, h, 0, -Math.round(h * 0.18), w, h);
    this.camera.updateProjectionMatrix();
    for (const t of this.allTracks()) t.setResolution(w, h);
  }

  private allTracks(): Track[] {
    return [this.flownTrack, this.predictedTrack, ...this.arcs, ...[...this.ghosts.values()].map((g) => g.track)];
  }

  resetCamera(): void {
    this.resetPending = true;
  }

  // ------------------------------------------------------------------ site
  private rebuildSite(sc: Scenario): void {
    const g = sc.geometry;
    this.siteUp = normalize(g.hubEcef);
    this.siteGround = scale(this.siteUp, R_EARTH + g.siteAltitude);
    this.launchH = g.h;
    this.proj.setBasis(g.h, g.u, cross(g.h, g.u));
    this.proj.setOrigin(g.hubEcef);
    if (this.cap) {
      this.scene.remove(this.cap);
      this.cap.geometry.dispose();
    }
    this.cap = new THREE.Mesh(createSiteCap(this.siteUp, g.siteAltitude), this.earthMat);
    this.scene.add(this.cap);
    // Facility: chamber disc and exit tunnel, drawn in the rotor plane at the hub.
    disposeTree(this.facility);
    this.site.remove(this.facility);
    this.facility = new THREE.Group();
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(g.chamberRadius, 96),
      new THREE.MeshStandardMaterial({ color: '#4a5668', metalness: 0.4, roughness: 0.6, side: THREE.DoubleSide }),
    );
    this.facility.add(disc);
    const t0 = add(g.tunnelOrigin, scale(g.tunnelDir, g.sWall)), t1 = add(g.tunnelOrigin, scale(g.tunnelDir, g.sEnd));
    const lg = new THREE.BufferGeometry();
    const local = (p: Vec3): number[] => {
      const d = sub(p, g.hubEcef);
      return [dot(d, g.h), dot(d, g.u), dot(d, cross(g.h, g.u))];
    };
    lg.setAttribute('position', new THREE.Float32BufferAttribute([...local(t0), ...local(t1)], 3));
    this.facility.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: COLORS.release })));
    this.site.add(this.facility);
    const latDeg = (g.lat * 180) / Math.PI, lonDeg = (g.lon * 180) / Math.PI;
    setLabelText(
      this.siteLabel,
      `LAUNCH SITE\n${fmtFixed(Math.abs(latDeg), 2)}°${latDeg >= 0 ? 'N' : 'S'} ${fmtFixed(Math.abs(lonDeg), 2)}°${lonDeg >= 0 ? 'E' : 'W'} · ${fmtInt(g.siteAltitude)} m`,
    );
    this.arcRange = { a0: NaN, a1: NaN };
    this.vehicle?.dispose();
    this.vehicle = new VehicleMesh(sc.vehicle);
    this.vehicleHolder.clear();
    this.vehicleHolder.add(this.vehicle.group);
    this.resetPending = true;
  }

  // ------------------------------------------------------------------ camera
  private applyCameraReset(ctx: FrameContext, follow: Vec3): void {
    const frame = this.framingTable(ctx);
    let rho = 120_000;
    if (frame) {
      const pts = this.framingPoints(frame, ctx.scenario?.config.physics.earthRotation ?? true);
      let m = 0;
      for (const p of pts) m = Math.max(m, norm(sub(p, follow)));
      if (m > 0) rho = Math.max(m, 20_000);
    }
    const halfFov = (this.camera.fov * Math.PI) / 360;
    const fit = Math.min(Math.tan(halfFov), Math.tan(halfFov) * this.camera.aspect);
    const d = (1.12 * rho * KM) / fit;
    const az = 0.22, el = 0.16;
    this.proj.toSceneV(follow, this.controls.target);
    this.camera.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(d).add(this.controls.target);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }

  private framingTable(ctx: FrameContext): TelemetryTable | null {
    if (hasTrajectory(ctx.predicted)) return ctx.predicted;
    if (hasTrajectory(ctx.flown)) return ctx.flown;
    return null;
  }

  /** Up to ~400 ECEF samples of a table within 30 degrees of the site (ascent framing). */
  private framingPoints(t: TelemetryTable, rotating: boolean): Vec3[] {
    const n = t.length;
    const step = Math.max(1, Math.floor(n / 400));
    const out: Vec3[] = [];
    const buf = new Float64Array(3);
    const cosLim = Math.cos((30 * Math.PI) / 180);
    for (let i = 0; i < n; i += step) {
      eciRowsToEcef(t, i, i + 1, rotating, buf);
      const p: Vec3 = [buf[0], buf[1], buf[2]];
      if (dot(normalize(p), this.siteUp) < cosLim) break;
      out.push(p);
    }
    return out;
  }

  // ------------------------------------------------------------------ frame
  update(ctx: FrameContext): void {
    const sc = ctx.scenario;
    if (sc !== this.scenario) {
      this.scenario = sc;
      if (sc) {
        const g = sc.geometry;
        const key = `${g.lat}|${g.lon}|${g.azimuth}|${g.siteAltitude}|${g.chamberRadius}|${g.elevation}|${sc.vehicle.length}|${sc.vehicle.diameter}|${sc.vehicle.family.id}|${sc.vehicle.fins.id}`;
        if (key !== this.siteKey) {
          this.siteKey = key;
          this.rebuildSite(sc);
        }
      }
    }
    const rotating = sc?.config.physics.earthRotation ?? true;
    const snap = ctx.snap;
    const veh = snap?.vehicle;
    const vehEcef: Vec3 | null = veh ? rotZ(veh.r, -snap!.earthAngle) : null;
    const follow: Vec3 = vehEcef ?? (sc ? sc.geometry.hubEcef : this.siteGround);
    this.following = vehEcef ? 'vehicle' : 'site';

    if (this.resetPending && sc) {
      this.resetPending = false;
      this.applyCameraReset(ctx, follow);
    }
    this.followAndRebase(follow);
    this.controls.enableDamping = !ctx.reducedMotion;
    this.controls.update();

    const camDist = this.camera.position.distanceTo(this.controls.target);
    this.camera.near = Math.max(1e-6, camDist * 1e-4);
    this.camera.far = Math.max(1e5, camDist * 1e3);
    this.camera.updateProjectionMatrix();
    const ppu = pxPerUnit(this.camera, camDist, this.height);

    // Earth, cap, graticule density from camera altitude.
    this.proj.place(this.earth, [0, 0, 0]);
    if (this.cap) this.proj.place(this.cap, capAnchor(this.siteUp));
    const camFrame = this.cameraFrame();
    const camAlt = norm(camFrame) - R_EARTH;
    setGraticule(this.earthMat, Math.max(camAlt, camDist / KM));

    // Site + facility.
    this.proj.toSceneV(this.siteGround, _v);
    setDot(this.siteDot, _v);
    this.siteLabel.position.copy(_v);
    if (sc) {
      this.proj.toSceneV(sc.geometry.hubEcef, this.facility.position);
      this.facility.scale.setScalar(KM);
    }
    this.siteLabel.visible = ctx.overlays.labels;

    // Tracks.
    const map: RowMapper = (t, a, b, out) => eciRowsToEcef(t, a, b, rotating, out);
    const flown = hasTrajectory(ctx.flown) ? ctx.flown : null;
    this.flownTrack.object.visible = !!flown;
    this.flownTrack.syncTable(flown, map, this.proj);
    const pred = ctx.overlays.predicted && hasTrajectory(ctx.predicted) ? ctx.predicted : null;
    this.predictedTrack.object.visible = !!pred;
    this.predictedTrack.syncTable(pred, map, this.proj);
    this.predictedTrack.setDash(12 / ppu, 8 / ppu);
    this.updateGhosts(ctx, map);

    // Atmosphere layers.
    this.atmo.visible = ctx.overlays.atmosphere;
    if (this.atmo.visible) this.updateAtmosphere(ctx, rotating);

    // Apogee marker of the primary trajectory.
    this.updateApogee(pred ?? flown, !!pred, rotating, ctx.overlays.labels);

    // Vehicle.
    this.updateVehicle(snap, vehEcef, rotating, ppu, ctx.overlays.labels);

    // Time cursor.
    this.updateCursor(ctx, rotating);

    // Text.
    const range = camDist / KM;
    this.overlay.setCaption(
      'WORLD · Earth-fixed',
      `camera ${fmtKm(range)} from ${this.following === 'vehicle' ? 'vehicle (following)' : 'launch site'} · drag to orbit, wheel to zoom`,
    );
    if (snap?.failure) this.overlay.setBanner(`FAILURE — ${snap.failure.criterion}: ${snap.failure.message}`, 'warn');
    else if (!sc) this.overlay.setBanner('Configuration invalid — showing Earth only', 'warn');
    else this.overlay.setBanner(null);
    this.overlay.setScale(ppu * KM);
  }

  private cameraFrame(): Vec3 {
    const d = this.proj.dirToFrame(this.camera.position);
    return [this.proj.origin[0] + d[0] / KM, this.proj.origin[1] + d[1] / KM, this.proj.origin[2] + d[2] / KM];
  }

  /** Keep the controls target on the follow point; rebase the render origin when it drifts far. */
  private followAndRebase(follow: Vec3): void {
    this.proj.toSceneV(follow, _v);
    _v2.subVectors(_v, this.controls.target);
    if (_v2.lengthSq() > 0) {
      this.camera.position.add(_v2);
      this.controls.target.copy(_v);
    }
    const camDistM = this.camera.position.distanceTo(this.controls.target) / KM;
    const off = norm(sub(follow, this.proj.origin));
    if (off > Math.max(1000, 2000 * camDistM)) {
      const old: Vec3 = [...this.proj.origin];
      this.proj.setOrigin(follow);
      const shift = this.proj.dirToScene(sub(old, follow), _v).multiplyScalar(KM);
      this.camera.position.add(shift);
      this.controls.target.add(shift);
    }
  }

  private updateGhosts(ctx: FrameContext, map: RowMapper): void {
    for (const g of this.ghosts.values()) g.seen = false;
    const show = ctx.overlays.ghosts;
    for (const gh of ctx.source.ghosts()) {
      if (!hasTrajectory(gh.table)) continue;
      let e = this.ghosts.get(gh.table);
      if (!e) {
        const track = new Track({ color: gh.color, width: 1.5, opacity: 0.75, renderOrder: 4 });
        track.setResolution(this.width, this.height);
        const label = makeLabel(gh.label, 'muted', [0.5, 1.3]);
        label.element.style.borderColor = gh.color;
        e = { track, label, seen: true, apoRow: -1, apoLen: 0 };
        this.ghosts.set(gh.table, e);
        this.scene.add(track.object);
        this.labels.add(label);
      }
      e.seen = true;
      e.track.object.visible = show;
      e.label.visible = show && ctx.overlays.labels;
      if (!show) continue;
      e.track.syncTable(gh.table, map, this.proj);
      setLabelText(e.label, gh.label);
      if (e.apoLen !== gh.table.length) {
        e.apoLen = gh.table.length;
        e.apoRow = maxRow(gh.table, 'alt');
      }
      if (e.apoRow >= 0 && e.apoRow < e.track.pointCount) this.proj.toSceneV(e.track.point(e.apoRow), e.label.position);
    }
    for (const [k, e] of this.ghosts) {
      if (e.seen) continue;
      this.scene.remove(e.track.object);
      e.track.dispose();
      e.label.removeFromParent();
      e.label.element.remove();
      this.ghosts.delete(k);
    }
  }

  private updateAtmosphere(ctx: FrameContext, rotating: boolean): void {
    for (const s of this.shells) this.proj.place(s, [0, 0, 0]);
    // Arcs at each altitude across the downrange span of the trajectory, in the site's launch plane.
    const frame = this.framingTable(ctx);
    let aMax = (1 * Math.PI) / 180;
    if (frame) {
      for (const p of this.framingPoints(frame, rotating)) {
        const ang = Math.atan2(norm(cross(this.siteUp, p)), dot(this.siteUp, p));
        aMax = Math.max(aMax, ang);
      }
    }
    const a1 = Math.min(Math.PI / 3, aMax * 1.2);
    const a0 = -Math.max(a1 * 0.25, (0.6 * Math.PI) / 180);
    const changed = !(Math.abs(a1 - this.arcRange.a1) <= 1e-4 && Math.abs(a0 - this.arcRange.a0) <= 1e-4);
    SHELLS.forEach((s, i) => {
      const r = R_EARTH + s.alt;
      if (changed) {
        const pts: Vec3[] = [];
        for (let k = 0; k <= 160; k++) {
          const a = a0 + ((a1 - a0) * k) / 160;
          pts.push(add(scale(this.siteUp, r * Math.cos(a)), scale(this.launchH, r * Math.sin(a))));
        }
        this.arcs[i].setPoints(pts, this.proj);
      } else this.arcs[i].reproject(this.proj);
      const p0 = add(scale(this.siteUp, r * Math.cos(a0)), scale(this.launchH, r * Math.sin(a0)));
      this.proj.toSceneV(p0, this.arcLabels[i].position);
      this.arcLabels[i].visible = ctx.overlays.labels;
    });
    if (changed) this.arcRange = { a0, a1 };
  }

  private updateApogee(t: TelemetryTable | null, isPred: boolean, rotating: boolean, labels: boolean): void {
    const c = this.apoCache;
    if (!t || !('alt' in t.index)) {
      this.apoDot.visible = false;
      this.apoLabel.visible = false;
      return;
    }
    if (c.table !== t || c.len !== t.length) {
      c.table = t;
      c.len = t.length;
      c.row = maxRow(t, 'alt');
    }
    if (c.row < 0) return;
    const buf = new Float64Array(3);
    eciRowsToEcef(t, c.row, c.row + 1, rotating, buf);
    this.proj.toScene(buf[0], buf[1], buf[2], _v);
    setDot(this.apoDot, _v);
    this.apoLabel.position.copy(_v);
    (this.apoDot.material as THREE.PointsMaterial).color.set(isPred ? COLORS.predicted : COLORS.flown);
    setLabelText(this.apoLabel, `${isPred ? 'predicted ' : ''}apogee ${fmtKm(t.get('alt', c.row))}`);
    this.apoDot.visible = true;
    this.apoLabel.visible = labels;
  }

  private updateVehicle(snap: Snapshot | null, vehEcef: Vec3 | null, rotating: boolean, ppuTarget: number, labels: boolean): void {
    const veh = snap?.vehicle;
    const vm = this.vehicle;
    const on = !!veh && !!vehEcef && !!vm;
    this.vehicleHolder.visible = on;
    this.vehicleDot.visible = on;
    this.vehicleLabel.visible = on && labels;
    if (!on || !veh || !vehEcef || !vm || !this.scenario) return;
    const ang = snap!.earthAngle;
    this.proj.toSceneV(vehEcef, this.vehicleHolder.position);
    setDot(this.vehicleDot, this.vehicleHolder.position);
    const dCam = this.camera.position.distanceTo(this.vehicleHolder.position);
    const ppu = dCam > 0 ? pxPerUnit(this.camera, dCam, this.height) : ppuTarget;
    const L = this.scenario.vehicle.length;
    const want = 44 / Math.max(L * KM * ppu, 1e-12);
    const mag = want <= 1.5 ? 1 : niceStep(want);
    this.vehicleHolder.scale.setScalar(mag * KM);
    const xb = this.proj.dirToScene(rotZ(qRotate(veh.q, [1, 0, 0]), -ang), new THREE.Vector3());
    const yb = this.proj.dirToScene(rotZ(qRotate(veh.q, [0, 1, 0]), -ang), new THREE.Vector3());
    const zb = new THREE.Vector3().crossVectors(xb, yb);
    this.vehicleHolder.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xb, yb, zb));
    vm.setAeroshell(veh.aeroshell);
    vm.setHeat(veh.temps[0]);
    vm.setThrust(veh.thrust);
    const om = rotating ? OMEGA_EARTH : 0;
    const vRel = norm(sub(veh.v, [-om * veh.r[1], om * veh.r[0], 0]));
    this.vehicleLabel.position.copy(this.vehicleHolder.position);
    const magText = mag > 1 ? `vehicle ×${fmtInt(mag)} magnified` : 'vehicle (true scale)';
    const status = veh.thrust > 0 ? ' · ENGINE ON' : '';
    setLabelText(this.vehicleLabel, `${magText}\n${fmtKm(veh.altitude)} · ${fmtInt(vRel)} m/s${status}`);
  }

  private updateCursor(ctx: FrameContext, rotating: boolean): void {
    const tc = ctx.source.cursorTime();
    const flown = hasTrajectory(ctx.flown) ? ctx.flown : null;
    const pred = hasTrajectory(ctx.predicted) ? ctx.predicted : null;
    let table: TelemetryTable | null = null;
    if (tc !== null && Number.isFinite(tc)) {
      if (flown && tc >= flown.get('t', 0) && tc <= flown.lastTime()) table = flown;
      else if (pred) table = pred;
      else table = flown;
    }
    this.cursorRing.visible = !!table;
    if (!table || tc === null) return;
    const row = table.rowAt(tc);
    const buf = new Float64Array(3);
    eciRowsToEcef(table, row, row + 1, rotating, buf);
    this.proj.toScene(buf[0], buf[1], buf[2], _v);
    setDot(this.cursorRing, _v);
  }

  dispose(): void {
    this.controls.dispose();
    this.vehicle?.dispose();
    for (const t of this.allTracks()) t.dispose();
    if (this.cap) this.cap.geometry.dispose();
    disposeTree(this.scene);
    this.earthMat.dispose();
    this.overlay.dispose();
  }
}

export function maxRow(t: TelemetryTable, ch: string): number {
  const c = t.col(ch);
  let best = -1, v = -Infinity;
  for (let i = 0; i < c.length; i++) {
    if (c[i] > v) {
      v = c[i];
      best = i;
    }
  }
  return best;
}
