/**
 * Authoritative simulation session: owns the launch sequence
 *   pump-down -> spin-up -> hold -> release -> exit corridor -> flight
 * integrates it with the shared kernel, localises events, records telemetry
 * and extrema, applies timestamped commands, and reports failures by named
 * criterion. It never looks at wall-clock time or frame rate: callers only
 * ask it to advance to a simulated time.
 */
import { G0, OMEGA_EARTH, R_EARTH } from '../physics/constants';
import { Dopri5, IntegrationError, locateRoot } from '../physics/integrator';
import { RS, rotorDerivative, controllerTorque, bearingTorque, gasTorque } from '../physics/rotor';
import { pressureAt } from '../physics/vacuum';
import {
  vehiclePositionEcef, vehicleVelocityEcef, tunnelCoords, exitClearance, radialUnit, tangentAt,
} from '../physics/launcher';
import { ecefToEci, eciToEcef, earthOmegaVec, groundDistance, earthAngle } from '../physics/frames';
import { qFromBasis, qRotate, qRotateInv, qNormalize } from '../physics/quat';
import { FlightModel, FS, type FlightDerived, type FlightDiscrete } from '../physics/flight';
import { orbitalElements, type OrbitElements } from '../physics/orbit';
import { type Vec3, add, cross, dot, norm, scale, sub } from '../physics/vec3';
import { THERMAL_FLAG_LOW_SPEED, THERMAL_FLAG_RAREFIED } from '../physics/thermal';
import { STALL_FRACTION, type Scenario } from './build';
import { TelemetryTable, ROTOR_CHANNELS, FLIGHT_CHANNELS } from './telemetry';

export type Phase = 'pumpdown' | 'spinup' | 'hold' | 'corridor' | 'flight' | 'ended';
export const PHASE_CODE: Record<Phase, number> = { pumpdown: 0, spinup: 1, hold: 2, corridor: 3, flight: 4, ended: 5 };

export type Severity = 'info' | 'achievement' | 'warning' | 'failure' | 'command' | 'phase';

export interface SimEvent {
  t: number;
  kind: string;
  severity: Severity;
  label: string;
  values?: Record<string, number>;
}

export { FAILURE_LABEL, fmtPa, type FailureKind } from './labels';
import { FAILURE_LABEL, fmtPa, type FailureKind } from './labels';

export interface FailureReport {
  kind: FailureKind;
  t: number;
  criterion: string;
  value: number;
  threshold: number;
  unit: string;
  message: string;
  contributing: Array<{ label: string; value: string }>;
}

export type TerminalReason = 'ground-contact' | 'orbit-validated' | 'failure' | 'aborted' | 'max-time' | 'escape' | 'error';

export type CommandKind = 'abort' | 'release' | 'jettison' | 'ignite' | 'cutoff';
export interface TimedCommand {
  t: number;
  kind: CommandKind;
}

export interface Extremum {
  value: number;
  t: number;
  alt?: number;
}

export interface Extrema {
  maxAltitude: Extremum;
  maxQ: Extremum;
  maxMach: Extremum;
  maxHeatFlux: Extremum;
  maxHeatLoad: Extremum;
  maxT1: Extremum;
  maxT3: Extremum;
  maxT4: Extremum;
  maxAxialG: Extremum;
  maxLateralG: Extremum;
  maxPayloadLateralG: Extremum;
  maxPayloadAxialG: Extremum;
  maxNormalForce: Extremum;
  maxAlphaAboveQ: Extremum;
  minClearance: Extremum;
  maxArmStressRatio: Extremum;
  maxSpinLateralG: Extremum;
  maxElectricalPower: Extremum;
  maxSpeedAir: Extremum;
}

const ext = (value: number): Extremum => ({ value, t: NaN });

export interface ReleaseRecord {
  t: number;
  phi: number;
  omega: number;
  tipSpeed: number;
  timingErrorS: number;
  directionErrorRad: number;
  residualPitchRate: number;
  velocityEci: Vec3;
  positionEci: Vec3;
  vehicleKE: number;
  rotorKEBefore: number;
  rotorKEAfter: number;
  bearingLoad: number;
}

export interface EnergyAccount {
  pumpJ: number;
  electricalJ: number;
  mechanicalJ: number;
  motorLossJ: number;
  bearingLossJ: number;
  gasLossJ: number;
  rotorKEAtRelease: number;
  vehicleKEAtRelease: number;
  rotorKEAfterRelease: number;
  recoverableJ: number;
  membraneLossJ: number;
}

export interface Checkpoint {
  t: number;
  phase: Phase;
  state: number[];
  discrete?: FlightDiscrete;
}

export interface RunSummary {
  configName: string;
  modelVersion: string;
  fidelity: string;
  atmosphere: boolean;
  earthRotation: boolean;
  uncertainty: boolean;
  seed: number;
  terminal?: TerminalReason;
  failure?: FailureReport;
  achievements: string[];
  achievementTimes: Record<string, number>;
  release?: ReleaseRecord;
  extrema: Extrema;
  orbit?: OrbitElements & { validated: boolean; insertionTime: number };
  energy: EnergyAccount;
  times: { pumpdown: number; spinup: number; hold: number; corridor: number; flight: number; end: number };
  propellantUsed: number;
  thrustDeltaV: number;
  payloadMass: number;
  payloadIntact: boolean;
  costPerLaunch: number;
  fidelityFlags: string[];
}

interface EventSpec {
  id: string;
  g: (t: number, y: Float64Array) => number;
  dir: 1 | -1;
  active: () => boolean;
  terminal: boolean;
  samples?: number;
  handler: (t: number, y: Float64Array) => void;
}

export interface Snapshot {
  t: number;
  phase: Phase;
  earthAngle: number;
  rotor: {
    phi: number;
    omega: number;
    tipSpeed: number;
    rpm: number;
    aRadialG: number;
    lateralLoadG: number;
    powerElec: number;
    torque: number;
    eElec: number;
    stressRatio: number;
    pressure: number;
    attached: boolean;
  };
  vehicle?: {
    r: Vec3;
    v: Vec3;
    q: [number, number, number, number];
    omegaBody: Vec3;
    altitude: number;
    lat: number;
    lon: number;
    downrange: number;
    vAir: number;
    vInertial: number;
    mach: number;
    qDyn: number;
    alphaDeg: number;
    axialG: number;
    lateralG: number;
    payloadLateralG: number;
    heatFlux: number;
    heatLoad: number;
    temps: [number, number, number, number];
    mass: number;
    propellant: number;
    rcs: number;
    thrust: number;
    gimbalDeg: number;
    stabilityCal: number;
    engineOn: boolean;
    aeroshell: boolean;
    activeStage: number;
    environment: string;
    attitudeMode: string;
    orbit: OrbitElements;
    heatFlags: number;
    aeroFlags: number;
    desiredDir: Vec3 | null;
    clearance: number;
  };
  terminal?: TerminalReason;
  failure?: FailureReport;
}

const PUMP_SAMPLES = 60;

export class Session {
  readonly s: Scenario;
  phase: Phase = 'pumpdown';
  /** Integration frontier: state is known up to here. */
  t = 0;
  readonly events: SimEvent[] = [];
  readonly commandLog: TimedCommand[] = [];
  readonly checkpoints: Checkpoint[] = [];
  failure?: FailureReport;
  terminal?: TerminalReason;
  readonly achievements = new Map<string, number>();
  readonly extrema: Extrema;
  readonly rotorTable = new TelemetryTable(ROTOR_CHANNELS);
  readonly flightTable = new TelemetryTable(FLIGHT_CHANNELS);
  releaseRecord?: ReleaseRecord;
  readonly energy: EnergyAccount;
  orbitInsertion?: { t: number; elements: OrbitElements };
  validatedOrbit?: OrbitElements;
  errorMessage?: string;
  private pending: TimedCommand[];
  private readonly tPump: number;
  private tSpinStart = 0;
  private tHoldStart = NaN;
  private tReleaseEnd = NaN;
  // rotor
  private rotorInt: Dopri5;
  private drive = true;
  private releasePhaseTarget = NaN;
  private manualReleaseAt = NaN;
  private rotorEvents: EventSpec[] = [];
  private susStart: Record<string, number> = {};
  // flight
  flight?: FlightModel;
  private flightInt?: Dopri5;
  private flightEvents: EventSpec[] = [];
  private envelopeRadius: number;
  private ignitionAt = NaN;
  private nextIgnitionTime = NaN;
  private ignitionsUsed: number[] = [];
  private guidanceDone = false;
  private validationEnd = NaN;
  private lastRecord = -Infinity;
  private detailUntil = -Infinity;
  private gCache = new Map<string, number>();
  private memoT = NaN;
  private memoD?: FlightDerived;
  private yTmp = new Float64Array(FS.N);
  private yTmp2 = new Float64Array(FS.N);
  private lastCheckpoint = -Infinity;
  private flightStartT = NaN;

  constructor(scenario: Scenario, commands: TimedCommand[] = []) {
    if (!scenario.ok) throw new Error('Scenario has errors; fix them before launching.');
    this.s = scenario;
    this.pending = [...commands].sort((a, b) => a.t - b.t);
    this.tPump = scenario.derived.pump.time;
    this.extrema = {
      maxAltitude: ext(-Infinity), maxQ: ext(0), maxMach: ext(0), maxHeatFlux: ext(0), maxHeatLoad: ext(0),
      maxT1: ext(0), maxT3: ext(0), maxT4: ext(0), maxAxialG: ext(0), maxLateralG: ext(0),
      maxPayloadLateralG: ext(0), maxPayloadAxialG: ext(0), maxNormalForce: ext(0), maxAlphaAboveQ: ext(0),
      minClearance: ext(Infinity), maxArmStressRatio: ext(0), maxSpinLateralG: ext(0), maxElectricalPower: ext(0),
      maxSpeedAir: ext(0),
    };
    this.energy = {
      pumpJ: 0, electricalJ: 0, mechanicalJ: 0, motorLossJ: 0, bearingLossJ: 0, gasLossJ: 0,
      rotorKEAtRelease: 0, vehicleKEAtRelease: 0, rotorKEAfterRelease: 0, recoverableJ: 0, membraneLossJ: 0,
    };
    const ic = scenario.config.integrator;
    this.rotorInt = new Dopri5(RS.N, (_t, y, dy) => rotorDerivative(scenario.rotor, scenario.rotorDerived, scenario.omegaTarget, this.drive, y, dy), {
      rtol: ic.rtol,
      atol: new Float64Array([1e-9, 1e-9, 1e3, 1e3, 1e3, 1e3]),
      hMax: ic.hMaxRotorS,
      hMin: 1e-12,
    });
    const v = scenario.vehicle;
    this.envelopeRadius = v.diameter / 2 + (v.fins.panels > 0 ? v.finGeom.span : 0);
    this.buildRotorEvents();
    this.log(0, 'pumpdown-start', 'phase', `Pump-down started: target ${fmtPa(scenario.config.launcher.vacuum.targetPressurePa)}, estimated ${fmtDur(this.tPump)}`);
    this.recordRotor(0, new Float64Array(RS.N));
  }

