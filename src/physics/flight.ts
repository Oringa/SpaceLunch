/**
 * Free-flight equations of motion in the Earth-centred inertial frame.
 *
 *   r' = v
 *   v' = -mu r / |r|^3 + (F_aero + F_thrust) / m
 *   q' = 0.5 q (x) [0, w_b]                         (Engineering mode)
 *   I w_b' = M_aero + M_thrust + M_rcs - w_b x (I w_b)   (I updated quasi-statically)
 *   m_prop' = -F / (Isp g0),  m_rcs' = -(RCS couple thrust) / (Isp_rcs g0)
 *   thermal nodes per thermal.ts
 *
 * Air-relative velocity: v_air = v - (omega_E x r + wind).  No Coriolis or
 * centrifugal terms are added: the frame is inertial.
 *
 * Assisted mode (3-DOF): attitude is PRESCRIBED, not integrated: the body
 * axis points along the air-relative velocity when unpowered and along the
 * commanded thrust direction during burns, with no moments and no limits on
 * turning rate. This idealisation is labelled in the UI and its records are
 * kept separate.
 */
import { G0, MU_EARTH, R_EARTH, K_BOLTZMANN, AIR_MOLECULE_DIAMETER } from './constants';
import { type AtmosphereModel, type AtmosphereSample, emptySample } from './atmosphere';
import { aeroCoefficients, emptyAeroCoefficients, type AeroCoefficients } from './aero';
import { corotationVelocity, eciToEcef, ecefToSpherical } from './frames';
import { type Quat, qRotate, qRotateInv, qDot, qFromBasis, qNormalize } from './quat';
import { stagnationHeating, thermalDerivatives, type HeatingSample } from './thermal';
import { ispAt, massFlowFull } from './propulsion';
import { type MassModel, type MassProps, emptyMassProps, type VehicleModel } from './vehicle';
import { type WindModel, windEci } from './wind';
import { type GuidanceParams, guidanceDirection, AUTOPILOT, orbitNormal } from './guidance';
import { type Vec3, cross, dot, norm, normalize, clamp } from './vec3';

export const FS = {
  RX: 0, RY: 1, RZ: 2,
  VX: 3, VY: 4, VZ: 5,
  QW: 6, QX: 7, QY: 8, QZ: 9,
  WX: 10, WY: 11, WZ: 12,
  MPROP: 13,
  MRCS: 14,
  T1: 15, T2: 16, T3: 17, T4: 18,
  HEATLOAD: 19,
  AEROWORK: 20,
  THRUSTDV: 21,
  N: 22,
} as const;

export type Fidelity = 'engineering' | 'assisted';
export type FlightEnvironmentKind = 'chamber' | 'atmosphere';
export type AttitudeMode = 'passive' | 'hold-air-relative' | 'guidance';

export interface FlightDiscrete {
  environment: FlightEnvironmentKind;
  aeroshellAttached: boolean;
  /** Index of the active (lowest remaining) stage; -1 if none. */
  activeStage: number;
  engineOn: boolean;
  throttle: number;
  attitudeMode: AttitudeMode;
  ignitionTime: number;
}

export interface FlightEnvironment {
  /** Gravity is always on in gameplay; disabled only by analytical tests. */
  gravity: boolean;
  atmosphere: AtmosphereModel;
  wind: WindModel;
  atmosphereEnabled: boolean;
  earthRotation: boolean;
  chamberDensity: number;
  chamberTemperature: number;
  chamberPressure: number;
  terrainAltitude: number;
}

