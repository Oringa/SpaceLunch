/**
 * Ground-track helpers for the map: extract a track from solver telemetry
 * and describe how it ends (landing point, orbit, loss). Presentation only:
 * every position comes from the simulation tables.
 */
import type { TelemetryTable } from '../../sim/telemetry';
import type { TerminalReason } from '../../sim/session';
import type { SiteConfig } from '../../sim/config';
import { describeNear, greatCircle, compass, nearText, surfaceAt, type Surface, type World } from '../../data/geo/geo';

const R2D = 180 / Math.PI;

export interface Track {
  /** Degrees. Longitude is unwrapped (continuous across the antimeridian). */
  lat: Float64Array;
  lon: Float64Array;
  alt: Float64Array;
  t: Float64Array;
  n: number;
}

/** Track up to time tMax (inclusive), decimated to at most maxPts points (the last row is always kept). */
export function trackFrom(table: TelemetryTable | null | undefined, tMax = Infinity, maxPts = 6000): Track | null {
  if (!table || table.length === 0) return null;
  let last = table.length - 1;
  if (Number.isFinite(tMax) && table.get('t', last) > tMax) {
    last = table.rowAt(tMax);
    if (last < 0) return null;
  }
  const rows = last + 1;
  const step = Math.max(1, Math.ceil(rows / maxPts));
  const n = Math.ceil(rows / step) + 1;
  const lat = new Float64Array(n), lon = new Float64Array(n), alt = new Float64Array(n), t = new Float64Array(n);
  let k = 0, prevLon = NaN, off = 0;
  const put = (r: number): void => {
    let lo = table.get('lon', r) * R2D;
    if (Number.isFinite(prevLon)) {
      const raw = lo + off;
      if (raw - prevLon > 180) off -= 360;
      else if (raw - prevLon < -180) off += 360;
    }
    lo += off;
    prevLon = lo;
    lat[k] = table.get('lat', r) * R2D;
    lon[k] = lo;
    alt[k] = table.get('alt', r);
    t[k] = table.get('t', r);
    k++;
  };
  for (let r = 0; r < rows; r += step) put(r);
  if ((rows - 1) % step !== 0) put(rows - 1);
  return { lat: lat.subarray(0, k), lon: lon.subarray(0, k), alt: alt.subarray(0, k), t: t.subarray(0, k), n: k };
}

export type EndKind = 'landing' | 'orbit' | 'lost' | 'ended' | 'escape' | 'running';

export interface TrackEnd {
  kind: EndKind;
  lat: number;
  lon: number;
  t: number;
  /** From the launch site, along the surface. */
  rangeM: number;
  bearingDeg: number;
  surface: Surface | null;
  near: ReturnType<typeof describeNear>;
}

export function endKind(terminal: TerminalReason | undefined): EndKind {
  switch (terminal) {
    case 'ground-contact': return 'landing';
    case 'orbit-validated': return 'orbit';
    case 'escape': return 'escape';
    case 'failure': return 'lost';
    case undefined: return 'running';
    default: return 'ended';
  }
}

/** Where a track ends, or null when there is no flight (e.g. failure before release). */
export function trackEnd(track: Track | null, terminal: TerminalReason | undefined, site: SiteConfig, world: World | null): TrackEnd | null {
  if (!track || track.n === 0) return null;
  const i = track.n - 1;
  const lat = track.lat[i], lon = track.lon[i];
  const g = greatCircle(site.latitudeDeg, site.longitudeDeg, lat, lon);
  return {
    kind: endKind(terminal),
    lat,
    lon,
    t: track.t[i],
    rangeM: g.distanceM,
    bearingDeg: g.bearingDeg,
    surface: world ? surfaceAt(world, lat, lon) : null,
    near: world ? describeNear(world, lat, lon) : null,
  };
}

const km = (m: number): string => (m < 100_000 ? (m / 1000).toFixed(1) : m < 1_000_000 ? (m / 1000).toFixed(0) : `${(m / 1000).toLocaleString('en-US', { maximumFractionDigits: 0 })}`) + ' km';

/** One short line for HUD and cards. `future` phrases a forecast. */
export function endHeadline(e: TrackEnd, future: boolean): string {
  const where = `${km(e.rangeM)} ${compass(e.bearingDeg)} of the launch site`;
  switch (e.kind) {
    case 'landing': {
      const s = e.surface;
      if (s?.kind === 'sea') return `${future ? 'Splashes down' : 'Splashed down'} at sea, ${where}`;
      if (s?.kind === 'lake') return `${future ? 'Splashes down' : 'Splashed down'} in ${s.name || 'a lake'}, ${where}`;
      return `${future ? 'Lands' : 'Landed'} ${where}`;
    }
    case 'orbit': return future ? 'Stays in orbit: no landing' : 'In orbit: no landing';
    case 'escape': return 'Escapes Earth';
    case 'lost': return `Vehicle lost ${where} (debris not modelled)`;
    case 'running': return `Now ${where}`;
    default: return `Flight ended ${where}`;
  }
}

/** Secondary line: the nearest recognisable place. */
export function endNear(e: TrackEnd): string {
  if (e.kind === 'orbit' || e.kind === 'escape') return '';
  const t = nearText(e.near);
  return t ? `${t}${e.near?.place.country ? `, ${e.near.place.country}` : ''}` : '';
}