  // ------------------------------------------------------------------ public API
  get ended(): boolean {
    return this.phase === 'ended';
  }

  /** Queue a command. Live commands are applied at the current integration frontier (logged). */
  command(kind: CommandKind, t?: number): TimedCommand {
    const cmd: TimedCommand = { t: Math.max(t ?? this.t, this.t), kind };
    this.pending.push(cmd);
    this.pending.sort((a, b) => a.t - b.t);
    return cmd;
  }

  /**
   * Advance the simulation until the frontier passes tTarget (or the run
   * ends). Steps are never clipped at tTarget, so the solution is
   * independent of how often the caller asks. `budgetMs` bounds wall time.
   */
  advanceTo(tTarget: number, budgetMs = Infinity, now: () => number = defaultNow): void {
    const start = budgetMs < Infinity ? now() : 0;
    let n = 0;
    while (!this.ended && this.t < tTarget) {
      try {
        this.stepOnce(tTarget);
      } catch (e) {
        this.fail({
          kind: 'numerical',
          t: this.t,
          criterion: 'Integrator',
          value: NaN,
          threshold: NaN,
          unit: '',
          message: e instanceof IntegrationError ? `${e.message} at t = ${e.t.toFixed(4)} s (${e.detail}). The configuration drove the solver outside its valid domain.` : String(e),
          contributing: [],
        });
        this.errorMessage = String(e);
        break;
      }
      if (budgetMs < Infinity && ++n % 8 === 0 && now() - start > budgetMs) break;
    }
  }

  /** Run to completion (predictions, tests). */
  runToEnd(maxWallMs = Infinity): void {
    this.advanceTo(Infinity, maxWallMs);
  }

  // ------------------------------------------------------------------ helpers
  private log(t: number, kind: string, severity: Severity, label: string, values?: Record<string, number>): void {
    this.events.push({ t, kind, severity, label, values });
  }

  private achieve(id: string, t: number, label: string): void {
    if (this.achievements.has(id)) return;
    this.achievements.set(id, t);
    this.log(t, id, 'achievement', label);
  }

  private fail(f: FailureReport): void {
    if (this.failure) return;
    this.failure = f;
    this.log(f.t, `failure:${f.kind}`, 'failure', f.message);
    this.end(f.t, 'failure');
  }

  private end(t: number, reason: TerminalReason): void {
    if (this.phase === 'ended') return;
    this.terminal = reason;
    this.t = t;
    this.phase = 'ended';
    this.log(t, `end:${reason}`, reason === 'failure' ? 'failure' : 'phase', `Run ended: ${reason}`);
  }

  private nextCommandTime(): number | undefined {
    return this.pending.length ? this.pending[0].t : undefined;
  }

  private applyDueCommands(): void {
    while (this.pending.length && this.pending[0].t <= this.t + 1e-12) {
      const c = this.pending.shift()!;
      c.t = this.t;
      this.commandLog.push(c);
      this.applyCommand(c);
      if (this.ended) return;
    }
  }

  private applyCommand(c: TimedCommand): void {
    const label = `Command: ${c.kind}`;
    this.log(this.t, `cmd:${c.kind}`, 'command', label);
    switch (c.kind) {
      case 'abort':
        this.drive = false;
        this.end(this.t, 'aborted');
        return;
      case 'release':
        if ((this.phase === 'hold' || this.phase === 'spinup') && this.s.config.launcher.release.mode === 'manual-training') {
          this.manualReleaseAt = this.t + this.s.config.launcher.release.actuatorLatencyS;
          this.resetRotorEventCache();
        } else {
          this.log(this.t, 'cmd-rejected', 'warning', 'Release command ignored: release is phase-locked (automatic) in this configuration.');
        }
        return;
      case 'jettison':
        if (this.flight?.discrete.aeroshellAttached && this.flightInt) this.jettison(this.t, this.flightInt.y, 'command');
        return;
      case 'ignite':
        if (this.flight && this.flightInt && !this.flight.discrete.engineOn) this.ignite(this.t, this.flightInt.y, 'command');
        return;
      case 'cutoff':
        if (this.flight?.discrete.engineOn && this.flightInt) this.cutoff(this.t, this.flightInt.y, 'command');
        return;
    }
  }

  private stepOnce(tTarget: number): void {
    this.applyDueCommands();
    if (this.ended) return;
    switch (this.phase) {
      case 'pumpdown':
        return this.stepPumpdown(tTarget);
      case 'spinup':
      case 'hold':
        return this.stepRotor();
      case 'corridor':
      case 'flight':
        return this.stepFlight();
    }
  }

  // ------------------------------------------------------------------ pump-down
  private stepPumpdown(tTarget: number): void {
    const tEnd = this.tPump;
    const tNext = Math.min(tEnd, Math.max(tTarget, this.t + tEnd / PUMP_SAMPLES), this.nextCommandTime() ?? Infinity);
    // Record decimated pressure samples on the way.
    const dt = tEnd / PUMP_SAMPLES;
    for (let k = Math.floor(this.t / dt) + 1; k * dt < tNext; k++) this.recordRotor(k * dt, new Float64Array(RS.N));
    this.t = tNext;
    this.energy.pumpJ = this.t * this.s.config.launcher.vacuum.pumpPowerW;
    if (this.t >= tEnd) {
      this.recordRotor(this.t, new Float64Array(RS.N));
      this.log(this.t, 'pumpdown-complete', 'phase', `Chamber at ${fmtPa(this.s.config.launcher.vacuum.targetPressurePa)} after ${fmtDur(this.tPump)}`);
      this.phase = 'spinup';
      this.tSpinStart = this.t;
      this.rotorInt.reset(this.t, new Float64Array(RS.N), 0.05);
      this.resetRotorEventCache();
      this.checkpoint();
      this.log(this.t, 'spinup-start', 'phase', `Spin-up started toward ${this.s.config.launcher.targetTipSpeedMps.toFixed(0)} m/s`);
    }
  }

  // ------------------------------------------------------------------ rotor
  private lateralLoadG(omega: number): number {
    return (omega * omega * this.s.config.launcher.armRadiusM + G0) / G0;
  }

  private buildRotorEvents(): void {
    const s = this.s;
    const R = s.config.launcher.armRadiusM;
    const mat = s.rotor.material;
    const sf = s.config.launcher.structure.safetyFactor;
    const factor = Math.max(s.rotorDerived.vehicleArm.stressFactor, s.rotorDerived.counterArm.stressFactor);
    const wWarn = Math.sqrt(mat.ultimateStrength / sf / factor);
    const wFail = Math.sqrt(mat.ultimateStrength / factor);
    const tol = s.config.launcher.release.armingTolerance;
    const env = s.vehicle.envelopes;
    const rotorEvent = (e: EventSpec): void => {
      this.rotorEvents.push(e);
    };
    const wStall = s.stallOmega;
    if (wStall !== null) {
      rotorEvent({
        id: 'drive-stall', dir: 1, terminal: true, active: () => this.phase === 'spinup',
        g: (_t, y) => y[RS.OMEGA] - STALL_FRACTION * wStall,
        handler: (t, y) => {
          const P = s.rotor.motor.electricalPowerW;
          this.fail({
            kind: 'drive-stall', t, criterion: 'Drive cannot reach the target speed', value: y[RS.OMEGA] * R, threshold: s.config.launcher.targetTipSpeedMps, unit: 'm/s',
            message: `Launch aborted: spin-up stalled at ${(y[RS.OMEGA] * R).toFixed(0)} m/s of the ${s.config.launcher.targetTipSpeedMps.toFixed(0)} m/s target. Near ${(wStall * R).toFixed(0)} m/s, bearing friction and drag from the residual gas absorb all ${(P / 1e6).toFixed(1)} MW of drive power, so the arm cannot go faster.`,
            contributing: [
              { label: 'Drive power', value: `${(P / 1e6).toFixed(1)} MW` },
              { label: 'Top speed this drive can hold', value: `${(wStall * R).toFixed(0)} m/s` },
              { label: 'Rotor inertia', value: `${(s.rotorDerived.inertia / 1e6).toFixed(2)} × 10⁶ kg·m²` },
            ],
          });
        },
      });
    }
    rotorEvent({
      id: 'arm-stress-warning', dir: 1, terminal: false, active: () => true,
      g: (_t, y) => y[RS.OMEGA] - wWarn,
      handler: (t, y) => this.log(t, 'arm-stress-warning', 'warning', `Arm stress passed the safety-factor margin (SF ${sf}) at ${(y[RS.OMEGA] * R).toFixed(0)} m/s tip speed. Margin warning only: no fracture is modelled below the failure threshold.`),
    });
    rotorEvent({
      id: 'arm-stress-failure', dir: 1, terminal: true, active: () => true,
      g: (_t, y) => y[RS.OMEGA] - wFail,
      handler: (t, y) => {
        const sig = y[RS.OMEGA] ** 2 * factor;
        this.fail({
          kind: 'structural-limit', t, criterion: 'Arm axial stress (axial-load approximation)', value: sig / 1e6, threshold: mat.ultimateStrength / 1e6, unit: 'MPa',
          message: `Modelled structural limit exceeded: arm axial stress ${(sig / 1e9).toFixed(2)} GPa reached the ${mat.name} threshold ${(mat.ultimateStrength / 1e9).toFixed(2)} GPa at tip speed ${(y[RS.OMEGA] * R).toFixed(0)} m/s, t = ${fmtDur(t)}.`,
          contributing: [
            { label: 'Peak stress location', value: `${s.rotorDerived.vehicleArm.stressMaxAt.toFixed(1)} m from hub` },
            { label: 'Tip mass (vehicle + cradle)', value: `${s.derived.tipMass.toFixed(0)} kg` },
            { label: 'Arm profile', value: `${s.config.launcher.arm.profile}, root/tip area ${s.config.launcher.arm.rootAreaM2}/${s.config.launcher.arm.tipAreaM2} m²` },
            { label: 'Specific strength limit (uniform bar)', value: `${Math.sqrt((2 * mat.ultimateStrength) / mat.density).toFixed(0)} m/s` },
          ],
        });
      },
    });
    const components: Array<{ id: string; name: string; sus: number; peak: number; dur: number }> = [
      { id: 'payload', name: `Payload (${s.payload.name})`, sus: env.payloadLateralSustainedG, peak: env.payloadLateralPeakG, dur: env.sustainedDurationS },
    ];
    if (s.stages.length) components.push({ id: 'stage', name: 'Upper-stage hardware', sus: env.stageLateralSustainedG, peak: env.stageLateralPeakG, dur: env.sustainedDurationS });
    for (const comp of components) {
      rotorEvent({
        id: `${comp.id}-spin-peak`, dir: 1, terminal: true, active: () => true,
        g: (_t, y) => this.lateralLoadG(y[RS.OMEGA]) - comp.peak,
        handler: (t, y) => this.fail({
          kind: 'component-load', t, criterion: `${comp.name} lateral peak`, value: this.lateralLoadG(y[RS.OMEGA]), threshold: comp.peak, unit: 'g',
          message: `Component load envelope exceeded: ${comp.name} lateral load ${this.lateralLoadG(y[RS.OMEGA]).toFixed(0)} g reached its peak limit ${comp.peak.toFixed(0)} g during spin-up (tip speed ${(y[RS.OMEGA] * R).toFixed(0)} m/s).`,
          contributing: [{ label: 'Centripetal acceleration', value: `${((y[RS.OMEGA] ** 2 * R) / G0).toFixed(0)} g + 1 g gravity (worst phase)` }, { label: 'Arm radius', value: `${R} m` }],
        }),
      });
      rotorEvent({
        id: `${comp.id}-spin-sustained-start`, dir: 1, terminal: false, active: () => this.susStart[comp.id] === undefined,
        g: (_t, y) => this.lateralLoadG(y[RS.OMEGA]) - comp.sus,
        handler: (t) => {
          this.susStart[comp.id] = t;
          this.resetRotorEventCache();
          this.log(t, `${comp.id}-sustained`, 'warning', `${comp.name} above its sustained lateral limit ${comp.sus.toFixed(0)} g; it may stay there at most ${comp.dur} s.`);
        },
      });
      rotorEvent({
        id: `${comp.id}-spin-sustained-duration`, dir: 1, terminal: true, active: () => this.susStart[comp.id] !== undefined,
        g: (t) => t - (this.susStart[comp.id] + comp.dur),
        handler: (t, y) => this.fail({
          kind: 'component-load', t, criterion: `${comp.name} sustained lateral load duration`, value: t - this.susStart[comp.id], threshold: comp.dur, unit: 's',
          message: `Component load envelope exceeded: ${comp.name} stayed above its sustained limit ${comp.sus.toFixed(0)} g for ${comp.dur} s (current load ${this.lateralLoadG(y[RS.OMEGA]).toFixed(0)} g). Spin-up and hold last far longer than its duration allowance.`,
          contributing: [{ label: 'Load at failure', value: `${this.lateralLoadG(y[RS.OMEGA]).toFixed(0)} g` }, { label: 'Load-duration rule', value: `> ${comp.sus} g for > ${comp.dur} s` }],
        }),
      });
    }
    rotorEvent({
      id: 'at-speed', dir: 1, terminal: true, active: () => this.phase === 'spinup',
      g: (_t, y) => y[RS.OMEGA] - s.omegaTarget * (1 - tol),
      handler: (t, y) => {
        this.phase = 'hold';
        this.tHoldStart = t;
        this.log(t, 'at-speed', 'phase', `At speed: ${(y[RS.OMEGA] * R).toFixed(1)} m/s tip (${((y[RS.OMEGA] * 60) / (2 * Math.PI)).toFixed(1)} rpm) after ${fmtDur(t - this.tSpinStart)} of spin-up`);
        if (s.config.launcher.release.mode === 'phase-locked') this.armPhaseLock(y);
        this.checkpoint();
      },
    });
    rotorEvent({
      id: 'release', dir: 1, terminal: true,
      active: () => this.phase === 'hold' && (Number.isFinite(this.releasePhaseTarget) || Number.isFinite(this.manualReleaseAt)),
      g: (t, y) => (Number.isFinite(this.manualReleaseAt) ? t - this.manualReleaseAt : y[RS.PHASE] - this.releasePhaseTarget),
      handler: (t, y) => this.doRelease(t, y),
    });
    rotorEvent({
      id: 'manual-release-in-spinup', dir: 1, terminal: true,
      active: () => this.phase === 'spinup' && Number.isFinite(this.manualReleaseAt),
      g: (t) => t - this.manualReleaseAt,
      handler: (t, y) => this.doRelease(t, y),
    });
  }

