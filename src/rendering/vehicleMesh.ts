/**
 * Vehicle model built from the configured geometry: body cylinder, nose of
 * the selected family (tangent ogive, cone, hemisphere, flat; blunted by the
 * nose radius), fin panels, and the exposed upper-stage stack shown after
 * aeroshell jettison. Body axis +X (tail -> nose), origin at the geometric
 * centre. The nose glows with a blackbody-like ramp tied to its surface
 * temperature, and an exhaust plume is shown only while thrust > 0.
 */
import * as THREE from 'three';
import type { VehicleModel } from '../physics/vehicle';
import { disposeTree } from './projection';

type NoseKind = 'ogive' | 'cone' | 'hemisphere' | 'flat';

function noseRadiusAt(kind: NoseKind, Rb: number, Ln: number, x: number): number {
  // x: axial distance from the nose base (0) to the tip (Ln).
  if (Ln <= 1e-9) return Rb;
  switch (kind) {
    case 'cone':
      return Rb * (1 - x / Ln);
    case 'ogive': {
      const rho = (Rb * Rb + Ln * Ln) / (2 * Rb);
      return Math.max(0, Math.sqrt(Math.max(0, rho * rho - x * x)) + Rb - rho);
    }
    case 'hemisphere':
      return Rb * Math.sqrt(Math.max(0, 1 - (x / Ln) * (x / Ln)));
    default:
      return x < Ln ? Rb : 0;
  }
}

/** Lathe profile (radius, height) from base to tip, blunted by tip radius rn. */
function noseProfile(kind: NoseKind, Rb: number, Ln: number, rn: number, n = 40): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  if (kind === 'flat' || Ln < 1e-3) {
    const h = Math.max(Ln, Rb * 0.04);
    pts.push(new THREE.Vector2(Rb, 0), new THREE.Vector2(Rb, h * 0.6), new THREE.Vector2(Rb * 0.92, h), new THREE.Vector2(0, h));
    return pts;
  }
  const xc = Ln - rn;
  for (let i = 0; i <= n; i++) {
    const x = Ln * (1 - Math.pow(1 - i / n, 1.6));
    let r = noseRadiusAt(kind, Rb, Ln, x);
    if (rn > 0 && x > xc - rn) r = Math.max(r, Math.sqrt(Math.max(0, rn * rn - (x - xc) * (x - xc))));
    pts.push(new THREE.Vector2(Math.min(Rb, r), x));
  }
  pts[pts.length - 1].x = 0;
  return pts;
}

/** Approximate blackbody colour/intensity for a surface at T kelvin (dark below ~800 K). */
const HEAT_RAMP: Array<[number, number, number, number, number]> = [
  // T, r, g, b, intensity
  [800, 0.25, 0.01, 0.0, 0.0],
  [950, 0.75, 0.08, 0.0, 0.35],
  [1100, 1.0, 0.22, 0.02, 0.7],
  [1400, 1.0, 0.42, 0.08, 1.1],
  [1700, 1.0, 0.58, 0.22, 1.5],
  [2100, 1.0, 0.72, 0.45, 1.9],
  [2600, 1.0, 0.82, 0.64, 2.3],
  [3200, 1.0, 0.9, 0.8, 2.6],
];

export function heatGlow(T: number, out: THREE.Color): number {
  if (!(T > HEAT_RAMP[0][0])) {
    out.setRGB(0, 0, 0);
    return 0;
  }
  for (let i = 1; i < HEAT_RAMP.length; i++) {
    const a = HEAT_RAMP[i - 1], b = HEAT_RAMP[i];
    if (T <= b[0]) {
      const f = (T - a[0]) / (b[0] - a[0]);
      out.setRGB(a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f);
      return a[4] + (b[4] - a[4]) * f;
    }
  }
  const l = HEAT_RAMP[HEAT_RAMP.length - 1];
  out.setRGB(l[1], l[2], l[3]);
  return l[4];
}

export class VehicleMesh {
  readonly group = new THREE.Group();
  private readonly shell = new THREE.Group();
  private readonly stack = new THREE.Group();
  private readonly noseMat: THREE.MeshStandardMaterial;
  private readonly plume = new THREE.Group();
  private readonly shellTail: number;
  private readonly stackTail: number;
  private readonly diameter: number;
  private readonly glow = new THREE.Color();
  private lastT = NaN;