export interface FlightDerived {
  t: number;
  altitude: number;
  lat: number;
  lon: number;
  rho: number;
  pressure: number;
  airTemperature: number;
  speedOfSound: number;
  vAir: Vec3;
  vAirMag: number;
  speedInertial: number;
  mach: number;
  qDyn: number;
  knudsen: number;
  alpha: number;
  aero: AeroCoefficients;
  forceAero: Vec3;
  forceThrust: Vec3;
  normalForce: number;
  axialForce: number;
  thrust: number;
  massFlow: number;
  mass: number;
  xcg: number;
  stabilityMarginCal: number;
  /** Proper (non-gravitational) acceleration in body axes, m/s^2. */
  aProperBody: Vec3;
  axialG: number;
  lateralG: number;
  payloadLateralG: number;
  payloadAxialG: number;
  heat: HeatingSample;
  qSurface: number;
  qBody: number;
  bodyX: Vec3;
  attitude: Quat;
  omegaBody: Vec3;
  desiredDir: Vec3 | null;
  torqueCmd: Vec3;
  torqueTvc: Vec3;
  torqueRcs: Vec3;
  gimbalRad: number;
  rcsMassFlow: number;
  aeroFlags: number;
}

export function emptyDerived(): FlightDerived {
  return {
    t: 0, altitude: 0, lat: 0, lon: 0, rho: 0, pressure: 0, airTemperature: 0, speedOfSound: 340,
    vAir: [0, 0, 0], vAirMag: 0, speedInertial: 0, mach: 0, qDyn: 0, knudsen: 0, alpha: 0,
    aero: emptyAeroCoefficients(), forceAero: [0, 0, 0], forceThrust: [0, 0, 0], normalForce: 0, axialForce: 0,
    thrust: 0, massFlow: 0, mass: 0, xcg: 0, stabilityMarginCal: 0, aProperBody: [0, 0, 0], axialG: 0, lateralG: 0,
    payloadLateralG: 0, payloadAxialG: 0,
    heat: { qColdWall: 0, qStag: 0, recoveryTemperature: 0, flags: 0 }, qSurface: 0, qBody: 0,
    bodyX: [1, 0, 0], attitude: [1, 0, 0, 0], omegaBody: [0, 0, 0], desiredDir: null,
    torqueCmd: [0, 0, 0], torqueTvc: [0, 0, 0], torqueRcs: [0, 0, 0], gimbalRad: 0, rcsMassFlow: 0, aeroFlags: 0,
  };
}

export class FlightModel {
  discrete: FlightDiscrete;
  readonly derived: FlightDerived = emptyDerived();
  /** When true the next derivative evaluation fills `derived`. */
  capture = false;
  private atm: AtmosphereSample = emptySample();
  private mp: MassProps = emptyMassProps();
  private ac: AeroCoefficients = emptyAeroCoefficients();
  private heat: HeatingSample = { qColdWall: 0, qStag: 0, recoveryTemperature: 0, flags: 0 };
  private dyScratch = new Float64Array(FS.N);

  constructor(
    readonly env: FlightEnvironment,
    readonly vehicle: VehicleModel,
    readonly mass: MassModel,
    readonly guidance: GuidanceParams,
    readonly fidelity: Fidelity,
    initial: FlightDiscrete,
  ) {
    this.discrete = { ...initial };
  }

  massProps(y: ArrayLike<number>): MassProps {
    const d = this.discrete;
    return this.mass.props(d.aeroshellAttached, d.activeStage, y[FS.MPROP], y[FS.MRCS], this.mp);
  }

  /** Evaluate derived quantities at (t, y) without disturbing integrator state. */
  evaluate(t: number, y: Float64Array): FlightDerived {
    this.capture = true;
    this.deriv(t, y, this.dyScratch);
    this.capture = false;
    return this.derived;
  }

  /** Thrust available right now (N) at ambient pressure p. */
  private thrustNow(p: number, mprop: number): { thrust: number; mdot: number } {
    const d = this.discrete;
    if (!d.engineOn || d.activeStage < 0 || mprop <= 0) return { thrust: 0, mdot: 0 };
    const s = this.vehicle.stages[d.activeStage].spec;
    const mdot = d.throttle * massFlowFull(s);
    return { thrust: mdot * G0 * ispAt(s, p), mdot };
  }