  private armPhaseLock(y: Float64Array): void {
    const s = this.s;
    const twoPi = 2 * Math.PI;
    const target = s.geometry.phiRelease + s.omegaTarget * s.release.timingErrorS;
    // First crossing at least one full revolution after arming (controller settles).
    const base = y[RS.PHASE] + twoPi;
    const k = Math.ceil((base - target) / twoPi);
    this.releasePhaseTarget = target + k * twoPi;
    this.resetRotorEventCache();
    this.log(this.t, 'release-armed', 'info', `Phase-locked release armed: exit-port phase ${((s.geometry.phiRelease * 180) / Math.PI).toFixed(2)}°, residual timing error ${(s.release.timingErrorS * 1e6).toFixed(1)} µs (offset + seeded jitter)`);
  }

  private resetRotorEventCache(): void {
    for (const e of this.rotorEvents) this.gCache.delete(`r:${e.id}`);
  }

  private stepRotor(): void {
    const integ = this.rotorInt;
    integ.opts.hMax = this.s.config.integrator.hMaxRotorS;
    const tc = this.nextCommandTime();
    const t0 = integ.t;
    const y0 = integ.y.slice();
    integ.step(tc);
    if (integ.t - this.tSpinStart > 6 * 3600) {
      this.fail({
        kind: 'structural-limit', t: integ.t, criterion: 'Spin-up time limit', value: integ.t - this.tSpinStart, threshold: 6 * 3600, unit: 's',
        message: 'Spin-up did not reach the target within 6 hours of simulated time; the drive cannot overcome losses at this target.', contributing: [],
      });
      return;
    }
    const hit = this.detectEvents(this.rotorEvents, 'r', t0, y0, integ.t, integ.y, (t, out) => integ.dense(t, out), RS.N);
    if (hit) {
      const ye = new Float64Array(RS.N);
      integ.dense(hit.t, ye);
      // Fire non-terminal events before it, then the terminal one.
      this.t = hit.t;
      this.updateRotorAccounts(ye);
      this.recordRotor(hit.t, ye);
      for (const e of hit.before) e.spec.handler(e.t, e.y);
      if (this.ended) return;
      hit.spec.handler(hit.t, ye);
      if (this.phase === 'spinup' || this.phase === 'hold') {
        integ.reset(hit.t, ye, Math.max(integ.h, 1e-4));
        this.resetRotorEventCache();
      }
      return;
    }
    this.t = integ.t;
    this.updateRotorAccounts(integ.y);
    this.recordRotor(integ.t, integ.y);
  }

  private updateRotorAccounts(y: Float64Array): void {
    const e = this.energy;
    e.electricalJ = y[RS.E_ELEC];
    e.mechanicalJ = y[RS.E_MECH];
    e.motorLossJ = y[RS.E_ELEC] - y[RS.E_MECH];
    e.bearingLossJ = y[RS.E_BEARING];
    e.gasLossJ = y[RS.E_GAS];
    const pumpRate = this.s.config.launcher.vacuum.pumpPowerW;
    e.pumpJ = this.t * pumpRate; // pumps keep running through spin-up and hold
  }

  private recordRotor(t: number, y: Float64Array): void {
    const s = this.s;
    const w = Math.max(0, y[RS.OMEGA]);
    const R = s.config.launcher.armRadiusM;
    const tq = this.phase === 'pumpdown' ? 0 : this.drive ? controllerTorque(s.rotor, s.rotorDerived, w, s.omegaTarget) : 0;
    const loss = bearingTorque(s.rotor.bearing, w) + gasTorque(s.rotorDerived, w);
    const wd = (tq - loss) / s.rotorDerived.inertia;
    const factor = Math.max(s.rotorDerived.vehicleArm.stressFactor, s.rotorDerived.counterArm.stressFactor);
    const stressRatio = (w * w * factor) / s.rotor.material.ultimateStrength;
    const pElec = (tq * w) / s.rotor.motor.efficiency;
    const p = this.phase === 'pumpdown' ? pressureAt(s.vacuum, t) : s.config.launcher.vacuum.targetPressurePa;
    const latG = w > 0 ? this.lateralLoadG(w) : 1;
    const row = [
      t, PHASE_CODE[this.phase], y[RS.PHASE] % (2 * Math.PI), w, w * R, (w * 60) / (2 * Math.PI), (w * w * R) / G0, latG, wd * R,
      tq, pElec, y[RS.E_ELEC], y[RS.E_MECH], y[RS.E_BEARING], y[RS.E_GAS], 0.5 * s.rotorDerived.inertia * w * w, stressRatio, p,
    ];
    this.rotorTable.push(row);
    const X = this.extrema;
    if (stressRatio > X.maxArmStressRatio.value) X.maxArmStressRatio = { value: stressRatio, t };
    if (latG > X.maxSpinLateralG.value && w > 0) X.maxSpinLateralG = { value: latG, t };
    if (pElec > X.maxElectricalPower.value) X.maxElectricalPower = { value: pElec, t };
  }

