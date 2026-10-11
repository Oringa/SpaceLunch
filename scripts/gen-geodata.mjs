// Generates src/data/geo/world.json, the embedded base map for the ground-track map.
//
//   node scripts/gen-geodata.mjs <source-dir>
//
// <source-dir> must contain these pinned Natural Earth derivatives (all public domain;
// the npm packages are ISC-licensed packaging of Natural Earth):
//   wa/package/countries-50m.json     npm world-atlas@2.0.2   (npm pack world-atlas@2.0.2)
//   ua/package/states-10m.json        npm us-atlas@3.0.1      (npm pack us-atlas@3.0.1)
//   ne_10m_populated_places_simple.geojson   github.com/nvkelso/natural-earth-vector, tag v5.1.2, geojson/
//   ne_50m_lakes.geojson                     same repository and tag
//   ne_50m_rivers_lake_centerlines.geojson   same repository and tag
//   ne_50m_admin_0_countries.geojson         same repository and tag (names, label points, map colours)
//
// Output: coordinates quantised to 0.01 deg, lines simplified (Douglas-Peucker), each
// line stored as a Google-polyline string of [lon, lat] pairs. Countries keep the
// topology's shared arcs (each border stored once, simplified identically for both
// neighbours); polygons are lists of arc references (~i = reversed). Decoded by
// src/data/geo/geo.ts.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/gen-geodata.mjs <source-dir>');
  process.exit(1);
}
const OUT = 'src/data/geo/world.json';
const PRECISION = 100; // 0.01 deg ~ 1.1 km
const TOL_LAND = 0.016; // deg
const TOL_LAKE = 0.02;
const TOL_STATE = 0.025;
const TOL_RIVER = 0.02;
/**
 * Launch sites that get local detail (all small towns within DETAIL_RADIUS_KM):
 * the game's default desert site (src/data/defaults.ts, SITE_DESERT).
 */
const DETAIL_SITES = [{ lat: 32.99, lon: -106.97 }];
const DETAIL_RADIUS_KM = 450;
const nearDetailSite = (lat, lon) => DETAIL_SITES.some((s) => {
  const dLat = (lat - s.lat) * Math.PI / 180, dLon = (lon - s.lon) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * Math.PI / 180) * Math.cos(s.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a)) <= DETAIL_RADIUS_KM;
});
/** Keep a place when it is major (scalerank <= 5), has >= 40k people, or is near a detail site. */
const keepPlace = (p) => p.scalerank <= 5 || (p.scalerank <= 8 && (p.pop_max ?? 0) >= 40_000) || nearDetailSite(p.latitude, p.longitude);
const read = (p) => JSON.parse(readFileSync(join(src, p), 'utf8'));

// ---- TopoJSON decoding (quantised, delta-encoded arcs) ----
function decodeArcs(topo) {
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  return topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
}
function polygonsOf(geom) {
  if (geom.type === 'Polygon') return [geom.arcs];
  if (geom.type === 'MultiPolygon') return geom.arcs;
  return [];
}
function arcIdsOf(geom) {
  const ids = new Set();
  for (const poly of polygonsOf(geom)) for (const ring of poly) for (const i of ring) ids.add(i >= 0 ? i : ~i);
  return ids;
}
/** Arcs shared by at least two different geometries: interior boundaries. */
function sharedArcs(topo, objectName) {
  const count = new Map();
  for (const g of topo.objects[objectName].geometries) for (const id of arcIdsOf(g)) count.set(id, (count.get(id) ?? 0) + 1);
  return [...count].filter(([, n]) => n >= 2).map(([id]) => id).sort((a, b) => a - b);
}

