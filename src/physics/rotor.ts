/**
 * Centrifuge rotor: constrained rigid rotation about a fixed horizontal axis,
 * integrated as theta' = omega, omega' = (tau_motor - tau_loss) / I_total.
 *
 * Kinematics:  v_tip = omega R,  a_radial = omega^2 R,  a_tangential = omegaDot R.
 * Energy:      E_rot = 0.5 I_total omega^2 (arm, counterbalance, hub, vehicle).
 *
 * Arm stress (axial-load approximation, NOT a full rotating composite-beam
 * analysis):  T(s) = m_tip omega^2 R + integral_s^R lambda(x) omega^2 x dx,
 *             sigma(s) = T(s) / A(s).
 * Bending, joints, vibration and release transients are handled only by
 * separate operating envelopes.
 */
import { M0_AIR, R_STAR_USSA76, K_BOLTZMANN, AIR_MOLECULE_DIAMETER } from './constants';
import { prov, type Provenance } from './provenance';

/** Tip kinematics for arm radius R and tip speed v (exact relations). */
export function tipKinematics(R: number, vTip: number): { omega: number; rpm: number; aRadial: number; gLoad: number } {
  const omega = vTip / R;
  return { omega, rpm: (omega * 60) / (2 * Math.PI), aRadial: omega * omega * R, gLoad: (omega * omega * R) / 9.80665 };
}

/** Translational kinetic energy of the departing vehicle only (J). Not the electricity bill. */
export const vehicleTranslationalEnergy = (m: number, vTip: number): number => 0.5 * m * vTip * vTip;

export interface ArmMaterial {
  id: string;
  name: string;
  density: number;
  /** Modelled failure threshold for axial stress (Pa). */
  ultimateStrength: number;
  costPerKg: number;
  provenance: Provenance;
}

export interface ArmGeometry {
  length: number;
  rootArea: number;
  tipArea: number;
  /**
   * linear: A varies linearly root->tip.
   * exponential: A = A_tip (A_root/A_tip)^(1 - x/L).
   * constant-stress: A = A_tip (A_root/A_tip)^(1 - (x/L)^2), the Gaussian
   *   family that equalises self-load stress in a spinning bar.
   */
  profile: 'linear' | 'exponential' | 'constant-stress';
  /** Section chord / height (streamlining aspect ratio). */
  sectionAspect: number;
}

export function armArea(g: ArmGeometry, x: number): number {
  const f = Math.min(1, Math.max(0, x / g.length));
  if (g.profile === 'linear') return g.rootArea + (g.tipArea - g.rootArea) * f;
  if (g.profile === 'exponential') return g.tipArea * Math.pow(g.rootArea / g.tipArea, 1 - f);
  return g.tipArea * Math.pow(g.rootArea / g.tipArea, 1 - f * f);
}

/** Frontal height of the section (along the rotor axis). */
export const armHeight = (g: ArmGeometry, x: number): number => Math.sqrt(armArea(g, x) / g.sectionAspect);

export interface ArmIntegrals {
  mass: number;
  /** integral lambda x dx */
  staticMoment: number;
  /** integral lambda x^2 dx */
  inertia: number;
  /** max_s [G(s)/A(s)] where sigma_max = omega^2 * stressFactor */
  stressFactor: number;
  /** location of maximum stress (m from hub) */
  stressMaxAt: number;
  /** integral height(x) x^3 dx (gas drag torque) */
  dragMoment: number;
  /** Sampled stress factor profile for display: [x, G/A] pairs. */
  profile: Array<[number, number]>;
}

/**
 * Integrates arm properties with composite Simpson's rule. tipMass is the
 * concentrated mass at the tip (vehicle + cradle, or counterbalance).
 */