  constructor(v: VehicleModel) {
    const L = v.length, D = v.diameter, Rb = D / 2;
    this.diameter = D;
    const bodyMat = new THREE.MeshStandardMaterial({ color: '#d0d7de', metalness: 0.35, roughness: 0.45 });
    const finMat = new THREE.MeshStandardMaterial({ color: '#8b949e', metalness: 0.3, roughness: 0.55 });
    const darkMat = new THREE.MeshStandardMaterial({ color: '#30363d', metalness: 0.5, roughness: 0.5 });
    this.noseMat = new THREE.MeshStandardMaterial({ color: '#aab3bd', metalness: 0.2, roughness: 0.6, emissive: '#000000' });

    // ---- aeroshell configuration
    const Ln = Math.min(v.noseLength, L * 0.5);
    const bodyLen = Math.max(L - Ln, 1e-3);
    const body = new THREE.Mesh(new THREE.CylinderGeometry(Rb, Rb, bodyLen, 32, 1, false), bodyMat);
    body.rotation.z = -Math.PI / 2;
    body.position.x = -L / 2 + bodyLen / 2;
    this.shell.add(body);
    const noseGeo = new THREE.LatheGeometry(noseProfile(v.family.nose, Rb, Ln, Math.min(v.noseRadius, Rb), 40), 32);
    const nose = new THREE.Mesh(noseGeo, this.noseMat);
    nose.rotation.z = -Math.PI / 2;
    nose.position.x = L / 2 - Ln;
    this.shell.add(nose);
    if (v.fins.panels > 0 && v.finGeom.span > 0) {
      const c = v.finGeom.meanChord, s = v.finGeom.span;
      const cr = Math.min(1.35 * c, L * 0.45), ct = 0.65 * c;
      const shape = new THREE.Shape();
      shape.moveTo(0, 0);
      shape.lineTo(cr, 0);
      shape.lineTo(ct, s);
      shape.lineTo(0, s);
      shape.closePath();
      const th = Math.max(0.004, 0.05 * c);
      const finGeo = new THREE.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false });
      finGeo.translate(-L / 2, Rb * 0.98, -th / 2);
      for (let k = 0; k < v.fins.panels; k++) {
        const f = new THREE.Mesh(k === 0 ? finGeo : finGeo.clone(), finMat);
        f.rotation.x = Math.PI / 4 + (2 * Math.PI * k) / v.fins.panels;
        this.shell.add(f);
      }
    }
    if (v.stages.length > 0) {
      const bell = new THREE.Mesh(new THREE.CylinderGeometry(Rb * 0.28, Rb * 0.45, Rb * 0.5, 20, 1, true), darkMat);
      bell.rotation.z = -Math.PI / 2;
      bell.position.x = -L / 2 - Rb * 0.25;
      this.shell.add(bell);
    }
    this.shellTail = -L / 2 - (v.stages.length > 0 ? Rb * 0.5 : 0);

    // ---- exposed stack (after aeroshell jettison)
    const Ls = Math.max(v.stackLength, 0.1), Ds = Math.max(v.stackDiameter, 0.02), Rs = Ds / 2;
    const fair = Math.min(Ls * 0.3, Ds * 1.6);
    const sBody = new THREE.Mesh(new THREE.CylinderGeometry(Rs, Rs, Ls - fair, 28), bodyMat);
    sBody.rotation.z = -Math.PI / 2;
    sBody.position.x = -Ls / 2 + (Ls - fair) / 2;
    this.stack.add(sBody);
    const sNose = new THREE.Mesh(new THREE.LatheGeometry(noseProfile('ogive', Rs, fair, Rs * 0.15, 24), 28), this.noseMat);
    sNose.rotation.z = -Math.PI / 2;
    sNose.position.x = Ls / 2 - fair;
    this.stack.add(sNose);
    const sBell = new THREE.Mesh(new THREE.CylinderGeometry(Rs * 0.35, Rs * 0.7, Rs * 0.9, 20, 1, true), darkMat);
    sBell.rotation.z = -Math.PI / 2;
    sBell.position.x = -Ls / 2 - Rs * 0.45;
    this.stack.add(sBell);
    this.stackTail = -Ls / 2 - Rs * 0.9;
    this.stack.visible = false;

    // ---- plume (apex at the nozzle, opening aft along -X)
    const mkCone = (r: number, color: string, opacity: number): THREE.Mesh => {
      const g = new THREE.ConeGeometry(r, 1, 24, 1, true);
      g.rotateZ(-Math.PI / 2);
      g.translate(-0.5, 0, 0);
      const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      return new THREE.Mesh(g, m);
    };
    this.plume.add(mkCone(0.55, '#ff9a3c', 0.45), mkCone(0.22, '#fff0d0', 0.8));
    this.plume.visible = false;

    this.group.add(this.shell, this.stack, this.plume);
  }

  setAeroshell(attached: boolean): void {
    this.shell.visible = attached;
    this.stack.visible = !attached;
  }

  /** Nose surface temperature (K) -> emissive glow. */
  setHeat(T: number): void {
    if (Math.abs(T - this.lastT) < 2) return;
    this.lastT = T;
    const k = heatGlow(T, this.glow);
    this.noseMat.emissive.copy(this.glow);
    this.noseMat.emissiveIntensity = k;
  }

  /** Plume only while the engine produces thrust (N). */
  setThrust(thrust: number): void {
    const on = thrust > 0;
    this.plume.visible = on;
    if (!on) return;
    const tail = this.stack.visible ? this.stackTail : this.shellTail;
    const D = this.stack.visible ? this.diameter * 0.8 : this.diameter;
    const len = D * (3 + 5 * Math.min(1, Math.sqrt(thrust / 2e4)));
    this.plume.position.set(tail, 0, 0);
    this.plume.scale.set(len, D, D);
  }

  dispose(): void {
    disposeTree(this.group);
  }
}
