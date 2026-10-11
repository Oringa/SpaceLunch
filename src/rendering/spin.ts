/**
 * Perceptual "display spin" for the launcher cutaway.
 *
 * During pump-down and spin-up the playback is a time-lapse (tens to
 * hundreds of times real time), so the true rotor phase sampled once per
 * display frame is meaningless (wagon-wheel aliasing). Outside the windows
 * where the phase matters, the drawn arm therefore turns at a DISPLAY rate
 * that rises monotonically with the true rate and saturates at a speed the
 * eye can follow at 60 fps:
 *
 *     omegaDisp = SPIN_CAP * tanh(omega / SPIN_REF)
 *
 * (SPIN_CAP = 2.5 rev/s, SPIN_REF = 30 rad/s: a 637 rpm rotor is drawn at
 * ~2.4 rev/s, a 420 rpm rotor at ~2.2 rev/s, the first seconds of spin-up
 * as a slowly turning arm). The display angle is integrated in wall-clock
 * time, so it is smooth whatever the snapshot rate. Because tanh(x) < x the
 * drawn spin is always slower than the real one, and the view says so.
 *
 * In the true-phase windows (hold, exit corridor, just after release) the
 * true phase is drawn. On entering one, the drawn angle is blended onto the
 * true phase over ~0.5 s of wall time with a cubic Hermite offset that starts
 * at the current drawn rate and ends locked to the true phase. The offset is
 * chosen among the equivalent angles (mod 2 pi) so the arm decelerates
 * smoothly and never turns backwards. On leaving a window the display rate
 * relaxes from the last drawn rate towards omegaDisp (no jump).
 *
 * Purely presentational: it never changes the physics.
 */

const TAU = Math.PI * 2;
/** Display spin ceiling (rad/s): 2.5 rev/s, well below wagon-wheel aliasing at 60 fps. */
export const SPIN_CAP = 2.5 * TAU;
/** True rotor rate (rad/s) at which the display spin reaches tanh(1) = 76 % of the ceiling. */
export const SPIN_REF = 30;
/** Ceiling with reduced motion (rad/s): a slow, steady turn. */
export const SPIN_CAP_REDUCED = 0.25 * TAU;
/** Wall-clock length of the display-to-true-phase blend (s). */
export const BLEND_TIME = 0.5;
/** Relaxation time of the display rate towards its target (s). */
const RATE_TAU = 0.35;
/** Longest wait for a measurable true-phase rate before blending anyway (s). */
const PENDING_MAX = 0.2;
/**
 * Largest synthetic step per displayed frame (rad, ~43 deg): on a slow device
 * (software GL, a few fps) the display spin is capped so it still reads as
 * forward rotation instead of aliasing.
 */
const MAX_STEP = 0.75;

/** Display angular speed (rad/s, wall clock) for a true rotor rate omega (rad/s). */
export function displayOmega(omega: number, reduced = false): number {
  const w = Number.isFinite(omega) ? Math.max(0, omega) : 0;
  return (reduced ? SPIN_CAP_REDUCED : SPIN_CAP) * Math.tanh(w / SPIN_REF);
}

/** Strength (0..1) of the speed cues (smear, swept disc, tip trail) for a true rotor rate. */
export function speedCue(omega: number): number {
  const w = Number.isFinite(omega) ? Math.max(0, omega) : 0;
  return Math.tanh(w / SPIN_REF);
}

const wrapPi = (a: number): number => a - TAU * Math.round(a / TAU);

// Cubic Hermite basis (value and derivative) on u in [0, 1].
const h00 = (u: number): number => 2 * u * u * u - 3 * u * u + 1;
const h10 = (u: number): number => u * u * u - 2 * u * u + u;
const d00 = (u: number): number => 6 * u * u - 6 * u;
const d10 = (u: number): number => 3 * u * u - 4 * u + 1;

export type SpinMode = 'rest' | 'display' | 'pending' | 'blend' | 'true';