export function armIntegrals(g: ArmGeometry, density: number, tipMass: number, n = 400): ArmIntegrals {
  if (n % 2) n++;
  const L = g.length;
  const h = L / n;
  let mass = 0, sm = 0, inertia = 0, drag = 0;
  for (let i = 0; i <= n; i++) {
    const x = i * h;
    const w = i === 0 || i === n ? 1 : i % 2 ? 4 : 2;
    const lam = density * armArea(g, x);
    mass += w * lam;
    sm += w * lam * x;
    inertia += w * lam * x * x;
    drag += w * armHeight(g, x) * x * x * x;
  }
  mass *= h / 3; sm *= h / 3; inertia *= h / 3; drag *= h / 3;
  // Tension factor G(s) = m_tip L + integral_s^L lambda x dx, computed from tip inward (trapezoid on fine grid).
  const N = 2000;
  const dx = L / N;
  let G = tipMass * L;
  let best = 0, bestAt = L;
  const profile: Array<[number, number]> = [];
  let prevF = density * armArea(g, L) * L;
  for (let i = N; i >= 0; i--) {
    const x = i * dx;
    if (i < N) {
      const f = density * armArea(g, x) * x;
      G += 0.5 * (f + prevF) * dx;
      prevF = f;
    }
    const ratio = G / armArea(g, x);
    if (ratio > best) { best = ratio; bestAt = x; }
    if (i % 50 === 0) profile.push([x, ratio]);
  }
  profile.reverse();
  return { mass, staticMoment: sm, inertia, stressFactor: best, stressMaxAt: bestAt, dragMoment: drag, profile };
}

export interface MotorSpec {
  electricalPowerW: number;
  torqueLimitNm: number;
  efficiency: number;
  /** Speed-loop settling time constant near target (s). */
  settleTimeS: number;
}

export interface BearingSpec {
  coulombTorqueNm: number;
  viscousNmPerRadS: number;
  /** Transient radial load envelope (N), e.g. post-release imbalance. */
  radialLoadLimitN: number;
}

export interface RotorParams {
  vehicleArm: ArmGeometry;
  counterArm: ArmGeometry;
  material: ArmMaterial;
  /** Vehicle wet mass + cradle (tip of the vehicle arm). */
  vehicleTipMass: number;
  vehicleMass: number;
  /** Vehicle rotational inertia about an axis parallel to the rotor axis (kg m^2). */
  vehicleOwnInertia: number;
  counterMass: number;
  counterRadius: number;
  hubInertia: number;
  motor: MotorSpec;
  bearing: BearingSpec;
  chamberPressurePa: number;
  chamberTemperatureK: number;
  /** Continuum and free-molecular drag coefficients for the arm section (frontal). */
  armCdContinuum: number;
  armCdFreeMolecular: number;
  vehicleFrontalArea: number;
  counterFrontalArea: number;
}

export interface RotorDerived {
  vehicleArm: ArmIntegrals;
  counterArm: ArmIntegrals;
  inertia: number;
  armMass: number;
  /** Imbalance static moment before release (kg m), ideally ~0. */
  preReleaseImbalance: number;
  gasDensity: number;
  meanFreePath: number;
  /** Combined gas-drag torque coefficient: tau_gas = kGas * omega^2. */
  kGas: number;
  armCd: number;
}

export function deriveRotor(p: RotorParams): RotorDerived {
  const va = armIntegrals(p.vehicleArm, p.material.density, p.vehicleTipMass);
  const ca = armIntegrals(p.counterArm, p.material.density, p.counterMass);
  const inertia =
    p.hubInertia +
    va.inertia +
    ca.inertia +
    p.vehicleTipMass * p.vehicleArm.length ** 2 +
    p.vehicleOwnInertia +
    p.counterMass * p.counterRadius ** 2;
  const imbalance = p.vehicleTipMass * p.vehicleArm.length + va.staticMoment - p.counterMass * p.counterRadius - ca.staticMoment;
  const rho = (p.chamberPressurePa * M0_AIR) / (R_STAR_USSA76 * p.chamberTemperatureK);
  const lambda =
    (K_BOLTZMANN * p.chamberTemperatureK) /
    (Math.SQRT2 * Math.PI * AIR_MOLECULE_DIAMETER * AIR_MOLECULE_DIAMETER * Math.max(p.chamberPressurePa, 1e-12));
  const hRef = armHeight(p.vehicleArm, p.vehicleArm.length * 0.7);
  const kn = lambda / hRef;
  const w = kn <= 0.01 ? 0 : kn >= 10 ? 1 : (Math.log10(kn) + 2) / 3;
  const cd = (1 - w) * p.armCdContinuum + w * p.armCdFreeMolecular;
  const R = p.vehicleArm.length, Rc = p.counterRadius;
  const kGas =
    0.5 * rho * cd * (va.dragMoment + ca.dragMoment) +
    0.5 * rho * 1.0 * p.vehicleFrontalArea * R * R * R +
    0.5 * rho * 1.2 * p.counterFrontalArea * Rc * Rc * Rc;
  return {
    vehicleArm: va,
    counterArm: ca,
    inertia,
    armMass: va.mass + ca.mass,
    preReleaseImbalance: imbalance,
    gasDensity: rho,
    meanFreePath: lambda,
    kGas,
    armCd: cd,
  };
}