  // ------------------------------------------------------------------ release
  private doRelease(t: number, y: Float64Array): void {
    const s = this.s;
    const g = s.geometry;
    const rot = s.config.physics.earthRotation;
    const phi = y[RS.PHASE];
    const omega = y[RS.OMEGA];
    const R = g.armRadius;
    const rEcef = vehiclePositionEcef(g, phi);
    const vRelEcef = vehicleVelocityEcef(g, phi, omega);
    const rEci = ecefToEci(rEcef, t, rot);
    // v_release = omega_E x r + rotor tangential velocity expressed in the inertial frame.
    const vEci = add(cross(earthOmegaVec(rot), rEci), ecefToEci(vRelEcef, t, rot));
    // Attitude: x_b along the tangent (nose forward), z_b radially outward, y_b = z x x = rotor axis.
    const xb = ecefToEci(tangentAt(g.h, g.u, phi), t, rot);
    const zb = ecefToEci(radialUnit(g.h, g.u, phi), t, rot);
    const yb = cross(zb, xb);
    const q = qFromBasis(xb, yb, zb);
    // Inherited angular velocity: rotor rate about the rotor axis (= +y_b), scaled by the mount model, plus Earth rotation.
    const rotorAxisEci = ecefToEci(g.a, t, rot);
    const pitchRate = omega * s.release.residualFraction + s.release.residualErrorRadS;
    const wInertial = add(scale(rotorAxisEci, pitchRate), earthOmegaVec(rot));
    const wBody = qRotateInv(q, wInertial);
    // Rotor bookkeeping: angular speed is continuous (no separation impulse); inertia drops.
    const v = s.vehicle;
    const mWet = s.derived.wetMass;
    const iBefore = s.rotorDerived.inertia;
    let iAfter = iBefore - mWet * R * R - s.rotor.vehicleOwnInertia;
    const ballast = s.release.balance.releasesBallast;
    const Rc = s.rotor.counterRadius;
    if (ballast) iAfter -= ((mWet * R) / Rc) * Rc * Rc;
    const keBefore = 0.5 * iBefore * omega * omega;
    const keAfter = 0.5 * iAfter * omega * omega;
    const vehKE = 0.5 * mWet * (omega * R) ** 2;
    const bearingLoad = ballast ? 0.02 * mWet * omega * omega * R : mWet * omega * omega * R;
    const phiErr = wrapPi(phi - g.phiRelease);
    this.releaseRecord = {
      t, phi, omega, tipSpeed: omega * R, timingErrorS: phiErr / omega, directionErrorRad: phiErr, residualPitchRate: pitchRate,
      velocityEci: vEci, positionEci: rEci, vehicleKE: vehKE, rotorKEBefore: keBefore, rotorKEAfter: keAfter, bearingLoad,
    };
    const E = this.energy;
    E.rotorKEAtRelease = keBefore;
    E.vehicleKEAtRelease = vehKE;
    E.rotorKEAfterRelease = keAfter;
    E.recoverableJ = keAfter * s.config.launcher.regenEfficiency;
    this.log(t, 'release', 'phase', `Release at ${(omega * R).toFixed(1)} m/s: phase error ${((phiErr * 180) / Math.PI).toFixed(4)}° (timing ${(phiErr / omega * 1e6).toFixed(1)} µs), residual pitch rate ${pitchRate.toFixed(3)} rad/s`, {
      tipSpeed: omega * R, phaseErrorDeg: (phiErr * 180) / Math.PI, residualPitchRate: pitchRate,
    });
    this.drive = false;
    if (bearingLoad > s.rotor.bearing.radialLoadLimitN) {
      this.fail({
        kind: 'bearing-envelope', t, criterion: 'Post-release imbalance bearing load', value: bearingLoad / 1e6, threshold: s.rotor.bearing.radialLoadLimitN / 1e6, unit: 'MN',
        message: `Bearing transient-load envelope exceeded at release: the departing ${mWet.toFixed(0)} kg vehicle left an unbalanced static moment of ${(mWet * R).toFixed(0)} kg·m, loading the hub bearing with ${(bearingLoad / 1e6).toFixed(1)} MN (limit ${(s.rotor.bearing.radialLoadLimitN / 1e6).toFixed(1)} MN).`,
        contributing: [
          { label: 'Balance design', value: s.release.balance.name },
          { label: 'Imbalance load', value: 'm_vehicle · ω² · R' },
          { label: 'Possible remedies (untested hypotheses)', value: 'ballast-release counterbalance, a larger bearing, or a lighter vehicle; try one with a counterfactual run' },
        ],
      });
      return;
    }
    // Flight model.
    const env = {
      gravity: true,
      atmosphere: s.atmosphere,
      wind: s.wind,
      atmosphereEnabled: s.config.physics.atmosphere,
      earthRotation: rot,
      chamberDensity: s.rotorDerived.gasDensity,
      chamberTemperature: s.config.launcher.vacuum.chamberTemperatureK,
      chamberPressure: s.config.launcher.vacuum.targetPressurePa,
      terrainAltitude: s.config.site.altitudeM,
    };
    const discrete: FlightDiscrete = {
      environment: 'chamber',
      aeroshellAttached: true,
      activeStage: s.stages.length ? 0 : -1,
      engineOn: false,
      throttle: 1,
      attitudeMode: 'passive',
      ignitionTime: NaN,
    };
    this.flight = new FlightModel(env, v, s.massModel, s.guidance, s.config.fidelity, discrete);
    this.ignitionsUsed = s.stages.map(() => 0);
    const y0 = new Float64Array(FS.N);
    y0.set(rEci, FS.RX);
    y0.set(vEci, FS.VX);
    y0.set(q, FS.QW);
    y0.set(wBody, FS.WX);
    y0[FS.MPROP] = s.stages.length ? s.stages[0].propellantMass : 0;
    y0[FS.MRCS] = v.rcs.propellant;
    const t0K = s.config.launcher.vacuum.chamberTemperatureK;
    y0[FS.T1] = t0K; y0[FS.T2] = t0K; y0[FS.T3] = t0K; y0[FS.T4] = t0K;
    const ic = s.config.integrator;
    const atol = new Float64Array(FS.N);
    const pt = ic.positionTolM;
    atol.fill(1, 0);
    atol[0] = atol[1] = atol[2] = pt;
    atol[3] = atol[4] = atol[5] = pt * 1e-3;
    atol[6] = atol[7] = atol[8] = atol[9] = 1e-9;
    atol[10] = atol[11] = atol[12] = 1e-7;
    atol[FS.MPROP] = 1e-4;
    atol[FS.MRCS] = 1e-5;
    atol[FS.T1] = atol[FS.T2] = atol[FS.T3] = atol[FS.T4] = 1e-3;
    atol[FS.HEATLOAD] = 1e2;
    atol[FS.AEROWORK] = 1e9;
    atol[FS.THRUSTDV] = 1e3;
    if (s.config.fidelity === 'assisted') {
      for (let i = 6; i <= 12; i++) atol[i] = 1e9;
    }
    this.flightInt = new Dopri5(FS.N, this.flight.deriv, { rtol: ic.rtol, atol, hMax: ic.hMaxCorridorS, hMin: 1e-12 });
    this.flightInt.reset(t, y0, Math.min(1e-6, ic.hMaxCorridorS));
    this.phase = 'corridor';
    this.flightStartT = t;
    this.buildFlightEvents();
    this.lastRecord = -Infinity;
    this.detailUntil = t + 0.5;
    this.checkpoint();
    this.recordFlight(t, this.flightInt.y, true);
  }

  // ------------------------------------------------------------------ flight
  private derivedAt(t: number, y: Float64Array): FlightDerived {
    if (this.memoD && t === this.memoT) return this.memoD;
    this.memoT = t;
    this.memoD = this.flight!.evaluate(t, y);
    return this.memoD;
  }

  private clearanceAt(t: number, y: Float64Array): number {
    const s = this.s;
    const rot = s.config.physics.earthRotation;
    const mp = this.flight!.massProps(y);
    const q = qNormalize([y[FS.QW], y[FS.QX], y[FS.QY], y[FS.QZ]]);
    const xb = s.config.fidelity === 'engineering' ? qRotate(q, [1, 0, 0]) : unitVel(y, rot);
    const r: Vec3 = [y[0], y[1], y[2]];
    const nose = add(r, scale(xb, mp.xcg));
    const tail = sub(r, scale(xb, mp.length - mp.xcg));
    return exitClearance(s.geometry, eciToEcef(nose, t, rot), eciToEcef(tail, t, rot), this.envelopeRadius).clearance;
  }

  private tunnelS(t: number, y: Float64Array, which: 'nose' | 'tail'): number {
    const s = this.s;
    const rot = s.config.physics.earthRotation;
    const mp = this.flight!.massProps(y);
    const q = qNormalize([y[FS.QW], y[FS.QX], y[FS.QY], y[FS.QZ]]);
    const xb = s.config.fidelity === 'engineering' ? qRotate(q, [1, 0, 0]) : unitVel(y, rot);
    const r: Vec3 = [y[0], y[1], y[2]];
    const p = which === 'nose' ? add(r, scale(xb, mp.xcg)) : sub(r, scale(xb, mp.length - mp.xcg));
    return tunnelCoords(s.geometry, eciToEcef(p, t, rot)).s;
  }

