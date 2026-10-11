/** Display formatting. Internal values are SI; every displayed number carries its unit. */
const finite = (x: number): boolean => Number.isFinite(x);

export function num(x: number, digits = 2): string {
  if (x === Infinity) return '∞';
  if (x === -Infinity) return '−∞';
  if (!finite(x)) return '—';
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return x.toExponential(Math.max(1, digits));
  return x.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const fixed = (x: number, d = 1): string => (finite(x) ? x.toFixed(d) : x === Infinity ? '∞' : '—');

export function length(m: number): string {
  if (!finite(m)) return m === Infinity ? '∞' : '—';
  const a = Math.abs(m);
  if (a >= 10_000) return `${num(m / 1000, 1)} km`;
  if (a >= 1) return `${num(m, 2)} m`;
  if (a >= 0.01) return `${num(m * 100, 1)} cm`;
  return `${num(m * 1000, 2)} mm`;
}
export const km = (m: number, d = 1): string => (finite(m) ? `${num(m / 1000, d)} km` : m === Infinity ? '∞' : '—');
export const speed = (v: number): string => (finite(v) ? (Math.abs(v) >= 1000 ? `${num(v / 1000, 3)} km/s` : `${num(v, 1)} m/s`) : '—');
export const mps = (v: number): string => (finite(v) ? `${num(v, 0)} m/s` : '—');

export function pressure(p: number): string {
  if (!finite(p)) return '—';
  const a = Math.abs(p);
  if (a >= 1e6) return `${num(p / 1e6, 2)} MPa`;
  if (a >= 1e3) return `${num(p / 1e3, 1)} kPa`;
  if (a >= 1) return `${num(p, 1)} Pa`;
  return `${p.toExponential(1)} Pa`;
}
export function power(w: number): string {
  if (!finite(w)) return '—';
  const a = Math.abs(w);
  if (a >= 1e6) return `${num(w / 1e6, 2)} MW`;
  if (a >= 1e3) return `${num(w / 1e3, 1)} kW`;
  return `${num(w, 0)} W`;
}
export function energy(j: number): string {
  if (!finite(j)) return j === Infinity ? '∞' : '—';
  const a = Math.abs(j);
  const mwh = j / 3.6e9;
  if (a >= 1e9) return `${num(j / 1e9, 2)} GJ (${num(mwh, 2)} MWh)`;
  if (a >= 1e6) return `${num(j / 1e6, 1)} MJ (${num(j / 3.6e6, 1)} kWh)`;
  if (a >= 1e3) return `${num(j / 1e3, 1)} kJ`;
  return `${num(j, 0)} J`;
}
export function force(n: number): string {
  if (!finite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return `${num(n / 1e6, 2)} MN`;
  if (a >= 1e3) return `${num(n / 1e3, 1)} kN`;
  return `${num(n, 0)} N`;
}
export function mass(kg: number): string {
  if (!finite(kg)) return '—';
  return Math.abs(kg) >= 10_000 ? `${num(kg / 1000, 1)} t` : `${num(kg, 1)} kg`;
}
export const stress = (pa: number): string => (finite(pa) ? (Math.abs(pa) >= 1e9 ? `${num(pa / 1e9, 2)} GPa` : `${num(pa / 1e6, 0)} MPa`) : '—');
export const flux = (w: number): string => (finite(w) ? (Math.abs(w) >= 1e6 ? `${num(w / 1e6, 2)} MW/m²` : `${num(w / 1e3, 1)} kW/m²`) : '—');
export const g = (x: number): string => (finite(x) ? `${num(x, x >= 100 ? 0 : 2)} g` : '—');
export const deg = (rad: number, d = 1): string => (finite(rad) ? `${num((rad * 180) / Math.PI, d)}°` : '—');
export const kelvin = (k: number): string => (finite(k) ? `${num(k, 0)} K` : '—');
export const credits = (c: number): string => (finite(c) ? `${num(c, 0)} cr` : '—');

export function duration(s: number): string {
  if (!finite(s)) return s === Infinity ? '∞' : '—';
  const a = Math.abs(s);
  if (a < 1e-3) return `${num(s * 1e6, 1)} µs`;
  if (a < 1) return `${num(s * 1000, 2)} ms`;
  if (a < 120) return `${num(s, 2)} s`;
  if (a < 7200) return `${num(s / 60, 1)} min`;
  return `${num(s / 3600, 2)} h`;
}

/** Mission clock: hh:mm:ss.mmm of simulated time. */
export function clock(s: number): string {
  if (!finite(s)) return '--:--:--.---';
  const sign = s < 0 ? '−' : '';
  const a = Math.abs(s);
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const sec = a % 60;
  return `${sign}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
}

export function rate(r: number): string {
  if (!finite(r)) return '—';
  if (r >= 10) return `×${num(r, 0)}`;
  if (r >= 1) return `×${num(r, 1)}`;
  return `×${r.toPrecision(2)}`;
}

export const PHASE_LABEL: Record<string, string> = {
  pumpdown: 'Pump-down',
  spinup: 'Spin-up',
  hold: 'Hold / phase lock',
  corridor: 'Release & exit corridor',
  flight: 'Free flight',
  ended: 'Ended',
};
