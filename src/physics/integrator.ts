/**
 * Adaptive Dormand-Prince 5(4) integrator with FSAL, PI step-size control,
 * per-component scaled tolerances and 4th-order continuous (dense) output,
 * following Hairer, Norsett & Wanner, "Solving Ordinary Differential
 * Equations I" (DOPRI5). Dense output is used for event localisation, for
 * reporting state at display times without altering the step sequence, and
 * for swept-volume checks inside a step.
 */

export type Derivative = (t: number, y: Float64Array, dydt: Float64Array) => void;

export interface IntegratorOptions {
  rtol: number;
  /** Absolute tolerance per component (same length as state). */
  atol: Float64Array;
  /** Largest step permitted (s); can be changed between steps by the phase. */
  hMax: number;
  /** Smallest step before declaring failure (s). */
  hMin: number;
  /** Safety factor. */
  safety?: number;
}

export class IntegrationError extends Error {
  constructor(
    message: string,
    public readonly t: number,
    public readonly detail: string,
  ) {
    super(message);
  }
}

// Butcher tableau.
const C2 = 1 / 5, C3 = 3 / 10, C4 = 4 / 5, C5 = 8 / 9;
const A21 = 1 / 5;
const A31 = 3 / 40, A32 = 9 / 40;
const A41 = 44 / 45, A42 = -56 / 15, A43 = 32 / 9;
const A51 = 19372 / 6561, A52 = -25360 / 2187, A53 = 64448 / 6561, A54 = -212 / 729;
const A61 = 9017 / 3168, A62 = -355 / 33, A63 = 46732 / 5247, A64 = 49 / 176, A65 = -5103 / 18656;
const A71 = 35 / 384, A73 = 500 / 1113, A74 = 125 / 192, A75 = -2187 / 6784, A76 = 11 / 84;
const E1 = 71 / 57600, E3 = -71 / 16695, E4 = 71 / 1920, E5 = -17253 / 339200, E6 = 22 / 525, E7 = -1 / 40;
const D1 = -12715105075 / 11282082432, D3 = 87487479700 / 32700410799, D4 = -10690763975 / 1880347072,
  D5 = 701980252875 / 199316789632, D6 = -1453857185 / 822651844, D7 = 69997945 / 29380423;

export class Dopri5 {
  readonly n: number;
  t = 0;
  y: Float64Array;
  /** Proposed size of the next step. */
  h = 0;
  /** Last accepted step interval [t0, t1]. */
  t0 = 0;
  t1 = 0;
  /** State at the start of the last accepted step. */
  y0: Float64Array;
  nfev = 0;
  naccept = 0;
  nreject = 0;
  opts: IntegratorOptions;

  private k1: Float64Array;
  private k2: Float64Array;
  private k3: Float64Array;
  private k4: Float64Array;
  private k5: Float64Array;
  private k6: Float64Array;
  private k7: Float64Array;
  private ytmp: Float64Array;
  private ynew: Float64Array;
  private r1: Float64Array;
  private r2: Float64Array;
  private r3: Float64Array;
  private r4: Float64Array;
  private r5: Float64Array;
  private facold = 1e-4;
  private hasDense = false;

  constructor(
    n: number,
    private f: Derivative,
    opts: IntegratorOptions,
  ) {
    this.n = n;
    this.opts = opts;
    const mk = (): Float64Array => new Float64Array(n);
    this.y = mk();
    this.y0 = mk();
    this.k1 = mk(); this.k2 = mk(); this.k3 = mk(); this.k4 = mk();
    this.k5 = mk(); this.k6 = mk(); this.k7 = mk();
    this.ytmp = mk(); this.ynew = mk();
    this.r1 = mk(); this.r2 = mk(); this.r3 = mk(); this.r4 = mk(); this.r5 = mk();
  }

  setDerivative(f: Derivative): void {
    this.f = f;
  }

  /** (Re)start at (t, y) after initialisation or a discontinuity. */
  reset(t: number, y: ArrayLike<number>, hInit?: number): void {
    this.t = t;
    for (let i = 0; i < this.n; i++) this.y[i] = y[i];
    this.f(t, this.y, this.k1);
    this.nfev++;
    this.checkFinite(this.k1, t, 'derivative at restart');
    this.h = hInit ?? this.initialStep();
    this.facold = 1e-4;
    this.hasDense = false;
    this.t0 = t;
    this.t1 = t;
    this.y0.set(this.y);
  }