// ---- Simplification and encoding ----
function douglasPeucker(pts, tol) {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bestD = tol2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best > 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}
function quantise(pts) {
  const out = [];
  for (const [x, y] of pts) {
    const q = [Math.round(x * PRECISION), Math.round(y * PRECISION)];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  return out;
}
function encodeValue(v) {
  let s = v < 0 ? ~(v << 1) : v << 1;
  let out = '';
  while (s >= 0x20) {
    out += String.fromCharCode((0x20 | (s & 0x1f)) + 63);
    s >>= 5;
  }
  return out + String.fromCharCode(s + 63);
}
function encode(qpts) {
  let px = 0, py = 0, out = '';
  for (const [x, y] of qpts) {
    out += encodeValue(x - px) + encodeValue(y - py);
    px = x;
    py = y;
  }
  return out;
}
/** Simplify, quantise and encode; null when a ring collapses. */
function line(pts, tol, minPts) {
  const q = quantise(douglasPeucker(pts, tol));
  return q.length >= minPts ? encode(q) : null;
}

// ---- Countries: shared arcs + polygons as arc references ----
const ctyTopo = read('wa/package/countries-50m.json');
const ctyArcs = decodeArcs(ctyTopo);
const arcs = ctyArcs.map((a) => {
  const q = quantise(douglasPeucker(a, TOL_LAND));
  return encode(q.length ? q : quantise([a[0]]));
});
const neCountries = read('ne_50m_admin_0_countries.geojson').features.map((f) => f.properties);
const NAME_ALIASES = { Macedonia: 'North Macedonia' };
const neByName = new Map(neCountries.map((p) => [p.NAME, p]));
const nations = [];
let unmatched = [];
for (const g of ctyTopo.objects.countries.geometries) {
  const name = g.properties?.name ?? '';
  const ne = neByName.get(NAME_ALIASES[name] ?? name);
  if (!ne) unmatched.push(name);
  const polys = polygonsOf(g);
  if (!polys.length) continue;
  // [name, map colour 1-7, label lon*100, label lat*100, min label zoom, polygons]
  nations.push([
    ne?.NAME ?? name,
    ne?.MAPCOLOR7 ?? 1,
    ne ? Math.round(ne.LABEL_X * PRECISION) : null,
    ne ? Math.round(ne.LABEL_Y * PRECISION) : null,
    ne?.MIN_LABEL ?? 5,
    polys,
  ]);
}
if (unmatched.length) console.warn('countries without Natural Earth properties:', unmatched.join(', '));

// ---- US state borders (interior shared arcs only) ----
const stTopo = read('ua/package/states-10m.json');
const stArcs = decodeArcs(stTopo);
const states = sharedArcs(stTopo, 'states').map((id) => line(stArcs[id], TOL_STATE, 2)).filter(Boolean);

// ---- Large lakes (drawn as water, counted as water for the landing test) ----
const lakesGeo = read('ne_50m_lakes.geojson');
const lakes = [];
for (const f of lakesGeo.features) {
  const p = f.properties;
  if (p.scalerank > 1) continue;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [];
  for (const poly of polys) {
    const outer = line(poly[0], TOL_LAKE, 4);
    if (outer) lakes.push([p.name ?? '', outer]);
  }
}

// ---- Rivers (centre lines; drawn for orientation only) ----
const riversGeo = read('ne_50m_rivers_lake_centerlines.geojson');
const rivers = [];
for (const f of riversGeo.features) {
  if (f.properties.scalerank > 5) continue;
  const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
  for (const part of parts) {
    const enc = line(part, TOL_RIVER, 2);
    if (enc) rivers.push(enc);
  }
}

// ---- Populated places: [name, lon*100, lat*100, scalerank, countryIndex, population/1000] ----
const places = read('ne_10m_populated_places_simple.geojson');
const countries = [];
const countryIndex = new Map();
const cities = [];
for (const f of places.features) {
  const p = f.properties;
  if (!keepPlace(p)) continue;
  const c = p.adm0name ?? '';
  if (!countryIndex.has(c)) {
    countryIndex.set(c, countries.length);
    countries.push(c);
  }
  cities.push([p.name, Math.round(p.longitude * PRECISION), Math.round(p.latitude * PRECISION), p.scalerank, countryIndex.get(c), Math.round((p.pop_max ?? 0) / 1000)]);
}
cities.sort((a, b) => a[3] - b[3] || b[5] - a[5]);

const out = {
  attribution: 'Made with Natural Earth (public domain), via world-atlas 2.0.2 and us-atlas 3.0.1; country names, populated places, lakes and rivers from natural-earth-vector v5.1.2.',
  precision: PRECISION,
  arcs,
  nations,
  lakes,
  states,
  rivers,
  countries,
  cities,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
const size = Buffer.byteLength(JSON.stringify(out));
console.log(`${OUT}: ${(size / 1024).toFixed(0)} KB; arcs ${arcs.length}, countries ${nations.length}, lakes ${lakes.length}, state lines ${states.length}, rivers ${rivers.length}, places ${cities.length}`);
