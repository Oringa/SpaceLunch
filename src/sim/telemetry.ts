/**
 * Column-oriented telemetry recorder backed by growable Float64Arrays.
 * Display telemetry is decimated by the session's record policy; physical
 * extrema are tracked separately at solver resolution.
 */
export class TelemetryTable {
  readonly channels: readonly string[];
  readonly index: Record<string, number>;
  private cols: Float64Array[];
  length = 0;
  private capacity: number;
  readonly maxRows: number;

  constructor(channels: readonly string[], initialCapacity = 4096, maxRows = 400_000) {
    this.channels = channels;
    this.index = Object.fromEntries(channels.map((c, i) => [c, i]));
    this.capacity = initialCapacity;
    this.cols = channels.map(() => new Float64Array(initialCapacity));
    this.maxRows = maxRows;
  }

  push(row: ArrayLike<number>): boolean {
    if (this.length >= this.maxRows) return false;
    if (this.length >= this.capacity) {
      const cap = Math.min(this.maxRows, this.capacity * 2);
      this.cols = this.cols.map((c) => {
        const n = new Float64Array(cap);
        n.set(c);
        return n;
      });
      this.capacity = cap;
    }
    for (let i = 0; i < this.cols.length; i++) this.cols[i][this.length] = row[i];
    this.length++;
    return true;
  }

  col(name: string): Float64Array {
    return this.cols[this.index[name]].subarray(0, this.length);
  }

  get(name: string, row: number): number {
    return this.cols[this.index[name]][row];
  }

  /** Copy rows [from, to) as independent arrays (transferable). */
  slice(from: number, to = this.length): Float64Array[] {
    return this.cols.map((c) => c.slice(from, to));
  }

  lastTime(): number {
    return this.length ? this.cols[0][this.length - 1] : -Infinity;
  }

  /** Binary search for the last row with t <= time. */
  rowAt(time: number): number {
    const t = this.cols[0];
    let lo = 0, hi = this.length - 1;
    if (hi < 0) return -1;
    if (time <= t[0]) return 0;
    if (time >= t[hi]) return hi;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (t[m] <= time) lo = m;
      else hi = m;
    }
    return lo;
  }

  toCSV(): string {
    const lines = [this.channels.join(',')];
    for (let r = 0; r < this.length; r++) {
      const vals = new Array<string>(this.cols.length);
      for (let i = 0; i < this.cols.length; i++) {
        const v = this.cols[i][r];
        vals[i] = Number.isFinite(v) ? (Number.isInteger(v) ? String(v) : v.toPrecision(10)) : '';
      }
      lines.push(vals.join(','));
    }
    return lines.join('\n');
  }
}

export const ROTOR_CHANNELS = [
  't', 'phase', 'phi', 'omega', 'tipSpeed', 'rpm', 'aRadialG', 'lateralLoadG', 'tangentialAccel',
  'torque', 'powerElec', 'eElec', 'eMech', 'eBearing', 'eGas', 'rotorKE', 'stressRatio', 'pressure',
] as const;

export const FLIGHT_CHANNELS = [
  't', 'phase', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'alt', 'lat', 'lon', 'downrange',
  'vAir', 'vInertial', 'mach', 'q', 'alphaDeg', 'axialG', 'lateralG', 'payloadLatG', 'payloadAxialG',
  'heatFlux', 'heatLoad', 'T1', 'T2', 'T3', 'T4', 'mass', 'prop', 'rcs', 'thrust', 'gimbalDeg',
  'peri', 'apo', 'ecc', 'incl', 'energy', 'qw', 'qx', 'qy', 'qz', 'wx', 'wy', 'wz',
  'stabilityCal', 'normalForce', 'knudsen', 'rho', 'flags', 'aeroWork', 'thrustDV', 'clearance',
] as const;

export type RotorChannel = (typeof ROTOR_CHANNELS)[number];
export type FlightChannel = (typeof FLIGHT_CHANNELS)[number];