  private checkFinite(a: Float64Array, t: number, what: string): void {
    for (let i = 0; i < this.n; i++) {
      if (!Number.isFinite(a[i])) {
        throw new IntegrationError(`Non-finite ${what}`, t, `component ${i} = ${a[i]}`);
      }
    }
  }

  private sc(i: number, a: number, b: number): number {
    return this.opts.atol[i] + this.opts.rtol * Math.max(Math.abs(a), Math.abs(b));
  }

  /** Hairer's starting-step heuristic. */
  private initialStep(): number {
    const { n, y, k1 } = this;
    let dnf = 0, dny = 0;
    for (let i = 0; i < n; i++) {
      const s = this.sc(i, y[i], y[i]);
      dnf += (k1[i] / s) ** 2;
      dny += (y[i] / s) ** 2;
    }
    let h = dnf <= 1e-10 || dny <= 1e-10 ? 1e-6 : 0.01 * Math.sqrt(dny / dnf);
    h = Math.min(h, this.opts.hMax);
    for (let i = 0; i < n; i++) this.ytmp[i] = y[i] + h * k1[i];
    this.f(this.t + h, this.ytmp, this.k2);
    this.nfev++;
    let der2 = 0;
    for (let i = 0; i < n; i++) der2 += ((this.k2[i] - k1[i]) / this.sc(i, y[i], y[i])) ** 2;
    der2 = Math.sqrt(der2) / h;
    const der12 = Math.max(Math.abs(der2), Math.sqrt(dnf));
    const h1 = der12 <= 1e-15 ? Math.max(1e-6, Math.abs(h) * 1e-3) : Math.pow(0.01 / der12, 1 / 5);
    return Math.max(this.opts.hMin * 10, Math.min(100 * h, h1, this.opts.hMax));
  }