  private buildFlightEvents(): void {
    const s = this.s;
    const env = s.vehicle.envelopes;
    const fl = this.flight!;
    const G = s.geometry;
    const plan = s.config.flightPlan;
    const ev = (e: EventSpec): void => {
      this.flightEvents.push(e);
    };
    const inCorridor = (): boolean => this.phase === 'corridor';
    const atmo = (): boolean => fl.discrete.environment === 'atmosphere' && s.config.physics.atmosphere;
    // --- corridor
    ev({
      id: 'clearance', dir: -1, terminal: true, samples: 6, active: inCorridor,
      g: (t, y) => Math.min(1e3, this.clearanceAt(t, y)),
      handler: (t, y) => this.exitCollision(t, y),
    });
    ev({
      id: 'nose-exit', dir: 1, terminal: true, active: () => inCorridor() && fl.discrete.environment === 'chamber',
      g: (t, y) => this.tunnelS(t, y, 'nose') - G.sEnd,
      handler: (t, y) => this.membrane(t, y),
    });
    ev({
      id: 'tail-exit', dir: 1, terminal: true, active: inCorridor,
      g: (t, y) => this.tunnelS(t, y, 'tail') - G.sEnd,
      handler: (t) => {
        this.phase = 'flight';
        this.tReleaseEnd = t;
        const minC = this.extrema.minClearance.value;
        this.achieve('clean-release', t, `Clean release: vehicle cleared the exit tunnel (minimum clearance ${(minC * 100).toFixed(1)} cm)`);
        fl.discrete.attitudeMode = plan.coastAttitude === 'hold-air-relative' ? 'hold-air-relative' : 'passive';
        this.checkpoint();
      },
    });
    // --- trajectory milestones
    const terrain = s.config.site.altitudeM;
    ev({
      id: 'ground', dir: -1, terminal: true, active: () => this.phase === 'flight',
      g: (_t, y) => norm3(y) - R_EARTH - terrain,
      handler: (t, y) => {
        const d = this.derivedAt(t, y);
        this.log(t, 'ground-contact', 'info', `Ground contact at ${d.vAirMag.toFixed(0)} m/s, ${(this.downrange(t, y) / 1000).toFixed(1)} km downrange`);
        this.end(t, 'ground-contact');
      },
    });
    ev({
      id: 'apogee', dir: -1, terminal: false, active: () => this.phase === 'flight',
      g: (_t, y) => y[0] * y[3] + y[1] * y[4] + y[2] * y[5],
      handler: (t, y) => this.log(t, 'apogee', 'info', `Apogee ${((norm3(y) - R_EARTH) / 1000).toFixed(2)} km`, { altitude: norm3(y) - R_EARTH }),
    });
    for (const [id, alt, label] of [
      ['alt-30km', 30_000, 'Reached 30 km'],
      ['alt-100km', 100_000, 'Crossed 100 km (the Kármán line). This is an altitude, not an orbit.'],
    ] as Array<[string, number, string]>) {
      ev({
        id, dir: 1, terminal: false, active: () => this.phase === 'flight' && !this.achievements.has(id),
        g: (_t, y) => norm3(y) - R_EARTH - alt,
        handler: (t) => this.achieve(id, t, label),
      });
    }
    ev({
      id: 'escape', dir: 1, terminal: true, active: () => this.phase === 'flight',
      g: (_t, y) => norm3(y) - 3 * R_EARTH,
      handler: (t) => this.end(t, 'escape'),
    });
    ev({
      id: 'max-time', dir: 1, terminal: true, active: () => true,
      g: (t) => t - (this.flightStartT + s.config.maxFlightTimeS),
      handler: (t) => this.end(t, 'max-time'),
    });
    // --- aeroshell jettison
    ev({
      id: 'jettison', dir: 1, terminal: true,
      active: () => this.phase === 'flight' && fl.discrete.aeroshellAttached && plan.jettison.kind === 'altitude',
      g: (_t, y) => norm3(y) - R_EARTH - (plan.jettison.kind === 'altitude' ? plan.jettison.valueM : Infinity),
      handler: (t, y) => this.jettison(t, y, 'altitude'),
    });
    // --- propulsion
    const ign = plan.guidance.ignition;
    ev({
      id: 'ignition', dir: 1, terminal: true,
      active: () => this.phase === 'flight' && s.guidance.mode !== 'none' && !fl.discrete.engineOn && fl.discrete.activeStage === 0 && this.ignitionsUsed[0] === 0 && !this.guidanceDone,
      g: (t, y) => {
        switch (ign.kind) {
          case 'altitude': return norm3(y) - R_EARTH - ign.valueM;
          case 'time-after-release': return t - (this.flightStartT + ign.valueS);
          case 'vertical-speed-below': return ign.valueMps - (y[0] * y[3] + y[1] * y[4] + y[2] * y[5]) / norm3(y);
        }
      },
      handler: (t, y) => this.ignite(t, y, 'condition'),
    });
    ev({
      id: 'staging-ignition', dir: 1, terminal: true,
      active: () => Number.isFinite(this.nextIgnitionTime) && !fl.discrete.engineOn,
      g: (t) => t - this.nextIgnitionTime,
      handler: (t, y) => {
        this.nextIgnitionTime = NaN;
        this.ignite(t, y, 'staging');
      },
    });
    ev({
      id: 'depletion', dir: -1, terminal: true, active: () => fl.discrete.engineOn,
      g: (_t, y) => y[FS.MPROP],
      handler: (t, y) => this.depletion(t, y),
    });
    ev({
      id: 'cutoff', dir: 1, terminal: true,
      active: () => fl.discrete.engineOn && s.guidance.mode !== 'none' && !this.guidanceDone,
      g: (_t, y) => {
        const el = orbitalElements([y[0], y[1], y[2]], [y[3], y[4], y[5]]);
        return el.periapsisAltitude - s.guidance.cutoffPeriapsis;
      },
      handler: (t, y) => this.cutoff(t, y, 'guidance'),
    });
    ev({
      id: 'rcs-depleted', dir: -1, terminal: false, active: () => s.vehicle.rcs.propellant > 0,
      g: (_t, y) => y[FS.MRCS] - 1e-6,
      handler: (t) => this.log(t, 'rcs-depleted', 'warning', 'Reaction-control propellant exhausted: no attitude authority without thrust.'),
    });
    ev({
      id: 'validation', dir: 1, terminal: true, active: () => Number.isFinite(this.validationEnd),
      g: (t) => t - this.validationEnd,
      handler: (t, y) => {
        const el = orbitalElements([y[0], y[1], y[2]], [y[3], y[4], y[5]]);
        this.validatedOrbit = el;
        this.achieve('orbit-validated', t, `Orbit validated by forward propagation: ${(el.periapsisAltitude / 1000).toFixed(1)} × ${(el.apoapsisAltitude / 1000).toFixed(1)} km`);
        this.end(t, 'orbit-validated');
      },
    });
    // --- envelopes
    const th = s.vehicle.thermal;
    const thermalEv = (id: string, idx: number, limit: number, what: string): void => {
      ev({
        id, dir: 1, terminal: true, active: () => fl.discrete.aeroshellAttached,
        g: (_t, y) => y[idx] - limit,
        handler: (t, y) => {
          const d = this.derivedAt(t, y);
          this.fail({
            kind: 'thermal-envelope', t, criterion: what, value: y[idx], threshold: limit, unit: 'K',
            message: `The selected thermal envelope was exceeded: ${what} reached ${limit.toFixed(0)} K at t = ${fmtT(t - this.flightStartT)} after release, altitude ${(d.altitude / 1000).toFixed(1)} km.`,
            contributing: [
              { label: 'Stagnation heat flux', value: `${(d.heat.qStag / 1e6).toFixed(2)} MW/m²` },
              { label: 'Integrated stagnation heat load', value: `${(y[FS.HEATLOAD] / 1e6).toFixed(1)} MJ/m²` },
              { label: 'Air-relative speed / density', value: `${d.vAirMag.toFixed(0)} m/s, ${d.rho.toExponential(2)} kg/m³` },
              { label: 'Nose radius', value: `${(s.vehicle.noseRadius * 100).toFixed(1)} cm` },
              { label: 'Model', value: `Sutton-Graves stagnation correlation + lumped nodes${d.heat.flags & THERMAL_FLAG_LOW_SPEED ? ' (low-speed: limited fidelity)' : ''}` },
            ],
          });
        },
      });
    };
    thermalEv('T1-limit', FS.T1, th.noseMaterial.maxTemperatureK, `nose surface (${th.noseMaterial.name})`);
    thermalEv('T3-limit', FS.T3, th.bodyMaxTemperatureK, 'body skin/TPS');
    thermalEv('T4-limit', FS.T4, th.internalMaxTemperatureK, 'payload bay interior');
    const loadEv = (id: string, get: (d: FlightDerived) => number, limit: number, what: string, kind: FailureKind, unit: string, active: () => boolean): void => {
      if (!Number.isFinite(limit)) return;
      ev({
        id, dir: 1, terminal: true, samples: 2, active,
        g: (t, y) => get(this.derivedAt(t, y)) - limit,
        handler: (t, y) => {
          const d = this.derivedAt(t, y);
          this.fail({
            kind, t, criterion: what, value: get(d), threshold: limit, unit,
            message: `${FAILURE_LABEL[kind]}: ${what} reached ${fmtNum(limit)} ${unit} at t = ${fmtT(t - this.flightStartT)} after release (altitude ${(d.altitude / 1000).toFixed(2)} km).`,
            contributing: [
              { label: 'Dynamic pressure', value: `${(d.qDyn / 1e3).toFixed(1)} kPa` },
              { label: 'Total angle of attack', value: `${((d.alpha * 180) / Math.PI).toFixed(1)}°` },
              { label: 'Mach', value: d.mach.toFixed(2) },
              { label: 'Body rates', value: `${norm(d.omegaBody).toFixed(2)} rad/s` },
              { label: 'Static margin', value: `${d.stabilityMarginCal.toFixed(2)} cal` },
            ],
          });
        },
      });
    };
    const flying = (): boolean => this.phase === 'flight' || this.phase === 'corridor';
    loadEv('payload-axial', (d) => d.payloadAxialG, env.payloadAxialPeakG, 'payload axial acceleration', 'component-load', 'g', flying);
    loadEv('payload-lateral', (d) => d.payloadLateralG, env.payloadLateralPeakG, 'payload lateral acceleration', 'component-load', 'g', flying);
    loadEv('stage-lateral', (d) => d.lateralG, env.stageLateralPeakG, 'upper-stage lateral acceleration', 'component-load', 'g', () => flying() && fl.discrete.activeStage >= 0);
    loadEv('stage-axial', (d) => d.axialG, env.stageAxialPeakG, 'upper-stage axial acceleration', 'component-load', 'g', () => flying() && fl.discrete.activeStage >= 0);
    loadEv('q-limit', (d) => d.qDyn, env.maxDynamicPressurePa, 'dynamic pressure', 'aero-overload', 'Pa', () => flying() && atmo() && fl.discrete.aeroshellAttached);
    loadEv('normal-force', (d) => d.normalForce, env.maxNormalForceN, 'aerodynamic normal force', 'aero-overload', 'N', () => flying() && atmo() && fl.discrete.aeroshellAttached);
    ev({
      id: 'aoa-envelope', dir: 1, terminal: true, samples: 2, active: () => this.phase === 'flight' && atmo() && s.config.fidelity === 'engineering',
      g: (t, y) => {
        const d = this.derivedAt(t, y);
        return Math.min((d.alpha - env.maxAngleOfAttackRad) / env.maxAngleOfAttackRad, (d.qDyn - env.angleLimitAboveQPa) / env.angleLimitAboveQPa);
      },
      handler: (t, y) => {
        const d = this.derivedAt(t, y);
        this.fail({
          kind: 'unstable-flight', t, criterion: 'Angle of attack above dynamic-pressure threshold', value: (d.alpha * 180) / Math.PI, threshold: (env.maxAngleOfAttackRad * 180) / Math.PI, unit: '°',
          message: `Unstable flight outside the allowed envelope: angle of attack ${((d.alpha * 180) / Math.PI).toFixed(1)}° exceeded ${((env.maxAngleOfAttackRad * 180) / Math.PI).toFixed(0)}° while dynamic pressure was ${(d.qDyn / 1e3).toFixed(0)} kPa (threshold ${(env.angleLimitAboveQPa / 1e3).toFixed(0)} kPa).`,
          contributing: [
            { label: 'Static margin', value: `${d.stabilityMarginCal.toFixed(2)} calibers (${d.stabilityMarginCal > 0 ? 'stable' : 'UNSTABLE: centre of pressure ahead of CG'})` },
            { label: 'Body rates', value: `${norm(d.omegaBody).toFixed(2)} rad/s` },
            { label: 'Residual pitch rate at release', value: `${(this.releaseRecord?.residualPitchRate ?? 0).toFixed(3)} rad/s` },
            { label: 'Mach', value: d.mach.toFixed(2) },
          ],
        });
      },
    });
  }

  private capsuleEcef(t: number, y: Float64Array): { nose: Vec3; tail: Vec3 } {
    const s = this.s;
    const rot = s.config.physics.earthRotation;
    const mp = this.flight!.massProps(y);
    const q = qNormalize([y[FS.QW], y[FS.QX], y[FS.QY], y[FS.QZ]]);
    const xb = s.config.fidelity === 'engineering' ? qRotate(q, [1, 0, 0]) : unitVel(y, rot);
    const r: Vec3 = [y[0], y[1], y[2]];
    return { nose: eciToEcef(add(r, scale(xb, mp.xcg)), t, rot), tail: eciToEcef(sub(r, scale(xb, mp.length - mp.xcg)), t, rot) };
  }

