// Ground-track map: embedded base map, geodesy helpers, and track/landing
// extraction from solver telemetry.
import { describe, expect, it } from 'vitest';
import { decodePolyline, describeNear, greatCircle, loadWorld, surfaceAt, compass } from '../data/geo/geo';
import { trackFrom, trackEnd } from '../ui/map/landing';
import { TelemetryTable, FLIGHT_CHANNELS } from '../sim/telemetry';
import { R_EARTH } from '../physics/constants';
import { SITE_DESERT } from '../data/defaults';
import { DESIGNS } from '../data/designs';
import { buildScenario } from '../sim/build';
import { Session } from '../sim/session';

describe('base map data', () => {
  it('decodes the Google polyline reference example', () => {
    // developers.google.com/maps/documentation/utilities/polylinealgorithm (precision 1e5)
    const L = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 1e5);
    expect(Array.from(L.pts).map((v) => Math.round(v * 1000) / 1000)).toEqual([38.5, -120.2, 40.7, -120.95, 43.252, -126.453]);
    expect(L.minLon).toBeCloseTo(38.5, 5);
    expect(L.maxLat).toBeCloseTo(-120.2, 5);
  });

  it('classifies land, sea and lakes', async () => {
    const w = await loadWorld();
    expect(w.land.length).toBeGreaterThan(1000);
    expect(surfaceAt(w, 35.08, -106.65).kind).toBe('land'); // Albuquerque
    expect(surfaceAt(w, SITE_DESERT.latitudeDeg, SITE_DESERT.longitudeDeg).kind).toBe('land');
    expect(surfaceAt(w, 30, -40).kind).toBe('sea'); // mid-Atlantic
    expect(surfaceAt(w, 32.1, 34.4).kind).toBe('sea'); // Mediterranean off Tel Aviv
    expect(surfaceAt(w, -30, 100).kind).toBe('sea'); // Indian Ocean
    expect(surfaceAt(w, 47.7, -87.5)).toEqual({ kind: 'lake', name: 'Lake Superior' });
    expect(surfaceAt(w, 48.85, 2.35).kind).toBe('land'); // Paris
    expect(surfaceAt(w, 48.85, 2.35 + 360).kind).toBe('land'); // longitude wraps
  });

  it('names a nearby reference place', async () => {
    const w = await loadWorld();
    const n = describeNear(w, SITE_DESERT.latitudeDeg, SITE_DESERT.longitudeDeg)!;
    expect(n.place.name).toBe('Truth or Consequences');
    expect(n.distanceM).toBeGreaterThan(20_000);
    expect(n.distanceM).toBeLessThan(45_000);
    // Far from any town: falls back to the nearest prominent city.
    const sea = describeNear(w, 30, -40)!;
    expect(sea.place.rank).toBeLessThanOrEqual(4);
  });
});

describe('geodesy', () => {
  it('great-circle distance and bearing on the simulation sphere', () => {
    const q = greatCircle(0, 0, 0, 90);
    expect(q.distanceM).toBeCloseTo((Math.PI / 2) * R_EARTH, 3);
    expect(q.bearingDeg).toBeCloseTo(90, 9);
    expect(greatCircle(0, 0, 10, 0).bearingDeg).toBeCloseTo(0, 9);
    expect(greatCircle(10, 179.5, 10, -179.5).distanceM).toBeLessThan(120_000); // across the antimeridian
    expect([0, 44, 46, 90, 181, 359].map(compass)).toEqual(['N', 'NE', 'NE', 'E', 'S', 'N']);
  });
});

describe('ground track from telemetry', () => {
  it('unwraps longitude across the antimeridian and keeps the last row', () => {
    const t = new TelemetryTable(FLIGHT_CHANNELS, 16);
    const row = new Array<number>(FLIGHT_CHANNELS.length).fill(0);
    const ix = (c: string): number => FLIGHT_CHANNELS.indexOf(c as (typeof FLIGHT_CHANNELS)[number]);
    const lons = [178, 179, 179.9, -179.9, -179, -178];
    lons.forEach((lo, i) => {
      row[ix('t')] = i;
      row[ix('lat')] = 0.1;
      row[ix('lon')] = (lo * Math.PI) / 180;
      t.push(row);
    });
    const tr = trackFrom(t)!;
    expect(tr.n).toBe(6);
    expect(Array.from(tr.lon).map((v) => Math.round(v * 10) / 10)).toEqual([178, 179, 179.9, 180.1, 181, 182]);
    const half = trackFrom(t, 2.5)!;
    expect(half.n).toBe(3);
    const dec = trackFrom(t, Infinity, 2)!;
    expect(dec.t[dec.n - 1]).toBe(5);
  });

  it('the map landing point agrees with the solver: on land, range equals the downrange channel', async () => {
    const w = await loadWorld();
    const c = DESIGNS.find((d) => d.id === 'instrument-hop')!.make();
    const s = new Session(buildScenario(c));
    s.runToEnd();
    expect(s.terminal).toBe('ground-contact');
    const end = trackEnd(trackFrom(s.flightTable), s.terminal, c.site, w)!;
    expect(end.kind).toBe('landing');
    expect(end.surface?.kind).toBe('land');
    const T = s.flightTable;
    expect(Math.abs(end.rangeM - T.get('downrange', T.length - 1))).toBeLessThan(1);
    // Due-east azimuth: lands east of the site.
    expect(end.bearingDeg).toBeGreaterThan(80);
    expect(end.bearingDeg).toBeLessThan(100);
  });
});