  readonly deriv = (t: number, y: Float64Array, dy: Float64Array): void => {
    const d = this.discrete;
    const env = this.env;
    const r: Vec3 = [y[0], y[1], y[2]];
    const v: Vec3 = [y[3], y[4], y[5]];
    const rn = norm(r);
    const altitude = rn - R_EARTH;
    const mp = this.massProps(y);
    const m = mp.mass;

    // ---- environment
    let rho = 0, pAmb = 0, tAir = 250, aSnd = 300, lambda = 1e9;
    if (d.environment === 'chamber') {
      rho = env.chamberDensity;
      pAmb = env.chamberPressure;
      tAir = env.chamberTemperature;
      aSnd = Math.sqrt(1.4 * 287.05 * tAir);
      lambda = (K_BOLTZMANN * tAir) / (Math.SQRT2 * Math.PI * AIR_MOLECULE_DIAMETER ** 2 * Math.max(pAmb, 1e-12));
    } else if (env.atmosphereEnabled) {
      env.atmosphere.sample(altitude, this.atm);
      rho = this.atm.density;
      pAmb = this.atm.pressure;
      tAir = this.atm.temperature;
      aSnd = this.atm.speedOfSound;
      lambda = this.atm.meanFreePath;
    } else if (this.capture) {
      // Vacuum thought experiment: report the (unused) standard values for context.
      env.atmosphere.sample(altitude, this.atm);
      tAir = this.atm.temperature;
      aSnd = this.atm.speedOfSound;
    }
    const corot = corotationVelocity(r, env.earthRotation);
    let vAir: Vec3 = [v[0] - corot[0], v[1] - corot[1], v[2] - corot[2]];
    if (d.environment === 'atmosphere' && env.wind.enabled && rho > 0) {
      const w = windEci(env.wind, r, t, env.earthRotation);
      vAir = [vAir[0] - w[0], vAir[1] - w[1], vAir[2] - w[2]];
    }
    const V = norm(vAir);

    // ---- thrust magnitude & guidance direction
    const mprop = y[FS.MPROP];
    const { thrust, mdot } = this.thrustNow(pAmb, mprop);
    const guidanceActive = this.guidance.mode !== 'none' && (d.engineOn || d.attitudeMode === 'guidance');
    let guideDir: Vec3 | null = null;
    if (guidanceActive) {
      const s = d.activeStage >= 0 ? this.vehicle.stages[d.activeStage].spec : null;
      const tAcc = thrust > 0 ? thrust / m : s ? (s.thrustVac / m) : 1;
      guideDir = guidanceDirection(this.guidance, r, v, tAcc, t - d.ignitionTime);
    }

    // ---- attitude
    let q: Quat;
    let w: Vec3;
    if (this.fidelity === 'engineering') {
      q = qNormalize([y[6], y[7], y[8], y[9]]);
      w = [y[10], y[11], y[12]];
    } else {
      // Prescribed attitude (idealisation).
      let xb: Vec3;
      if (d.engineOn && guideDir) xb = guideDir;
      else if (V > 1e-3 && rho > 0) xb = scale3(vAir, 1 / V);
      else if (guideDir) xb = guideDir;
      else xb = normalize(v);
      const nrm = orbitNormal(r, v);
      let yb = cross(nrm, xb);
      if (norm(yb) < 1e-9) yb = cross([0, 0, 1], xb);
      yb = normalize(yb);
      const zb = cross(xb, yb);
      q = qFromBasis(xb, yb, zb);
      w = [0, 0, 0];
    }
    const bodyX = qRotate(q, [1, 0, 0]);

    // ---- aerodynamics
    let fAeroB: Vec3 = [0, 0, 0];
    let mAeroB: Vec3 = [0, 0, 0];
    let alpha = 0, qd = 0, mach = 0, kn = 0, normalF = 0, axialF = 0;
    const vb = qRotateInv(q, vAir);
    if (rho > 0 && V > 1e-6) {
      qd = 0.5 * rho * V * V;
      mach = V / aSnd;
      kn = lambda / mp.length;
      alpha = Math.acos(clamp(vb[0] / V, -1, 1));
      const geom = { family: mp.family, fins: mp.fins, length: mp.length, diameter: mp.diameter, refArea: mp.refArea };
      const c = aeroCoefficients(geom, mach, alpha, kn, mp.xcg, this.ac);
      // Guarantee the net aerodynamic force never does positive work relative to the air.
      const sa = Math.sin(alpha), ca = Math.cos(alpha);
      let cn = c.cn;
      const cdNet = c.ca * ca + cn * sa;
      if (cdNet < 0 && sa > 1e-6) cn = -c.ca * ca / sa;
      const qS = qd * mp.refArea;
      axialF = -qS * c.ca;
      const vt = Math.hypot(vb[1], vb[2]);
      let ny = 0, nz = 0;
      if (vt > 1e-9 * V) {
        ny = -vb[1] / vt;
        nz = -vb[2] / vt;
      }
      normalF = qS * cn;
      fAeroB = [axialF, normalF * ny, normalF * nz];
      // Moment of the normal force about the CG: r_cp = (xcg - xcp) x_b.
      const arm = mp.xcg - c.xcp;
      mAeroB = [0, -arm * fAeroB[2], arm * fAeroB[1]];
      if (this.fidelity === 'engineering') {
        // Pitch/yaw damping and roll damping (approximation).
        const L = mp.length;
        const kq = (qS * L * L * c.cmq) / (2 * V);
        mAeroB[1] += kq * w[1];
        mAeroB[2] += kq * w[2];
        const finRoll = mp.fins.panels > 0 ? -2.0 : -0.05;
        mAeroB[0] += (qS * mp.diameter * mp.diameter * finRoll * w[0]) / (2 * V);
      }
    }
    const fAeroI = qRotate(q, fAeroB);

    // ---- thrust direction, TVC and RCS
    let fThrB: Vec3 = [0, 0, 0];
    let mCtrl: Vec3 = [0, 0, 0];
    const tCmd: Vec3 = [0, 0, 0];
    const tTvc: Vec3 = [0, 0, 0];
    const tRcs: Vec3 = [0, 0, 0];
    let gimbal = 0;
    let rcsMdot = 0;
    if (this.fidelity === 'engineering') {
      // Desired direction for the autopilot.
      let des: Vec3 | null = null;
      if (d.engineOn && guideDir) des = guideDir;
      else if (d.attitudeMode === 'guidance' && guideDir) des = guideDir;
      else if (d.attitudeMode === 'hold-air-relative' && V > 1) des = scale3(vAir, 1 / V);
      if (des) {
        const db = qRotateInv(q, des);
        const e: Vec3 = [0, -db[2], db[1]]; // x_b cross d_b
        const en = Math.hypot(e[1], e[2]);
        const ang = Math.atan2(en, db[0]);
        let ey = 0, ez = 0;
        if (en > 1e-12) { ey = e[1] / en; ez = e[2] / en; }
        else if (db[0] < 0) { ey = 1; }
        const rate = Math.min(AUTOPILOT.kp * ang, AUTOPILOT.maxRate);
        const wdy = rate * ey, wdz = rate * ez;
        tCmd[1] = (mp.iyy * (wdy - w[1])) / AUTOPILOT.tauRate;
        tCmd[2] = (mp.iyy * (wdz - w[2])) / AUTOPILOT.tauRate;
        tCmd[0] = (-mp.ixx * w[0]) / AUTOPILOT.rollTau;
      }
      // TVC authority.
      const lNoz = Number.isFinite(mp.xNozzle) ? mp.xNozzle - mp.xcg : 0;
      let fy = 0, fz = 0;
      if (thrust > 0 && lNoz > 0) {
        const s = this.vehicle.stages[d.activeStage].spec;
        const fMax = thrust * Math.sin((s.gimbalMaxDeg * Math.PI) / 180);
        // pitch torque about y = l * F_z ; yaw torque about z = -l * F_y
        let wantFz = tCmd[1] / lNoz;
        let wantFy = -tCmd[2] / lNoz;
        const mag = Math.hypot(wantFy, wantFz);
        if (mag > fMax) { wantFy *= fMax / mag; wantFz *= fMax / mag; }
        fy = wantFy; fz = wantFz;
        tTvc[1] = lNoz * fz;
        tTvc[2] = -lNoz * fy;
        gimbal = Math.asin(Math.min(1, Math.hypot(fy, fz) / thrust));
      }
      if (thrust > 0) {
        const fx = Math.sqrt(Math.max(0, thrust * thrust - fy * fy - fz * fz));
        fThrB = [fx, fy, fz];
      }
      // RCS for the remainder.
      const rcsMax = this.vehicle.rcs.torqueMax;
      if (rcsMax > 0 && y[FS.MRCS] > 0 && (des || Math.abs(w[0]) > 0)) {
        for (let k = 0; k < 3; k++) {
          const rem = tCmd[k] - tTvc[k];
          tRcs[k] = clamp(rem, -rcsMax, rcsMax);
        }
        const isp = this.vehicle.rcs.isp;
        const armPY = Math.max(0.1, mp.rcsArm);
        const armR = Math.max(0.05, mp.diameter);
        rcsMdot = (2 * (Math.abs(tRcs[0]) / armR + Math.abs(tRcs[1]) / armPY + Math.abs(tRcs[2]) / armPY)) / (isp * G0);
      }
      mCtrl = [tTvc[0] + tRcs[0], tTvc[1] + tRcs[1], tTvc[2] + tRcs[2]];
    } else if (thrust > 0) {
      fThrB = [thrust, 0, 0];
    }
    const fThrI = qRotate(q, fThrB);

    // ---- translational dynamics
    const mu_r3 = env.gravity ? -MU_EARTH / (rn * rn * rn) : 0;
    dy[0] = v[0];
    dy[1] = v[1];
    dy[2] = v[2];
    dy[3] = mu_r3 * r[0] + (fAeroI[0] + fThrI[0]) / m;
    dy[4] = mu_r3 * r[1] + (fAeroI[1] + fThrI[1]) / m;
    dy[5] = mu_r3 * r[2] + (fAeroI[2] + fThrI[2]) / m;

    // ---- rotational dynamics
    if (this.fidelity === 'engineering') {
      const qd4 = qDot(q, w);
      dy[6] = qd4[0]; dy[7] = qd4[1]; dy[8] = qd4[2]; dy[9] = qd4[3];
      const Ix = mp.ixx, Iy = mp.iyy;
      const Mx = mAeroB[0] + mCtrl[0];
      const My = mAeroB[1] + mCtrl[1];
      const Mz = mAeroB[2] + mCtrl[2];
      // Euler: I w' = M - w x (I w), I = diag(Ix, Iy, Iy)
      dy[10] = Mx / Ix; // (Iy - Iz) = 0 for axisymmetric bodies
      dy[11] = (My - (Ix - Iy) * w[2] * w[0]) / Iy;
      dy[12] = (Mz - (Iy - Ix) * w[0] * w[1]) / Iy;
    } else {
      dy[6] = dy[7] = dy[8] = dy[9] = 0;
      dy[10] = dy[11] = dy[12] = 0;
    }

    // ---- mass flow
    dy[FS.MPROP] = mprop > 0 ? -mdot : 0;
    dy[FS.MRCS] = y[FS.MRCS] > 0 ? -rcsMdot : 0;

    // ---- heating and thermal network
    const heating = d.aeroshellAttached && rho > 0 && d.environment === 'atmosphere';
    let qSurf = 0, qBody = 0;
    if (heating) {
      stagnationHeating(rho, V, this.vehicle.noseRadius, tAir, aSnd, kn, y[FS.T1], this.heat);
      const qcw = this.heat.qColdWall * this.vehicle.thermal.heatingMultiplier;
      const tr = this.heat.recoveryTemperature;
      const hw = (tw: number): number => (tr > 300 ? Math.max(0, (tr - tw) / (tr - 300)) : 0);
      qSurf = qcw * hw(y[FS.T1]);
      qBody = this.vehicle.thermal.bodyHeatingFraction * qcw * hw(y[FS.T3]);
    } else {
      this.heat.qColdWall = 0;
      this.heat.qStag = 0;
      this.heat.recoveryTemperature = tAir;
      this.heat.flags = 0;
    }
    thermalDerivatives(this.vehicle.thermal, [y[FS.T1], y[FS.T2], y[FS.T3], y[FS.T4]], qSurf, qBody, d.aeroshellAttached, dy, FS.T1);
    dy[FS.HEATLOAD] = qSurf;
    dy[FS.AEROWORK] = dot(fAeroI, vAir);
    dy[FS.THRUSTDV] = thrust / m;

    if (this.capture) {
      const D = this.derived;
      D.t = t;
      D.altitude = altitude;
      const sph = ecefToSpherical(eciToEcef(r, t, env.earthRotation));
      D.lat = sph.lat;
      D.lon = sph.lon;
      D.rho = rho;
      D.pressure = pAmb;
      D.airTemperature = tAir;
      D.speedOfSound = aSnd;
      D.vAir = vAir;
      D.vAirMag = V;
      D.speedInertial = norm(v);
      D.mach = mach;
      D.qDyn = qd;
      D.knudsen = kn;
      D.alpha = alpha;
      Object.assign(D.aero, this.ac);
      D.forceAero = fAeroI;
      D.forceThrust = fThrI;
      D.normalForce = Math.abs(normalF);
      D.axialForce = axialF;
      D.thrust = thrust;
      D.massFlow = mdot;
      D.mass = m;
      D.xcg = mp.xcg;
      D.stabilityMarginCal = rho > 0 ? (this.ac.xcpSmallAlpha - mp.xcg) / mp.diameter : 0;
      const aP: Vec3 = [(fAeroB[0] + fThrB[0]) / m, (fAeroB[1] + fThrB[1]) / m, (fAeroB[2] + fThrB[2]) / m];
      D.aProperBody = aP;
      D.axialG = Math.abs(aP[0]) / G0;
      D.lateralG = Math.hypot(aP[1], aP[2]) / G0;
      // Payload station: add rotational terms  w' x r + w x (w x r),  r = (xcg - xP) x_b.
      const rp: Vec3 = [mp.xcg - mp.xPayload, 0, 0];
      const wd: Vec3 = [dy[10], dy[11], dy[12]];
      const wxr = cross(w, rp);
      const cen = cross(w, wxr);
      const tan = cross(wd, rp);
      const ap: Vec3 = [aP[0] + cen[0] + tan[0], aP[1] + cen[1] + tan[1], aP[2] + cen[2] + tan[2]];
      D.payloadAxialG = Math.abs(ap[0]) / G0;
      D.payloadLateralG = Math.hypot(ap[1], ap[2]) / G0;
      D.heat.qColdWall = this.heat.qColdWall;
      D.heat.qStag = qSurf;
      D.heat.recoveryTemperature = this.heat.recoveryTemperature;
      D.heat.flags = heating ? this.heat.flags : 0;
      D.qSurface = qSurf;
      D.qBody = qBody;
      D.bodyX = bodyX;
      D.attitude = q;
      D.omegaBody = w;
      D.desiredDir = guideDir;
      D.torqueCmd = tCmd;
      D.torqueTvc = tTvc;
      D.torqueRcs = tRcs;
      D.gimbalRad = gimbal;
      D.rcsMassFlow = rcsMdot;
      D.aeroFlags = rho > 0 ? this.ac.flags : 0;
    }
  };
}

function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