  private exitCollision(t: number, y: Float64Array): void {
    const s = this.s;
    const fl = this.flight!;
    const rel = this.releaseRecord!;
    const g = s.geometry;
    const cap = this.capsuleEcef(t, y);
    const ex = exitClearance(g, cap.nose, cap.tail, this.envelopeRadius);
    const contributing = [
      { label: 'Release timing error', value: `${(rel.timingErrorS * 1e6).toFixed(1)} µs → direction error ${((rel.directionErrorRad * 180) / Math.PI).toFixed(3)}° (ω·Δt)` },
      { label: 'Residual pitch rate', value: `${rel.residualPitchRate.toFixed(3)} rad/s (${s.release.mount.name})` },
      { label: 'Aperture radius / envelope radius', value: `${(g.apertureRadius * 100).toFixed(0)} cm / ${(this.envelopeRadius * 100).toFixed(0)} cm` },
      { label: 'Path to tunnel exit', value: `${g.sEnd.toFixed(1)} m` },
    ];
    if (ex.region === 'chamber') {
      this.extrema.minClearance = { value: ex.clearance, t };
      const r3: Vec3 = [y[0], y[1], y[2]];
      const v = norm(sub([y[3], y[4], y[5]], cross(earthOmegaVec(s.config.physics.earthRotation), r3)));
      this.fail({
        kind: 'exit-collision', t, criterion: 'Swept vehicle envelope vs chamber wall', value: (rel.directionErrorRad * 180) / Math.PI, threshold: 0, unit: '° phase error',
        message: `Exit clearance failed: vehicle envelope struck the chamber wall at t = ${((t - rel.t) * 1000).toFixed(2)} ms after release (${v.toFixed(0)} m/s relative to the ground). Release phase was ${((rel.directionErrorRad * 180) / Math.PI).toFixed(2)}° away from the exit port.`,
        contributing,
      });
      return;
    }
    // Predict the port penetration depth with a collision-free copy of the trajectory through the tunnel.
    const saved = { ...fl.discrete };
    const ghost = new Dopri5(FS.N, fl.deriv, { ...this.flightInt!.opts });
    ghost.reset(t, y, 1e-6);
    let minC = ex.clearance;
    let tMin = t;
    const ys = new Float64Array(FS.N);
    const tMax = t + (3 * (g.sEnd + s.vehicle.length)) / Math.max(1, norm([y[3], y[4], y[5]]));
    for (let i = 0; i < 20000 && ghost.t < tMax; i++) {
      const ta = ghost.t;
      ghost.step();
      for (let k = 1; k <= 4; k++) {
        const tt = ta + ((ghost.t - ta) * k) / 4;
        ghost.dense(tt, ys);
        const c2 = this.capsuleEcef(tt, ys);
        const c = exitClearance(g, c2.nose, c2.tail, this.envelopeRadius).clearance;
        if (c < minC) { minC = c; tMin = tt; }
      }
      if (this.tunnelS(ghost.t, ghost.y, 'tail') > g.sEnd) break;
    }
    fl.discrete = saved;
    const pen = -minC;
    this.extrema.minClearance = { value: minC, t: tMin };
    this.fail({
      kind: 'exit-collision', t, criterion: 'Swept vehicle envelope vs exit tunnel', value: pen * 100, threshold: 0, unit: 'cm',
      message: `Exit clearance failed: predicted vehicle envelope intersects the port by ${(pen * 100).toFixed(1)} cm at t = ${((t - rel.t) * 1000).toFixed(2)} ms after release.`,
      contributing,
    });
  }

  private membrane(t: number, y: Float64Array): void {
    const s = this.s;
    const fl = this.flight!;
    const rot = s.config.physics.earthRotation;
    const mem = s.config.launcher.exit.membraneArealDensityKgM2 * Math.PI * s.geometry.apertureRadius ** 2;
    const mp = fl.massProps(y);
    const r: Vec3 = [y[0], y[1], y[2]];
    const v: Vec3 = [y[3], y[4], y[5]];
    const corot = cross(earthOmegaVec(rot), r);
    const vg = sub(v, corot);
    const f = mp.mass / (mp.mass + mem);
    const vg2 = scale(vg, f);
    const v2 = add(corot, vg2);
    const lost = 0.5 * mp.mass * (dot(vg, vg) - dot(vg2, vg2));
    this.energy.membraneLossJ = lost;
    y[3] = v2[0]; y[4] = v2[1]; y[5] = v2[2];
    fl.discrete.environment = 'atmosphere';
    this.log(t, 'membrane', 'info', `Nose through exit membrane into ${s.config.physics.atmosphere ? 'atmosphere' : 'vacuum (atmosphere disabled)'}: Δv = ${(norm(vg) - norm(vg2)).toFixed(2)} m/s, ${(lost / 1e3).toFixed(1)} kJ to membrane (gas-flow transient not modelled)`);
  }

  private jettison(t: number, y: Float64Array, why: string): void {
    const fl = this.flight!;
    if (!fl.discrete.aeroshellAttached) return;
    fl.discrete.aeroshellAttached = false;
    if (this.s.guidance.mode !== 'none' && !fl.discrete.engineOn && !this.guidanceDone) fl.discrete.attitudeMode = 'guidance';
    const mp = fl.massProps(y);
    this.log(t, 'jettison', 'info', `Aeroshell jettisoned (${why}) at ${((norm3(y) - R_EARTH) / 1000).toFixed(1)} km; remaining stack ${mp.mass.toFixed(1)} kg`);
    this.resetFlight(t, y);
  }

  private ignite(t: number, y: Float64Array, why: string): void {
    const fl = this.flight!;
    const k = fl.discrete.activeStage;
    if (k < 0) return;
    const spec = this.s.stages[k];
    if (this.ignitionsUsed[k] >= spec.maxIgnitions) {
      this.log(t, 'ignition-refused', 'warning', `Ignition refused: ${spec.name} has no ignitions left (${spec.maxIgnitions} allowed).`);
      return;
    }
    if (y[FS.MPROP] <= 0) return;
    this.ignitionsUsed[k]++;
    fl.discrete.engineOn = true;
    fl.discrete.ignitionTime = t;
    fl.discrete.attitudeMode = 'guidance';
    if (!Number.isFinite(this.ignitionAt)) this.ignitionAt = t;
    this.detailUntil = t + 0.5;
    this.log(t, 'ignition', 'phase', `${spec.name} ignition (${why}) at ${((norm3(y) - R_EARTH) / 1000).toFixed(1)} km`);
    this.resetFlight(t, y);
  }

  private cutoff(t: number, y: Float64Array, why: string): void {
    const fl = this.flight!;
    fl.discrete.engineOn = false;
    const el = orbitalElements([y[0], y[1], y[2]], [y[3], y[4], y[5]]);
    if (why === 'guidance') {
      this.guidanceDone = true;
      fl.discrete.attitudeMode = 'passive';
      this.log(t, 'cutoff', 'phase', `Guidance cutoff: osculating orbit ${(el.periapsisAltitude / 1000).toFixed(1)} × ${el.apoapsisAltitude === Infinity ? '∞' : (el.apoapsisAltitude / 1000).toFixed(1)} km`);
      if (el.bound && !el.intersectsEarth) {
        this.orbitInsertion = { t, elements: el };
        this.achieve('orbit-insertion', t, `Orbit insertion: periapsis ${(el.periapsisAltitude / 1000).toFixed(1)} km, apoapsis ${(el.apoapsisAltitude / 1000).toFixed(1)} km, inclination ${(((el.inclination ?? 0) * 180) / Math.PI).toFixed(2)}°`);
        this.validationEnd = t + this.s.config.orbitValidationRevs * el.period;
        this.log(t, 'validation-start', 'info', `Forward-propagating ${this.s.config.orbitValidationRevs} orbit(s) (${fmtDur(this.s.config.orbitValidationRevs * el.period)}) with drag to validate`);
      }
    } else {
      this.log(t, 'cutoff', 'command', `Engine cutoff (${why})`);
    }
    this.resetFlight(t, y);
  }

  private depletion(t: number, y: Float64Array): void {
    const s = this.s;
    const fl = this.flight!;
    const k = fl.discrete.activeStage;
    y[FS.MPROP] = 0;
    fl.discrete.engineOn = false;
    this.log(t, 'burnout', 'info', `${s.stages[k].name} propellant depleted`);
    if (k + 1 < s.stages.length) {
      if (fl.discrete.aeroshellAttached) {
        fl.discrete.aeroshellAttached = false;
        this.log(t, 'jettison', 'info', 'Aeroshell jettisoned automatically for stage separation');
      }
      fl.discrete.activeStage = k + 1;
      y[FS.MPROP] = s.stages[k + 1].propellantMass;
      fl.discrete.attitudeMode = 'guidance';
      this.nextIgnitionTime = t + s.config.flightPlan.guidance.stagingCoastS;
      this.log(t, 'staging', 'phase', `Stage separation: ${s.stages[k].name} dropped; ${s.stages[k + 1].name} ignites in ${s.config.flightPlan.guidance.stagingCoastS} s`);
      this.resetFlight(t, y);
      return;
    }
    fl.discrete.activeStage = k; // empty last stage stays attached
    if (s.guidance.mode !== 'none' && !this.guidanceDone) {
      const el = orbitalElements([y[0], y[1], y[2]], [y[3], y[4], y[5]]);
      this.fail({
        kind: 'propellant-exhausted', t, criterion: 'Osculating periapsis at burnout', value: el.periapsisAltitude / 1000, threshold: s.guidance.cutoffPeriapsis / 1000, unit: 'km',
        message: `Propellant exhausted before target orbit: periapsis ${(el.periapsisAltitude / 1000).toFixed(1)} km < required ${(s.guidance.cutoffPeriapsis / 1000).toFixed(0)} km (apoapsis ${el.apoapsisAltitude === Infinity ? '∞' : (el.apoapsisAltitude / 1000).toFixed(0) + ' km'}).`,
        contributing: [
          { label: 'Ideal Δv available', value: `${s.derived.idealDeltaV.toFixed(0)} m/s` },
          { label: 'Thrust Δv delivered', value: `${y[FS.THRUSTDV].toFixed(0)} m/s` },
          { label: 'Inertial speed at burnout', value: `${norm([y[3], y[4], y[5]]).toFixed(0)} m/s` },
          { label: 'Circular speed at this altitude', value: `${Math.sqrt(3.986004418e14 / norm3(y)).toFixed(0)} m/s` },
        ],
      });
      return;
    }
    this.resetFlight(t, y);
  }

  private resetFlight(t: number, y: Float64Array): void {
    this.flightInt!.reset(t, y, Math.max(1e-6, Math.min(this.flightInt!.h, 1e-3)));
    this.gCache.clear();
    this.memoT = NaN;
    this.detailUntil = Math.max(this.detailUntil, t + 0.2);
    this.recordFlight(t, this.flightInt!.y, true);
  }