export interface SpinInput {
  /** Wall-clock seconds and the frame interval. */
  wall: number;
  dtWall: number;
  /** Snapshot time (s) or null when no run is shown. */
  snapT: number | null;
  /** True rotor phase (rad) and rate (rad/s). */
  phi: number;
  omega: number;
  /** The true phase must be drawn (hold, corridor, just after release). */
  truePhase: boolean;
  reduced: boolean;
}

interface Blend {
  wall0: number;
  T: number;
  /** Initial offset drawn - true (rad) and initial offset rate (rad/s). */
  delta: number;
  v0: number;
}

export class SpinDisplay {
  /** Drawn rotor angle (rad, phi convention, unwrapped). */
  angle = Math.PI / 2;
  /** Drawn angular speed (rad/s of wall time, smoothed). */
  rate = 0;
  mode: SpinMode = 'rest';
  /** Integrated display rate (rad/s) while the spin is synthetic. */
  private dispRate = 0;
  /** Unwrapped true phase while it is drawn. */
  private phiU = 0;
  private blend: Blend | null = null;
  private pendStart = 0;
  private pendSnap: { t: number; wall: number } | null = null;
  private lastSnapT = NaN;
  /** Last two distinct true samples: phase and wall-clock arrival time. */
  private s0: { phi: number; wall: number } | null = null;
  private s1: { phi: number; wall: number } | null = null;

  /** Smoothed displayed-frame interval (s). */
  frameTime = 1 / 60;

  /** True while the drawn spin is synthetic (not the true phase). */
  get synthetic(): boolean {
    return this.mode === 'display' || this.mode === 'pending';
  }

  /** Forget everything (no run / new run): rotor at rest at `phi`. */
  reset(phi = Math.PI / 2): void {
    this.angle = phi;
    this.rate = 0;
    this.dispRate = 0;
    this.mode = 'rest';
    this.blend = null;
    this.pendSnap = null;
    this.lastSnapT = NaN;
    this.s0 = this.s1 = null;
  }

  /**
   * True phase drawn in the windows: linear in time between the last two true
   * samples, one snapshot interval behind (exact for a constant rate, never
   * overshoots a release), so the arm moves every frame even when snapshots
   * arrive at half the display rate.
   */
  private truePhaseAt(wall: number, fallback: number): number {
    const a = this.s0, b = this.s1;
    if (!b) return fallback;
    if (!a) return b.phi;
    let d = (b.phi - a.phi) % TAU;
    if (d < 0) d += TAU;
    // A step of more than half a turn between samples is aliased (time-lapse): no interpolation.
    if (d > Math.PI) return b.phi;
    const iv = b.wall - a.wall;
    const u = iv > 0 ? Math.min(1, Math.max(0, (wall - b.wall) / iv)) : 1;
    return a.phi + u * d;
  }