/** Counterbalance mass that statically balances the rotor for a given counter radius. */
export function balancingCounterMass(
  vehicleTipMass: number,
  vehicleArm: ArmGeometry,
  counterArm: ArmGeometry,
  density: number,
  counterRadius: number,
): number {
  const va = armIntegrals(vehicleArm, density, 0, 200);
  const ca = armIntegrals(counterArm, density, 0, 200);
  return Math.max(0, (vehicleTipMass * vehicleArm.length + va.staticMoment - ca.staticMoment) / counterRadius);
}

export const bearingTorque = (b: BearingSpec, omega: number): number =>
  omega > 0 ? b.coulombTorqueNm * Math.min(1, omega / 0.05) + b.viscousNmPerRadS * omega : 0;

export const gasTorque = (d: RotorDerived, omega: number): number => d.kGas * omega * omega;

export const lossTorque = (p: RotorParams, d: RotorDerived, omega: number): number =>
  bearingTorque(p.bearing, omega) + gasTorque(d, omega);

/** Motor torque available at speed omega (defined at zero speed by the torque limit). */
export function motorTorqueAvailable(m: MotorSpec, omega: number): number {
  const pMech = m.efficiency * m.electricalPowerW;
  return omega <= 0 ? m.torqueLimitNm : Math.min(m.torqueLimitNm, pMech / omega);
}

/** Speed-loop controller: saturated torque toward target, smooth approach and hold. */
export function controllerTorque(p: RotorParams, d: RotorDerived, omega: number, omegaTarget: number): number {
  const avail = motorTorqueAvailable(p.motor, omega);
  const want = lossTorque(p, d, omega) + (d.inertia * (omegaTarget - omega)) / p.motor.settleTimeS;
  return Math.max(0, Math.min(avail, want));
}

/** Rotor state layout. */
export const RS = {
  PHASE: 0,
  OMEGA: 1,
  E_ELEC: 2,
  E_MECH: 3,
  E_BEARING: 4,
  E_GAS: 5,
  N: 6,
} as const;

export function rotorDerivative(
  p: RotorParams,
  d: RotorDerived,
  omegaTarget: number,
  driveEnabled: boolean,
  y: Float64Array,
  dy: Float64Array,
): void {
  const w = Math.max(0, y[RS.OMEGA]);
  const tm = driveEnabled ? controllerTorque(p, d, w, omegaTarget) : 0;
  const tb = bearingTorque(p.bearing, w);
  const tg = gasTorque(d, w);
  dy[RS.PHASE] = w;
  dy[RS.OMEGA] = (tm - tb - tg) / d.inertia;
  if (w <= 0 && dy[RS.OMEGA] < 0) dy[RS.OMEGA] = 0;
  const pm = tm * w;
  dy[RS.E_ELEC] = pm / p.motor.efficiency;
  dy[RS.E_MECH] = pm;
  dy[RS.E_BEARING] = tb * w;
  dy[RS.E_GAS] = tg * w;
}

/**
 * Highest speed the drive can sustain against losses (rad/s), by bisection on
 * tau_avail(omega) - tau_loss(omega).
 */
export function equilibriumSpeed(p: RotorParams, d: RotorDerived, omegaMax = 2000): number {
  const f = (w: number): number => motorTorqueAvailable(p.motor, w) - lossTorque(p, d, w);
  if (f(omegaMax) > 0) return omegaMax;
  let lo = 0, hi = omegaMax;
  if (f(1e-6) <= 0) return 0;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

export const ROTOR_PROVENANCE = prov(
  'engineering-approximation',
  [],
  'Rigid rotor about a fixed axis (physical law) with an axial-load arm-stress approximation, Coulomb+viscous bearing loss (empirical form) and a residual-gas drag loss bridged between continuum and free-molecular coefficients (approximation). The arm is treated as rigid: no bending, flutter, joint or vibration model.',
);