  private flightStepCap(y: Float64Array): number {
    const ic = this.s.config.integrator;
    const fl = this.flight!;
    if (this.phase === 'corridor') return ic.hMaxCorridorS;
    if (fl.discrete.engineOn) return ic.hMaxBurnS;
    const alt = norm3(y) - R_EARTH;
    if (this.s.config.physics.atmosphere && alt < 140_000) return ic.hMaxAtmosphereS * (alt < 90_000 ? 1 : 10);
    if (fl.discrete.attitudeMode === 'guidance' && this.s.config.fidelity === 'engineering') return Math.min(ic.hMaxCoastS, 1);
    return ic.hMaxCoastS;
  }

  private stepFlight(): void {
    const integ = this.flightInt!;
    integ.opts.hMax = this.flightStepCap(integ.y);
    const tc = this.nextCommandTime();
    const t0 = integ.t;
    const y0 = integ.y.slice();
    integ.step(tc);
    // Quaternion renormalisation (projection), keeps |q| = 1 to machine precision.
    if (this.s.config.fidelity === 'engineering') {
      const yy = integ.y;
      const n = Math.hypot(yy[6], yy[7], yy[8], yy[9]);
      if (Math.abs(n - 1) > 1e-13) integ.projectState((st) => { st[6] /= n; st[7] /= n; st[8] /= n; st[9] /= n; });
    }
    const hit = this.detectEvents(this.flightEvents, 'f', t0, y0, integ.t, integ.y, (t, out) => integ.dense(t, out), FS.N);
    if (hit) {
      const ye = new Float64Array(FS.N);
      integ.dense(hit.t, ye);
      this.t = hit.t;
      this.trackFlight(hit.t, ye);
      this.recordFlight(hit.t, ye, true);
      for (const e of hit.before) e.spec.handler(e.t, e.y);
      if (this.ended) return;
      // Default: continue from the event state unless the handler re-initialised.
      const before = integ.t;
      hit.spec.handler(hit.t, ye);
      if (!this.ended && integ.t === before) {
        integ.reset(hit.t, ye, Math.max(1e-6, Math.min(integ.h, 1e-3)));
        this.gCache.clear();
      }
      return;
    }
    // Exit-corridor clearance minimum at solver resolution: sample the step's
    // dense output, then refine the bracketing minimum by golden-section search.
    if (this.phase === 'corridor') this.refineClearanceMin(t0, integ.t);
    // Interior extrema sampling at solver resolution (atmospheric flight).
    if (this.flight!.discrete.environment === 'atmosphere' && this.s.config.physics.atmosphere && norm3(integ.y) - R_EARTH < 120_000) {
      integ.dense(0.5 * (t0 + integ.t), this.yTmp2);
      this.trackFlight(0.5 * (t0 + integ.t), this.yTmp2);
    }
    this.t = integ.t;
    this.trackFlight(integ.t, integ.y);
    this.recordFlight(integ.t, integ.y, false);
    if (integ.t - this.lastCheckpoint > 60) this.checkpoint();
  }

  private refineClearanceMin(ta: number, tb: number): void {
    const integ = this.flightInt!;
    const y = this.yTmp2;
    const f = (t: number): number => this.clearanceAt(t, integ.dense(t, y));
    const n = 8;
    let bi = 0, bv = Infinity;
    const vals: number[] = [];
    for (let k = 0; k <= n; k++) {
      const v = f(ta + ((tb - ta) * k) / n);
      vals.push(v);
      if (v < bv) { bv = v; bi = k; }
    }
    if (!Number.isFinite(bv)) return;
    let lo = ta + ((tb - ta) * Math.max(0, bi - 1)) / n;
    let hi = ta + ((tb - ta) * Math.min(n, bi + 1)) / n;
    const gr = (Math.sqrt(5) - 1) / 2;
    let c = hi - gr * (hi - lo), d = lo + gr * (hi - lo);
    let fc = f(c), fd = f(d);
    for (let it = 0; it < 40 && hi - lo > 1e-9; it++) {
      if (fc < fd) { hi = d; d = c; fd = fc; c = hi - gr * (hi - lo); fc = f(c); }
      else { lo = c; c = d; fc = fd; d = lo + gr * (hi - lo); fd = f(d); }
    }
    const tm = fc < fd ? c : d;
    const vm = Math.min(fc, fd, bv);
    if (vm < this.extrema.minClearance.value) this.extrema.minClearance = { value: vm, t: vm === bv ? ta + ((tb - ta) * bi) / n : tm };
  }

  /** Update solver-resolution extrema. */
  private trackFlight(t: number, y: Float64Array): void {
    const d = this.derivedAt(t, y);
    const X = this.extrema;
    const up = (k: keyof Extrema, v: number, alt?: number): void => {
      if (v > X[k].value) X[k] = { value: v, t, alt };
    };
    up('maxAltitude', d.altitude);
    up('maxQ', d.qDyn, d.altitude);
    up('maxMach', d.mach);
    up('maxHeatFlux', d.heat.qStag, d.altitude);
    up('maxHeatLoad', y[FS.HEATLOAD]);
    if (this.flight!.discrete.aeroshellAttached) {
      up('maxT1', y[FS.T1]);
      up('maxT3', y[FS.T3]);
    }
    up('maxT4', y[FS.T4]);
    up('maxAxialG', d.axialG, d.altitude);
    up('maxLateralG', d.lateralG, d.altitude);
    up('maxPayloadLateralG', d.payloadLateralG, d.altitude);
    up('maxPayloadAxialG', d.payloadAxialG, d.altitude);
    up('maxNormalForce', d.normalForce, d.altitude);
    up('maxSpeedAir', d.vAirMag);
    if (d.qDyn > this.s.vehicle.envelopes.angleLimitAboveQPa) up('maxAlphaAboveQ', d.alpha);
    if (this.phase === 'corridor') {
      const c = this.clearanceAt(t, y);
      if (c < X.minClearance.value) X.minClearance = { value: c, t };
    }
  }

  private downrange(t: number, y: Float64Array): number {
    const rot = this.s.config.physics.earthRotation;
    return groundDistance(eciToEcef([y[0], y[1], y[2]], t, rot), this.s.geometry.hubEcef);
  }

  private recordFlight(t: number, y: Float64Array, force: boolean): void {
    const fl = this.flight!;
    let interval: number;
    if (this.phase === 'corridor' || t < this.detailUntil) interval = 0;
    else if (fl.discrete.engineOn) interval = 0.2;
    else if (this.s.config.physics.atmosphere && norm3(y) - R_EARTH < 100_000) interval = 0.02;
    else if (Number.isFinite(this.validationEnd)) interval = 20;
    else interval = 1;
    if (!force && t - this.lastRecord < interval) return;
    this.lastRecord = t;
    const d = this.derivedAt(t, y);
    const el = orbitalElements([y[0], y[1], y[2]], [y[3], y[4], y[5]]);
    const flags = (d.heat.flags & 0xff) | ((d.aeroFlags & 0xff) << 8);
    const clearance = this.phase === 'corridor' ? this.clearanceAt(t, y) : NaN;
    const row = [
      t, PHASE_CODE[this.phase], y[0], y[1], y[2], y[3], y[4], y[5], d.altitude, d.lat, d.lon, this.downrange(t, y),
      d.vAirMag, d.speedInertial, d.mach, d.qDyn, (d.alpha * 180) / Math.PI, d.axialG, d.lateralG, d.payloadLateralG, d.payloadAxialG,
      d.heat.qStag, y[FS.HEATLOAD], y[FS.T1], y[FS.T2], y[FS.T3], y[FS.T4], d.mass, y[FS.MPROP], y[FS.MRCS], d.thrust, (d.gimbalRad * 180) / Math.PI,
      el.periapsisAltitude, Number.isFinite(el.apoapsisAltitude) ? el.apoapsisAltitude : NaN, el.eccentricity, el.inclination === null ? NaN : (el.inclination * 180) / Math.PI,
      el.specificEnergy, y[6], y[7], y[8], y[9], y[10], y[11], y[12],
      d.stabilityMarginCal, d.normalForce, d.knudsen, d.rho, flags, y[FS.AEROWORK], y[FS.THRUSTDV], Number.isFinite(clearance) ? clearance : NaN,
    ];
    this.flightTable.push(row);
  }

  private checkpoint(): void {
    this.lastCheckpoint = this.t;
    if (this.phase === 'spinup' || this.phase === 'hold') {
      this.checkpoints.push({ t: this.t, phase: this.phase, state: Array.from(this.rotorInt.y) });
    } else if (this.flightInt) {
      this.checkpoints.push({ t: this.t, phase: this.phase, state: Array.from(this.flightInt.y), discrete: { ...this.flight!.discrete } });
    }
  }

  // ------------------------------------------------------------------ events
  private detectEvents(
    specs: EventSpec[],
    prefix: string,
    t0: number,
    y0: Float64Array,
    t1: number,
    y1: Float64Array,
    dense: (t: number, out: Float64Array) => Float64Array,
    n: number,
  ): { t: number; spec: EventSpec; before: Array<{ t: number; spec: EventSpec; y: Float64Array }> } | null {
    const found: Array<{ t: number; spec: EventSpec; y: Float64Array }> = [];
    const ya = new Float64Array(n);
    const yb = new Float64Array(n);
    const tTol = Math.max(1e-10, 1e-12 * Math.abs(t1));
    this.memoT = NaN;
    for (const e of specs) {
      if (!e.active()) {
        this.gCache.delete(`${prefix}:${e.id}`);
        continue;
      }
      const key = `${prefix}:${e.id}`;
      let gPrev = this.gCache.get(key);
      if (gPrev === undefined || !Number.isFinite(gPrev)) gPrev = e.g(t0, y0);
      const ns = e.samples ?? 0;
      let ta = t0, ga = gPrev;
      let crossed = false;
      for (let k = 1; k <= ns + 1; k++) {
        const tb = k === ns + 1 ? t1 : t0 + ((t1 - t0) * k) / (ns + 1);
        const yy = k === ns + 1 ? y1 : dense(tb, yb);
        const gb = e.g(tb, yy);
        const sign = e.dir === 1 ? ga < 0 && gb >= 0 : ga > 0 && gb <= 0;
        if (sign) {
          const root = locateRoot((tt) => e.g(tt, dense(tt, ya)), ta, tb, ga, gb, tTol);
          const yr = new Float64Array(n);
          dense(root, yr);
          found.push({ t: root, spec: e, y: yr });
          crossed = true;
          break;
        }
        ta = tb;
        ga = gb;
      }
      if (!crossed) this.gCache.set(key, ga);
    }
    if (!found.length) return null;
    found.sort((a, b) => a.t - b.t);
    const firstTerminal = found.find((f) => f.spec.terminal);
    if (!firstTerminal) {
      // Only non-terminal events: fire them now, keep stepping.
      for (const f of found) {
        f.spec.handler(f.t, f.y);
        this.gCache.delete(`${prefix}:${f.spec.id}`);
        this.gCache.set(`${prefix}:${f.spec.id}`, f.spec.g(t1, y1));
      }
      return null;
    }
    const before = found.filter((f) => !f.spec.terminal && f.t <= firstTerminal.t);
    this.gCache.clear();
    return { t: firstTerminal.t, spec: firstTerminal.spec, before };
  }