  update(i: SpinInput): void {
    const dt = Math.min(Math.max(i.dtWall, 0), 0.25);
    if (i.dtWall > 0) this.frameTime += (Math.min(i.dtWall, 0.5) - this.frameTime) * 0.1;
    if (i.snapT === null) {
      if (this.mode !== 'rest') this.reset();
      return;
    }
    const prevAngle = this.angle;
    const newSnap = i.snapT !== this.lastSnapT;
    const seekBack = newSnap && Number.isFinite(this.lastSnapT) && i.snapT < this.lastSnapT - 1e-9;
    this.lastSnapT = i.snapT;
    if (seekBack) this.s1 = null;
    if (newSnap) {
      this.s0 = this.s1;
      this.s1 = { phi: i.phi, wall: i.wall };
    }
    if (this.mode === 'rest' || seekBack) {
      // First frame of a run (or a seek backwards): start where the rotor really is.
      this.s0 = null;
      this.angle = i.phi;
      this.phiU = i.phi;
      this.dispRate = i.truePhase ? 0 : displayOmega(i.omega, i.reduced);
      this.mode = i.truePhase ? 'true' : 'display';
      this.blend = null;
      this.pendSnap = null;
      this.rate = 0;
      return;
    }

    if (!i.truePhase) {
      if (this.mode !== 'display') {
        // Leaving a true-phase window: carry on at the rate the arm was visibly turning.
        this.dispRate = this.mode === 'pending' ? this.dispRate : this.rate;
        this.mode = 'display';
        this.blend = null;
        this.pendSnap = null;
      }
      const target = Math.min(displayOmega(i.omega, i.reduced), MAX_STEP / Math.max(this.frameTime, 1 / 240));
      this.dispRate += (target - this.dispRate) * (1 - Math.exp(-dt / RATE_TAU));
      // Cap the actual step too: the smoothed frame time lags a sudden drop in frame rate.
      this.angle += Math.min(this.dispRate * dt, MAX_STEP);
    } else {
      if (this.mode === 'display') {
        this.mode = 'pending';
        this.pendStart = i.wall;
        this.pendSnap = { t: i.snapT, wall: i.wall };
        // Never interpolate across the window edge (the sample before it is time-lapsed).
        this.s0 = null;
      }
      if (this.mode === 'pending') {
        // Keep turning while the apparent true rate is measured from two in-window snapshots.
        this.angle += Math.min(this.dispRate * dt, MAX_STEP);
        const p = this.pendSnap;
        let measured: number | null = null;
        if (p && newSnap && i.snapT > p.t && i.wall > p.wall) measured = (Math.max(0, i.omega) * (i.snapT - p.t)) / (i.wall - p.wall);
        if (measured !== null || i.wall - this.pendStart >= PENDING_MAX) this.startBlend(i, measured ?? 0);
      } else {
        this.phiU += wrapPi(this.truePhaseAt(i.wall, i.phi) - this.phiU);
        const b = this.blend;
        if (this.mode === 'blend' && b) {
          const u = Math.min(1, (i.wall - b.wall0) / b.T);
          this.angle = this.phiU + h00(u) * b.delta + h10(u) * b.T * b.v0;
          if (u >= 1) {
            this.mode = 'true';
            this.blend = null;
          }
        } else this.angle = this.phiU;
      }
    }
    if (dt > 0) {
      const inst = (this.angle - prevAngle) / dt;
      this.rate += (inst - this.rate) * (1 - Math.exp(-dt / 0.12));
    }
  }

  /**
   * Plan the offset (drawn - true) so the arm keeps turning forward while it
   * decelerates from the display rate onto the true phase.
   */
  private startBlend(i: SpinInput, trueRate: number): void {
    const wd = this.dispRate;
    const v0 = wd - trueRate;
    const d0 = this.angle - this.truePhaseAt(i.wall, i.phi);
    // Offset of a pure, linear deceleration from wd to the true rate over T: -T v0 / 2.
    const plan = (T: number, k: number): { delta: number; ok: boolean } => {
      const natural = (-T * v0) / 2;
      const delta = d0 + TAU * (Math.round((natural - d0) / TAU) + k);
      let minRate = Infinity;
      for (let s = 0; s <= 24; s++) {
        const u = s / 24;
        minRate = Math.min(minRate, trueRate + (d00(u) * delta) / T + d10(u) * v0);
      }
      return { delta, ok: minRate >= -1e-6 };
    };
    let chosen: { delta: number; T: number } | null = null;
    for (const T of [BLEND_TIME, BLEND_TIME * 1.4, BLEND_TIME * 1.8]) {
      const p = plan(T, 0);
      if (p.ok) {
        chosen = { delta: p.delta, T };
        break;
      }
    }
    // Still no forward-only plan: take the equivalent angle one turn behind (always speeds up).
    chosen ??= { delta: plan(BLEND_TIME, -1).delta, T: BLEND_TIME };
    this.blend = { wall0: i.wall, T: chosen.T, delta: chosen.delta, v0 };
    this.mode = 'blend';
    this.pendSnap = null;
    // Unwrapped true phase such that drawn = true + offset holds exactly now (no jump).
    this.phiU = this.angle - chosen.delta;
  }
}