  /**
   * Take one accepted step. If tStop is given, the step will not pass it
   * (lands exactly on it when it would otherwise overshoot).
   * Returns the size of the accepted step.
   */
  step(tStop?: number): number {
    const { n, f, y, k1, k2, k3, k4, k5, k6, k7, ytmp, ynew } = this;
    const safe = this.opts.safety ?? 0.9;
    const beta = 0.04;
    const expo1 = 0.2 - beta * 0.75;
    let reject = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      let h = Math.min(this.h, this.opts.hMax);
      let clipped = false;
      if (tStop !== undefined && this.t + h >= tStop - 1e-12 * Math.max(1, Math.abs(tStop))) {
        h = tStop - this.t;
        clipped = true;
      }
      if (h <= 0) throw new IntegrationError('Non-positive step', this.t, `h=${h}`);
      if (h < this.opts.hMin && !clipped) {
        throw new IntegrationError('Step size underflow', this.t, `h=${h.toExponential(3)} s < hMin`);
      }
      const t = this.t;
      for (let i = 0; i < n; i++) ytmp[i] = y[i] + h * A21 * k1[i];
      f(t + C2 * h, ytmp, k2);
      for (let i = 0; i < n; i++) ytmp[i] = y[i] + h * (A31 * k1[i] + A32 * k2[i]);
      f(t + C3 * h, ytmp, k3);
      for (let i = 0; i < n; i++) ytmp[i] = y[i] + h * (A41 * k1[i] + A42 * k2[i] + A43 * k3[i]);
      f(t + C4 * h, ytmp, k4);
      for (let i = 0; i < n; i++) ytmp[i] = y[i] + h * (A51 * k1[i] + A52 * k2[i] + A53 * k3[i] + A54 * k4[i]);
      f(t + C5 * h, ytmp, k5);
      for (let i = 0; i < n; i++)
        ytmp[i] = y[i] + h * (A61 * k1[i] + A62 * k2[i] + A63 * k3[i] + A64 * k4[i] + A65 * k5[i]);
      const tph = t + h;
      f(tph, ytmp, k6);
      for (let i = 0; i < n; i++)
        ynew[i] = y[i] + h * (A71 * k1[i] + A73 * k3[i] + A74 * k4[i] + A75 * k5[i] + A76 * k6[i]);
      f(tph, ynew, k7);
      this.nfev += 6;
      let err = 0;
      let finite = true;
      for (let i = 0; i < n; i++) {
        const e = h * (E1 * k1[i] + E3 * k3[i] + E4 * k4[i] + E5 * k5[i] + E6 * k6[i] + E7 * k7[i]);
        const s = this.sc(i, y[i], ynew[i]);
        const q = e / s;
        if (!Number.isFinite(q) || !Number.isFinite(ynew[i])) finite = false;
        err += q * q;
      }
      err = finite ? Math.sqrt(err / n) : Infinity;
      if (err <= 1) {
        // Accept.
        const fac11 = Math.pow(Math.max(err, 1e-16), expo1);
        let fac = fac11 / Math.pow(this.facold, beta);
        fac = Math.max(1 / 10, Math.min(1 / 0.2, fac / safe));
        let hnew = h / fac;
        if (reject) hnew = Math.min(hnew, h);
        this.facold = Math.max(err, 1e-4);
        // Dense output coefficients.
        for (let i = 0; i < n; i++) {
          const ydiff = ynew[i] - y[i];
          const bspl = h * k1[i] - ydiff;
          this.r1[i] = y[i];
          this.r2[i] = ydiff;
          this.r3[i] = bspl;
          this.r4[i] = ydiff - h * k7[i] - bspl;
          this.r5[i] = h * (D1 * k1[i] + D3 * k3[i] + D4 * k4[i] + D5 * k5[i] + D6 * k6[i] + D7 * k7[i]);
        }
        this.y0.set(y);
        this.t0 = t;
        this.t1 = clipped && tStop !== undefined ? tStop : tph;
        this.t = this.t1;
        y.set(ynew);
        k1.set(k7);
        this.hasDense = true;
        // Keep the controller's proposal even after clipping, so playback
        // boundaries never shrink later steps.
        this.h = clipped ? Math.max(hnew, this.h) : hnew;
        this.naccept++;
        return h;
      }
      // Reject.
      const fac11 = Number.isFinite(err) ? Math.pow(err, expo1) : 10;
      this.h = h / Math.min(1 / 0.2, fac11 / safe);
      reject = true;
      this.nreject++;
    }
    throw new IntegrationError('Too many rejected steps', this.t, `h=${this.h}`);
  }

  /** Dense output on the last accepted step: state at time t in [t0, t1]. */
  dense(t: number, out: Float64Array): Float64Array {
    if (!this.hasDense || this.t1 === this.t0) {
      out.set(this.y);
      return out;
    }
    const s = (t - this.t0) / (this.t1 - this.t0);
    const s1 = 1 - s;
    for (let i = 0; i < this.n; i++) {
      out[i] = this.r1[i] + s * (this.r2[i] + s1 * (this.r3[i] + s * (this.r4[i] + s1 * this.r5[i])));
    }
    return out;
  }

  /** Overwrite the current state in place (e.g. quaternion renormalisation). Re-evaluates FSAL derivative. */
  projectState(mutator: (y: Float64Array) => void): void {
    mutator(this.y);
    this.f(this.t, this.y, this.k1);
    this.nfev++;
  }

  /** Derivative at the current state (FSAL stage). */
  currentDerivative(): Float64Array {
    return this.k1;
  }
}

/**
 * Locate a root of g(t) on [ta, tb] given g(ta)*g(tb) <= 0 using the Illinois
 * variant of regula falsi on an ordered bracket, with periodic bisection.
 * Returns the bracket end on the "after crossing" side, so the returned state
 * has definitely crossed (conservative for collisions and thresholds).
 */
export function locateRoot(
  g: (t: number) => number,
  ta: number,
  tb: number,
  ga: number,
  gb: number,
  tTol: number,
): number {
  if (gb === 0) return tb;
  if (ga === 0) return ta;
  let lo = ta, hi = tb, flo = ga, fhi = gb;
  let side = 0;
  for (let it = 0; it < 200 && hi - lo > tTol; it++) {
    let c = (lo * fhi - hi * flo) / (fhi - flo);
    if (!(c > lo && c < hi) || it % 5 === 4) c = 0.5 * (lo + hi);
    const fc = g(c);
    if (fc === 0) {
      // Exactly on the surface: move just past it.
      lo = c;
      flo = fc;
      break;
    }
    if (fc * flo > 0) {
      lo = c; flo = fc;
      if (side === 1) fhi /= 2;
      side = 1;
    } else {
      hi = c; fhi = fc;
      if (side === -1) flo /= 2;
      side = -1;
    }
  }
  return hi;
}