  // ------------------------------------------------------------------ snapshots
  /** Phase in effect at time t, from recorded transition times (the frontier may be ahead of the display). */
  phaseAt(t: number): Phase {
    if (this.phase === 'ended' && t >= this.t) return 'ended';
    if (t < this.tPump) return 'pumpdown';
    if (!Number.isFinite(this.tHoldStart) || t < this.tHoldStart) return 'spinup';
    if (!this.releaseRecord || t < this.releaseRecord.t) return 'hold';
    if (!Number.isFinite(this.tReleaseEnd) || t < this.tReleaseEnd) return 'corridor';
    return 'flight';
  }

  snapshotAt(tDisplay: number): Snapshot {
    const s = this.s;
    this.memoT = NaN; // evaluate() below reuses the shared derived scratch
    const tD = Math.min(tDisplay, this.t);
    const displayPhase = this.phaseAt(tD);
    const rot = s.config.physics.earthRotation;
    const R = s.config.launcher.armRadiusM;
    const reachedEnd = this.phase === 'ended' && tD >= this.t;
    const snap: Snapshot = {
      t: tD,
      phase: displayPhase,
      earthAngle: earthAngle(tD, rot),
      rotor: { phi: 0, omega: 0, tipSpeed: 0, rpm: 0, aRadialG: 0, lateralLoadG: 1, powerElec: 0, torque: 0, eElec: 0, stressRatio: 0, pressure: 101325, attached: !this.releaseRecord },
      terminal: reachedEnd ? this.terminal : undefined,
      failure: this.failure && this.failure.t <= tD ? this.failure : undefined,
    };
    // Rotor state from telemetry (dense where available).
    const rt = this.rotorTable;
    if (rt.length) {
      let row = rt.rowAt(tD);
      const ti = rt.get('t', row);
      let phi = rt.get('phi', row);
      let omega = rt.get('omega', row);
      if (this.phase === 'spinup' || this.phase === 'hold') {
        const integ = this.rotorInt;
        if (tD >= integ.t0 && tD <= integ.t1 && integ.t1 > integ.t0) {
          const yy = integ.dense(tD, new Float64Array(RS.N));
          phi = yy[RS.PHASE] % (2 * Math.PI);
          omega = yy[RS.OMEGA];
        } else {
          phi = (phi + omega * (tD - ti)) % (2 * Math.PI);
        }
      } else if (this.releaseRecord) {
        // After release the drive is off; the rotor coasts (losses neglected for display).
        // Also covers a failure at the release instant, before any flight exists.
        const rr = this.releaseRecord;
        omega = rr.omega;
        phi = (rr.phi + rr.omega * (tD - rr.t)) % (2 * Math.PI);
        row = rt.length - 1;
      } else {
        // Ended without a release (e.g. a failure during spin-up): advance from the last row.
        phi = (phi + omega * (tD - ti)) % (2 * Math.PI);
      }
      snap.rotor = {
        phi, omega, tipSpeed: omega * R, rpm: (omega * 60) / (2 * Math.PI), aRadialG: (omega * omega * R) / G0,
        lateralLoadG: omega > 0 ? this.lateralLoadG(omega) : 1,
        powerElec: this.flight ? 0 : rt.get('powerElec', row), torque: this.flight ? 0 : rt.get('torque', row),
        eElec: rt.get('eElec', row), stressRatio: rt.get('stressRatio', row),
        pressure: displayPhase === 'pumpdown' ? pressureAt(s.vacuum, tD) : s.config.launcher.vacuum.targetPressurePa,
        attached: tD < (this.releaseRecord?.t ?? Infinity),
      };
    }
    if (this.flight && this.flightInt && this.releaseRecord && tD >= this.releaseRecord.t) {
      const integ = this.flightInt;
      const y = this.yTmp;
      if (tD >= integ.t0 && tD <= integ.t1 && integ.t1 > integ.t0) integ.dense(tD, y);
      else if (tD >= integ.t1) y.set(integ.y);
      else {
        // Older than the current step: reconstruct from telemetry.
        const ft = this.flightTable;
        const row = ft.rowAt(tD);
        y.set([ft.get('x', row), ft.get('y', row), ft.get('z', row), ft.get('vx', row), ft.get('vy', row), ft.get('vz', row),
          ft.get('qw', row), ft.get('qx', row), ft.get('qy', row), ft.get('qz', row), ft.get('wx', row), ft.get('wy', row), ft.get('wz', row),
          ft.get('prop', row), ft.get('rcs', row), ft.get('T1', row), ft.get('T2', row), ft.get('T3', row), ft.get('T4', row), ft.get('heatLoad', row), ft.get('aeroWork', row), ft.get('thrustDV', row)]);
      }
      const d = this.flight.evaluate(tD, y);
      const el = orbitalElements([y[0], y[1], y[2]], [y[3], y[4], y[5]]);
      snap.vehicle = {
        r: [y[0], y[1], y[2]], v: [y[3], y[4], y[5]], q: [d.attitude[0], d.attitude[1], d.attitude[2], d.attitude[3]],
        omegaBody: [...d.omegaBody] as Vec3, altitude: d.altitude, lat: d.lat, lon: d.lon, downrange: this.downrange(tD, y),
        vAir: d.vAirMag, vInertial: d.speedInertial, mach: d.mach, qDyn: d.qDyn, alphaDeg: (d.alpha * 180) / Math.PI,
        axialG: d.axialG, lateralG: d.lateralG, payloadLateralG: d.payloadLateralG, heatFlux: d.heat.qStag, heatLoad: y[FS.HEATLOAD],
        temps: [y[FS.T1], y[FS.T2], y[FS.T3], y[FS.T4]], mass: d.mass, propellant: y[FS.MPROP], rcs: y[FS.MRCS], thrust: d.thrust,
        gimbalDeg: (d.gimbalRad * 180) / Math.PI, stabilityCal: d.stabilityMarginCal, engineOn: this.flight.discrete.engineOn,
        aeroshell: this.flight.discrete.aeroshellAttached, activeStage: this.flight.discrete.activeStage,
        environment: this.flight.discrete.environment, attitudeMode: this.flight.discrete.attitudeMode, orbit: el,
        heatFlags: d.heat.flags, aeroFlags: d.aeroFlags, desiredDir: d.desiredDir ? [...d.desiredDir] as Vec3 : null,
        clearance: displayPhase === 'corridor' ? this.clearanceAt(tD, y) : NaN,
      };
    }
    return snap;
  }

  // ------------------------------------------------------------------ summary
  summary(): RunSummary {
    const s = this.s;
    const c = s.config;
    const flags: string[] = [];
    if (c.fidelity === 'assisted') flags.push('Assisted attitude (prescribed orientation, no moments)');
    if (!c.physics.atmosphere) flags.push('Atmosphere disabled (vacuum thought experiment)');
    if (!c.physics.earthRotation) flags.push('Earth rotation disabled');
    if (c.uncertainty.enabled) flags.push('Uncertainty sampling enabled');
    if (c.launcher.release.mode === 'manual-training') flags.push('Manual release training');
    let propUsed = 0;
    let dv = 0;
    if (this.flightInt) {
      const y = this.flightInt.y;
      dv = y[FS.THRUSTDV];
      const fl = this.flight!;
      for (let i = 0; i < s.stages.length; i++) {
        if (i < fl.discrete.activeStage) propUsed += s.stages[i].propellantMass;
        else if (i === fl.discrete.activeStage) propUsed += s.stages[i].propellantMass - y[FS.MPROP];
      }
    }
    const orbit = this.orbitInsertion
      ? { ...(this.validatedOrbit ?? this.orbitInsertion.elements), validated: !!this.validatedOrbit, insertionTime: this.orbitInsertion.t }
      : undefined;
    return {
      configName: c.name,
      modelVersion: c.modelVersion,
      fidelity: c.fidelity,
      atmosphere: c.physics.atmosphere,
      earthRotation: c.physics.earthRotation,
      uncertainty: c.uncertainty.enabled,
      seed: c.seed,
      terminal: this.terminal,
      failure: this.failure,
      achievements: [...this.achievements.keys()],
      achievementTimes: Object.fromEntries(this.achievements),
      release: this.releaseRecord,
      extrema: this.extrema,
      orbit,
      energy: this.energy,
      times: {
        pumpdown: this.tPump,
        spinup: Number.isFinite(this.tHoldStart) ? this.tHoldStart - this.tSpinStart : NaN,
        hold: this.releaseRecord && Number.isFinite(this.tHoldStart) ? this.releaseRecord.t - this.tHoldStart : NaN,
        corridor: this.releaseRecord && Number.isFinite(this.tReleaseEnd) ? this.tReleaseEnd - this.releaseRecord.t : NaN,
        flight: this.releaseRecord ? this.t - this.releaseRecord.t : 0,
        end: this.t,
      },
      propellantUsed: propUsed,
      thrustDeltaV: dv,
      payloadMass: s.vehicle.payloadMass,
      payloadIntact: !this.failure,
      costPerLaunch: s.derived.costs.perLaunch,
      fidelityFlags: flags,
    };
  }
}

// ------------------------------------------------------------------ utilities
const defaultNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const norm3 = (y: ArrayLike<number>): number => Math.hypot(y[0], y[1], y[2]);
const wrapPi = (a: number): number => {
  const t = 2 * Math.PI;
  let x = ((a % t) + t) % t;
  if (x > Math.PI) x -= t;
  return x;
};
function unitVel(y: ArrayLike<number>, rot: boolean): Vec3 {
  const r: Vec3 = [y[0], y[1], y[2]];
  const v: Vec3 = [y[3], y[4], y[5]];
  const va = sub(v, cross(earthOmegaVec(rot), r));
  const n = norm(va);
  return n > 0 ? scale(va, 1 / n) : [1, 0, 0];
}
export const fmtDur = (s: number): string => {
  if (!Number.isFinite(s)) return '∞';
  if (s < 1) return `${(s * 1000).toFixed(1)} ms`;
  if (s < 120) return `${s.toFixed(1)} s`;
  if (s < 7200) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(2)} h`;
};
const fmtT = (s: number): string => (s < 1 ? `${(s * 1000).toFixed(2)} ms` : `${s.toFixed(2)} s`);
const fmtNum = (x: number): string => (Math.abs(x) >= 1e5 ? x.toExponential(2) : x.toFixed(Math.abs(x) < 10 ? 2 : 0));
void OMEGA_EARTH; void THERMAL_FLAG_RAREFIED; void qRotate;
