/**
 * Ground-track map: launch site, forecast track and landing point (from the
 * prediction worker), the live flown track and vehicle, ghosts, range rings
 * and nearby places, on an embedded Natural Earth base map.
 *
 * Plate carrée, scaled by cos(centre latitude) so regional views keep their
 * shape. Every position comes from solver telemetry; nothing is scripted.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Controller } from '../controller';
import { useStore } from '../store';
import { loadWorld, type Line, type World } from '../../data/geo/geo';
import { trackFrom, trackEnd, type Track, type TrackEnd } from './landing';
import type { TelemetryTable } from '../../sim/telemetry';
import type { SiteConfig } from '../../sim/config';
import type { TerminalReason } from '../../sim/session';
import { R_EARTH } from '../../physics/constants';

// ------------------------------------------------------------------ data hooks
let worldCache: World | null = null;
/** The decoded base map, or null while it loads. */
export function useWorld(): World | null {
  const [w, setW] = useState<World | null>(worldCache);
  useEffect(() => {
    if (worldCache) return;
    let alive = true;
    loadWorld().then((x) => {
      worldCache = x;
      if (alive) setW(x);
    }).catch(() => { /* map stays blank; the game is unaffected */ });
    return () => { alive = false; };
  }, []);
  return w;
}

const trackCache = new WeakMap<TelemetryTable, { len: number; tMax: number; track: Track | null }>();
function cachedTrack(table: TelemetryTable | null | undefined, tMax: number): Track | null {
  if (!table) return null;
  const c = trackCache.get(table);
  if (c && c.len === table.length && c.tMax === tMax) return c.track;
  const track = trackFrom(table, tMax);
  trackCache.set(table, { len: table.length, tMax, track });
  return track;
}

export interface MapScene {
  site: SiteConfig;
  forecast: Track | null;
  forecastTerminal?: TerminalReason;
  forecastFresh: boolean;
  flown: Track | null;
  flownTerminal?: TerminalReason;
  vehicle: { lat: number; lon: number } | null;
  ghosts: Array<{ track: Track; color: string; label: string }>;
  live: boolean;
  finished: boolean;
}

const R2D = 180 / Math.PI;

export function sceneOf(ctl: Controller): MapScene {
  const st = ctl.store.get();
  const site = (st.run.status !== 'idle' && st.run.config ? st.run.config : st.config).site;
  const pred = st.prediction;
  const forecastFresh = pred.status === 'done' && pred.configVersion === st.configVersion;
  // Play mode keeps the outcome a surprise unless the player asked for the forecast.
  const showForecast = st.uiMode === 'play' ? st.forecastShown : st.overlays.predicted;
  const forecast = showForecast && pred.flight ? cachedTrack(pred.flight, Infinity) : null;
  const live = st.run.status === 'live' || st.run.status === 'starting';
  const finished = st.run.status === 'finished';
  const snap = ctl.snapshot;
  const flown = st.run.status !== 'idle' ? cachedTrack(ctl.flightTable, finished ? Infinity : snap?.t ?? Infinity) : null;
  const v = live && snap?.vehicle ? { lat: snap.vehicle.lat * R2D, lon: snap.vehicle.lon * R2D } : null;
  const ghosts = st.uiMode === 'engineer' && st.overlays.ghosts
    ? st.ghosts.map((g) => ({ track: cachedTrack(g.flight, Infinity), color: g.color, label: g.label })).filter((g): g is { track: Track; color: string; label: string } => !!g.track)
    : [];
  return {
    site, forecast, forecastTerminal: pred.summary?.terminal, forecastFresh, flown,
    flownTerminal: finished ? st.run.summary?.terminal : undefined, vehicle: v, ghosts, live, finished,
  };
}

/** Forecast and actual track ends, recomputed only when their inputs change. */
export function useTrackEnds(ctl: Controller, world: World | null): { forecast: TrackEnd | null; actual: TrackEnd | null; scene: MapScene } {
  useStore(ctl.store, (s) => s.uiTick);
  useStore(ctl.store, (s) => s.prediction);
  useStore(ctl.store, (s) => s.run.status);
  const scene = sceneOf(ctl);
  const fKey = `${scene.forecast?.n ?? -1}|${scene.forecastTerminal}|${scene.site.latitudeDeg},${scene.site.longitudeDeg}|${!!world}`;
  const aKey = `${scene.flown?.n ?? -1}|${scene.flown ? scene.flown.t[scene.flown.n - 1] : 0}|${scene.flownTerminal}|${!!world}`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const forecast = useMemo(() => trackEnd(scene.forecast, scene.forecastTerminal, scene.site, world), [fKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const actual = useMemo(() => trackEnd(scene.flown, scene.finished ? scene.flownTerminal : undefined, scene.site, world), [aKey]);
  return { forecast, actual, scene };
}

// ------------------------------------------------------------------ view math
interface View { lon0: number; lat0: number; k: number }
const MIN_SPAN_DEG = 1.0;
const clampLat = (x: number): number => Math.max(-80, Math.min(80, x));
const cosf = (v: View): number => Math.cos(clampLat(v.lat0) * Math.PI / 180);
const worldK = (w: number, h: number): number => Math.min(w / 360, h / 170);

function fit(scene: MapScene, w: number, h: number, pad: number, extra: Array<[number, number]> = []): View {
  const lon0s = scene.site.longitudeDeg;
  let minLat = scene.site.latitudeDeg, maxLat = minLat, minLon = 0, maxLon = 0;
  let orbital = scene.forecastTerminal === 'orbit-validated' || scene.flownTerminal === 'orbit-validated';
  const add = (t: Track | null): void => {
    if (!t || !t.n) return;
    // Express each track relative to the site, keeping its unwrapped continuity.
    const shift = Math.round((t.lon[0] - lon0s) / 360) * 360;
    for (let i = 0; i < t.n; i++) {
      const lo = t.lon[i] - shift - lon0s, la = t.lat[i];
      if (lo < minLon) minLon = lo;
      if (lo > maxLon) maxLon = lo;
      if (la < minLat) minLat = la;
      if (la > maxLat) maxLat = la;
    }
  };
  add(scene.forecast);
  add(scene.flown);
  for (const g of scene.ghosts) add(g.track);
  const tracked = maxLon - minLon > 110 || maxLat - minLat > 45;
  // Context points (e.g. the nearest town) only for regional views.
  if (!tracked) {
    for (const [la, lo] of extra) {
      const d = ((((lo - lon0s) + 540) % 360) + 360) % 360 - 180;
      minLon = Math.min(minLon, d);
      maxLon = Math.max(maxLon, d);
      minLat = Math.min(minLat, la);
      maxLat = Math.max(maxLat, la);
    }
  }
  if (maxLon - minLon > 110 || maxLat - minLat > 45) orbital = true;
  if (orbital) return { lon0: lon0s, lat0: 0, k: worldK(w, h) };
  const lat0 = (minLat + maxLat) / 2;
  const c = Math.cos(clampLat(lat0) * Math.PI / 180);
  const spanLat = Math.max(maxLat - minLat, MIN_SPAN_DEG);
  const spanLon = Math.max(maxLon - minLon, MIN_SPAN_DEG / c);
  const k = Math.min((w - 2 * pad) / (spanLon * c), (h - 2 * pad) / spanLat);
  return { lon0: lon0s + (minLon + maxLon) / 2, lat0, k: Math.max(worldK(w, h), k) };
}

/** Destination point on the sphere (deg) from lat/lon (deg), bearing (rad), distance (m). */
function destination(lat: number, lon: number, brg: number, d: number): [number, number] {
  const p1 = lat * Math.PI / 180, l1 = lon * Math.PI / 180, a = d / R_EARTH;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(a) + Math.cos(p1) * Math.sin(a) * Math.cos(brg));
  const l2 = l1 + Math.atan2(Math.sin(brg) * Math.sin(a) * Math.cos(p1), Math.cos(a) - Math.sin(p1) * Math.sin(p2));
  return [p2 * R2D, l2 * R2D];
}

const niceStep = (x: number): number => {
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
};

// ------------------------------------------------------------------ drawing
const C = {
  oceanA: '#0c2340', oceanB: '#06101f', land: '#232e2b', landEdge: '#5b8199', lake: '#0d2340', river: 'rgba(96, 156, 214, 0.55)',
  grid: 'rgba(130, 170, 210, 0.10)', border: 'rgba(205, 220, 235, 0.38)', state: 'rgba(205, 220, 235, 0.18)',
  city: '#c9d4e1', cityText: '#b6c3d2', halo: 'rgba(3, 7, 14, 0.9)', ring: 'rgba(255, 180, 84, 0.28)', ringText: 'rgba(255, 196, 120, 0.75)',
  hot: '#ffb454', cool: '#4cc9f0', good: '#5fd38d', bad: '#ff6b6b',
};

interface Ctx {
  g: CanvasRenderingContext2D;
  w: number;
  h: number;
  v: View;
  c: number;
  visMinLon: number;
  visMaxLon: number;
  visMinLat: number;
  visMaxLat: number;
}

const X = (cx: Ctx, lon: number): number => cx.w / 2 + (lon - cx.v.lon0) * cx.v.k * cx.c;
const Y = (cx: Ctx, lat: number): number => cx.h / 2 - (lat - cx.v.lat0) * cx.v.k;

/** Longitude offsets (multiples of 360) at which a span [a, b] is visible. */
function shifts(cx: Ctx, a: number, b: number): number[] {
  const out: number[] = [];
  const s0 = Math.ceil((cx.visMinLon - b) / 360), s1 = Math.floor((cx.visMaxLon - a) / 360);
  for (let s = s0; s <= s1 && out.length < 6; s++) out.push(s * 360);
  return out;
}

function pathLine(cx: Ctx, L: Line, closed: boolean): void {
  if (L.maxLat < cx.visMinLat || L.minLat > cx.visMaxLat) return;
  const { g } = cx;
  const p = L.pts;
  for (const off of shifts(cx, L.minLon, L.maxLon)) {
    // Skip features smaller than about a pixel.
    if ((L.maxLon - L.minLon) * cx.v.k * cx.c < 0.8 && (L.maxLat - L.minLat) * cx.v.k < 0.8) continue;
    let lx = X(cx, p[0] + off), ly = Y(cx, p[1]);
    g.moveTo(lx, ly);
    for (let i = 2; i < p.length; i += 2) {
      const x = X(cx, p[i] + off), y = Y(cx, p[i + 1]);
      if (Math.abs(x - lx) + Math.abs(y - ly) < 0.7 && i < p.length - 2) continue;
      g.lineTo(x, y);
      lx = x;
      ly = y;
    }
    if (closed) g.closePath();
  }
}

function pathTrack(cx: Ctx, t: Track): void {
  let a = Infinity, b = -Infinity;
  for (let i = 0; i < t.n; i++) {
    if (t.lon[i] < a) a = t.lon[i];
    if (t.lon[i] > b) b = t.lon[i];
  }
  for (const off of shifts(cx, a, b)) {
    let lx = X(cx, t.lon[0] + off), ly = Y(cx, t.lat[0]);
    cx.g.moveTo(lx, ly);
    for (let i = 1; i < t.n; i++) {
      const x = X(cx, t.lon[i] + off), y = Y(cx, t.lat[i]);
      if (Math.abs(x - lx) + Math.abs(y - ly) < 0.6 && i < t.n - 1) continue;
      cx.g.lineTo(x, y);
      lx = x;
      ly = y;
    }
  }
}

/** Screen positions of a point at every visible longitude offset. */
function pointsAt(cx: Ctx, lat: number, lon: number): Array<[number, number]> {
  return shifts(cx, lon, lon).map((off) => [X(cx, lon + off), Y(cx, lat)] as [number, number]);
}

function label(cx: Ctx, text: string, x: number, y: number, color: string, font: string, taken: number[][], align: CanvasTextAlign = 'left', force = false): boolean {
  const { g } = cx;
  g.font = font;
  const m = g.measureText(text).width;
  const hgt = 12;
  const x0 = align === 'left' ? x : align === 'center' ? x - m / 2 : x - m;
  const r = [x0 - 2, y - hgt + 2, x0 + m + 2, y + 3];
  if (!force && (r[0] < 2 || r[2] > cx.w - 2 || r[1] < 2 || r[3] > cx.h - 2)) return false;
  if (!force && taken.some((q) => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1])) return false;
  taken.push(r);
  g.textAlign = align;
  g.lineWidth = 3;
  g.strokeStyle = C.halo;
  g.strokeText(text, x, y);
  g.fillStyle = color;
  g.fillText(text, x, y);
  return true;
}

/** Label beside a marker: right, left, above or below, whichever is free; forced right otherwise. */
function markerLabel(cx: Ctx, text: string, x: number, y: number, color: string, font: string, taken: number[][], gap: number): void {
  const tries: Array<[number, number, CanvasTextAlign]> = [[x + gap, y + 4, 'left'], [x - gap, y + 4, 'right'], [x, y - gap - 2, 'center'], [x, y + gap + 10, 'center']];
  for (const [lx, ly, al] of tries) if (label(cx, text, lx, ly, color, font, taken, al)) return;
  label(cx, text, tries[0][0], tries[0][1], color, font, taken, 'left', true);
}

function endWord(e: TrackEnd, future: boolean): string {
  switch (e.kind) {
    case 'landing': return e.surface?.kind === 'sea' || e.surface?.kind === 'lake' ? (future ? 'SPLASHDOWN' : 'SPLASHED DOWN') : future ? 'LANDS HERE' : 'LANDED';
    case 'lost': return 'LOST';
    case 'orbit': return 'IN ORBIT';
    default: return 'END';
  }
}

function draw(cx: Ctx, world: World | null, sc: MapScene, ends: { forecast: TrackEnd | null; actual: TrackEnd | null }, compact: boolean, time: number): void {
  const { g, w, h, v } = cx;
  g.clearRect(0, 0, w, h);
  const bg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.hypot(w, h) / 1.6);
  bg.addColorStop(0, C.oceanA);
  bg.addColorStop(1, C.oceanB);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);

  // Graticule
  const degPerPx = 1 / v.k;
  const gStep = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30].find((s) => s / degPerPx >= (compact ? 55 : 80)) ?? 30;
  g.beginPath();
  for (let lo = Math.ceil(cx.visMinLon / gStep) * gStep; lo <= cx.visMaxLon; lo += gStep) {
    g.moveTo(X(cx, lo), Math.max(0, Y(cx, 90)));
    g.lineTo(X(cx, lo), Math.min(h, Y(cx, -90)));
  }
  for (let la = Math.ceil(Math.max(-90, cx.visMinLat) / gStep) * gStep; la <= Math.min(90, cx.visMaxLat); la += gStep) {
    g.moveTo(0, Y(cx, la));
    g.lineTo(w, Y(cx, la));
  }
  g.strokeStyle = C.grid;
  g.lineWidth = 1;
  g.stroke();

  if (world) {
    g.beginPath();
    for (const poly of world.land) {
      for (const ring of poly) pathLine(cx, ring, true);
    }
    g.fillStyle = C.land;
    g.fill('evenodd');
    g.beginPath();
    for (const lk of world.lakes) pathLine(cx, lk.ring, true);
    g.fillStyle = C.lake;
    g.fill();
    g.beginPath();
    for (const poly of world.land) pathLine(cx, poly[0], true);
    for (const lk of world.lakes) pathLine(cx, lk.ring, true);
    g.strokeStyle = C.landEdge;
    g.lineWidth = 0.9;
    g.stroke();
    if (v.k > 2) {
      g.beginPath();
      for (const r of world.rivers) pathLine(cx, r, false);
      g.strokeStyle = C.river;
      g.lineWidth = v.k > 20 ? 1.4 : 0.9;
      g.stroke();
    }
    if (v.k > 3) {
      g.beginPath();
      for (const s of world.states) pathLine(cx, s, false);
      g.setLineDash([3, 3]);
      g.strokeStyle = C.state;
      g.lineWidth = 0.8;
      g.stroke();
      g.setLineDash([]);
    }
    g.beginPath();
    for (const b of world.borders) pathLine(cx, b, false);
    g.strokeStyle = C.border;
    g.lineWidth = v.k > 3 ? 1.1 : 0.7;
    g.stroke();
  }

  const taken: number[][] = [];
  const site = sc.site;
  const siteXY = pointsAt(cx, site.latitudeDeg, site.longitudeDeg);

  // Range rings around the launch site
  const kmPerPx = 111.195 * degPerPx;
  if (kmPerPx < 40) {
    const target = kmPerPx * Math.min(w, h) * 0.28;
    const step = niceStep(target);
    for (let r = step; r <= step * 3; r += step) {
      g.beginPath();
      const N = 96;
      for (let i = 0; i <= N; i++) {
        const [la, lo] = destination(site.latitudeDeg, site.longitudeDeg, (i / N) * 2 * Math.PI, r * 1000);
        const x = X(cx, lo), y = Y(cx, la);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.setLineDash([4, 5]);
      g.strokeStyle = C.ring;
      g.lineWidth = 1;
      g.stroke();
      g.setLineDash([]);
      const [la, lo] = destination(site.latitudeDeg, site.longitudeDeg, 0, r * 1000);
      if (!compact) label(cx, `${r >= 1 ? r.toFixed(0) : r.toFixed(1)} km`, X(cx, lo) + 3, Y(cx, la) - 3, C.ringText, '600 10px ui-monospace, monospace', taken);
    }
  }

  // Reserve the important labels first so places do not cover them, and keep
  // every label off the marker icons themselves.
  const markers: Array<() => void> = [];
  const reserve = (x: number, y: number, r: number, up = 0): void => { taken.push([x - r, y - r - up, x + r, y + r]); };
  for (const [x, y] of siteXY) reserve(x, y, 8);
  if (ends.forecast && !sc.finished && ends.forecast.kind !== 'running') for (const [x, y] of pointsAt(cx, ends.forecast.lat, ends.forecast.lon)) reserve(x, y, 10);
  if (ends.actual && sc.finished) for (const [x, y] of pointsAt(cx, ends.actual.lat, ends.actual.lon)) reserve(x, y, 9, 14);

  // Tracks: ghosts, forecast, flown
  for (const gh of sc.ghosts) {
    g.beginPath();
    pathTrack(cx, gh.track);
    g.strokeStyle = gh.color;
    g.globalAlpha = 0.75;
    g.lineWidth = 1.6;
    g.stroke();
    g.globalAlpha = 1;
  }
  if (sc.forecast && sc.forecast.n > 1) {
    g.beginPath();
    pathTrack(cx, sc.forecast);
    g.setLineDash([7, 6]);
    g.strokeStyle = C.cool;
    g.globalAlpha = sc.forecastFresh ? 0.95 : 0.4;
    g.lineWidth = 2;
    g.stroke();
    g.setLineDash([]);
    g.globalAlpha = 1;
  }
  if (sc.flown && sc.flown.n > 1) {
    g.beginPath();
    pathTrack(cx, sc.flown);
    g.save();
    g.shadowColor = C.hot;
    g.shadowBlur = 10;
    g.strokeStyle = C.hot;
    g.lineWidth = 2.6;
    g.lineJoin = 'round';
    g.stroke();
    g.restore();
  }

  // Launch site
  for (const [x, y] of siteXY) {
    g.save();
    g.shadowColor = C.hot;
    g.shadowBlur = 12;
    g.beginPath();
    g.moveTo(x, y - 8);
    g.lineTo(x + 6.5, y + 4.5);
    g.lineTo(x - 6.5, y + 4.5);
    g.closePath();
    g.fillStyle = C.hot;
    g.fill();
    g.restore();
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    g.stroke();
    if (!compact) markers.push(() => markerLabel(cx, 'LAUNCH SITE', x, y, '#ffd9a8', '800 11px system-ui, sans-serif', taken, 11));
  }

  // Forecast landing point (only before/while flying; after the run the actual point is shown)
  const fe = ends.forecast;
  if (fe && !sc.finished && fe.kind !== 'running') {
    for (const [x, y] of pointsAt(cx, fe.lat, fe.lon)) {
      g.beginPath();
      g.arc(x, y, 9, 0, 2 * Math.PI);
      g.setLineDash([3, 3]);
      g.strokeStyle = C.cool;
      g.lineWidth = 1.6;
      g.stroke();
      g.setLineDash([]);
      g.beginPath();
      g.moveTo(x - 5, y - 5); g.lineTo(x + 5, y + 5);
      g.moveTo(x + 5, y - 5); g.lineTo(x - 5, y + 5);
      g.stroke();
      if (fe.kind !== 'orbit' && !compact) markers.push(() => markerLabel(cx, `FORECAST: ${endWord(fe, true)}`, x, y, '#bfeeff', '800 11px system-ui, sans-serif', taken, 13));
    }
  }

  // Actual end point
  const ae = ends.actual;
  if (ae && sc.finished) {
    const col = ae.kind === 'lost' ? C.bad : ae.kind === 'orbit' ? C.good : C.hot;
    for (const [x, y] of pointsAt(cx, ae.lat, ae.lon)) {
      g.save();
      g.shadowColor = col;
      g.shadowBlur = 14;
      g.beginPath();
      g.moveTo(x, y);
      g.bezierCurveTo(x - 9, y - 11, x - 7, y - 22, x, y - 22);
      g.bezierCurveTo(x + 7, y - 22, x + 9, y - 11, x, y);
      g.fillStyle = col;
      g.fill();
      g.restore();
      g.beginPath();
      g.arc(x, y - 15, 3, 0, 2 * Math.PI);
      g.fillStyle = '#10161f';
      g.fill();
      if (!compact) markers.unshift(() => markerLabel(cx, endWord(ae, false), x, y - 12, '#fff', '800 12px system-ui, sans-serif', taken, 12));
    }
  }

  // Live vehicle
  if (sc.vehicle) {
    const pulse = 0.5 + 0.5 * Math.sin(time / 180);
    for (const [x, y] of pointsAt(cx, sc.vehicle.lat, sc.vehicle.lon)) {
      g.beginPath();
      g.arc(x, y, 7 + 5 * pulse, 0, 2 * Math.PI);
      g.fillStyle = `rgba(255, 180, 84, ${0.25 * (1 - pulse) + 0.08})`;
      g.fill();
      g.save();
      g.shadowColor = C.hot;
      g.shadowBlur = 12;
      g.beginPath();
      g.arc(x, y, 4.2, 0, 2 * Math.PI);
      g.fillStyle = '#fff4e0';
      g.fill();
      g.restore();
    }
  }

  for (const m of markers) m();

  // Places, most prominent first; density follows zoom.
  if (world) {
    const maxRank = v.k > 60 ? 8 : v.k > 25 ? 7 : v.k > 10 ? 6 : v.k > 5 ? 4 : v.k > 2.5 ? 2 : 1;
    let drawn = 0;
    const limit = compact ? 14 : 70;
    for (const pl of world.places) {
      if (pl.rank > maxRank) continue;
      if (pl.lat < cx.visMinLat || pl.lat > cx.visMaxLat) continue;
      for (const [x, y] of pointsAt(cx, pl.lat, pl.lon)) {
        if (x < 4 || x > w - 4 || y < 4 || y > h - 4) continue;
        const font = `${pl.rank <= 2 ? 650 : 500} ${compact ? 10 : pl.rank <= 2 ? 12 : 11}px system-ui, sans-serif`;
        if (!label(cx, pl.name, x + 5, y + 4, C.cityText, font, taken)) continue;
        g.beginPath();
        g.arc(x, y, pl.rank <= 2 ? 2.6 : 1.9, 0, 2 * Math.PI);
        g.fillStyle = C.city;
        g.fill();
        drawn++;
      }
      if (drawn >= limit) break;
    }
  }

  // Scale bar (true at the centre latitude, where the projection is conformal)
  if (kmPerPx < 40 && (!compact || w > 260)) {
    const len = niceStep(kmPerPx * 90);
    const px = len / kmPerPx;
    const x0 = w - px - 14, y0 = h - 14;
    g.strokeStyle = 'rgba(220, 230, 240, 0.8)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x0, y0 - 5); g.lineTo(x0, y0); g.lineTo(x0 + px, y0); g.lineTo(x0 + px, y0 - 5);
    g.stroke();
    label(cx, `${len >= 1 ? len.toLocaleString('en-US') : len} km`, x0 + px / 2, y0 - 7, '#dfe7ef', '600 10px ui-monospace, monospace', taken, 'center', true);
  }
}

// ------------------------------------------------------------------ component
export function GroundMap({ ctl, compact = false, onExpand }: { ctl: Controller; compact?: boolean; onExpand?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = useWorld();
  const ends = useTrackEnds(ctl, world);
  const endsRef = useRef(ends);
  endsRef.current = ends;
  const view = useRef<View | null>(null);
  const auto = useRef(true);
  const [isAuto, setIsAuto] = useState(true);
  const dirty = useRef(true);
  const worldRef = useRef(world);
  worldRef.current = world;
  useEffect(() => { dirty.current = true; }, [world]);

  useEffect(() => {
    const el = host.current, cv = canvas.current;
    if (!el || !cv) return;
    const g = cv.getContext('2d');
    if (!g) return;
    let raf = 0, lastDraw = 0, lastSig = '';
    let cw = 0, ch = 0;
    const resize = (): void => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cw = Math.max(1, Math.round(r.width));
      ch = Math.max(1, Math.round(r.height));
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
      cv.style.width = `${cw}px`;
      cv.style.height = `${ch}px`;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      dirty.current = true;
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    const frame = (time: number): void => {
      raf = requestAnimationFrame(frame);
      const sc = sceneOf(ctl);
      const sig = `${sc.forecast?.n}|${sc.forecastFresh}|${sc.flown?.n}|${sc.flown ? sc.flown.t[sc.flown.n - 1] : 0}|${sc.finished}|${sc.ghosts.length}|${sc.site.latitudeDeg},${sc.site.longitudeDeg}|${endsRef.current.forecast?.kind}|${endsRef.current.actual?.kind}|${endsRef.current.forecast?.near?.place.name}|${endsRef.current.actual?.near?.place.name}`;
      const changed = sig !== lastSig;
      // Redraw on demand, at most ~30 Hz while flying (the vehicle marker pulses).
      if (!dirty.current && !((changed || sc.live) && time - lastDraw > 33)) return;
      if (auto.current && (changed || !view.current || dirty.current)) {
        const e = endsRef.current;
        const ref = sc.finished ? e.actual : e.forecast ?? e.actual;
        const extra: Array<[number, number]> = ref?.near && ref.near.distanceM <= 150_000 ? [[ref.near.place.lat, ref.near.place.lon]] : [];
        view.current = fit(sc, cw, ch, compact ? 22 : 70, extra);
      }
      lastSig = sig;
      dirty.current = false;
      lastDraw = time;
      const v = view.current!;
      const c = cosf(v);
      const halfLon = cw / 2 / (v.k * c), halfLat = ch / 2 / v.k;
      draw({ g, w: cw, h: ch, v, c, visMinLon: v.lon0 - halfLon, visMaxLon: v.lon0 + halfLon, visMinLat: v.lat0 - halfLat, visMaxLat: v.lat0 + halfLat }, worldRef.current, sc, endsRef.current, compact, time);
    };
    raf = requestAnimationFrame(frame);

    // Interaction (full map only)
    const setManual = (): void => {
      if (auto.current) {
        auto.current = false;
        setIsAuto(false);
      }
    };
    const onWheel = (e: WheelEvent): void => {
      if (compact || !view.current) return;
      e.preventDefault();
      setManual();
      const v = view.current;
      const r = cv.getBoundingClientRect();
      const mx = e.clientX - r.left - cw / 2, my = e.clientY - r.top - ch / 2;
      const c = cosf(v);
      const lonAt = v.lon0 + mx / (v.k * c), latAt = v.lat0 - my / v.k;
      const f = Math.exp(-e.deltaY * 0.0015);
      const k = Math.max(worldK(cw, ch) * 0.8, Math.min(6000, v.k * f));
      const nv = { lon0: v.lon0, lat0: v.lat0, k };
      nv.lat0 = clampLat(latAt + my / k);
      nv.lon0 = lonAt - mx / (k * cosf(nv));
      view.current = nv;
      dirty.current = true;
    };
    let drag: { x: number; y: number; v: View } | null = null;
    const onDown = (e: PointerEvent): void => {
      if (compact || !view.current) return;
      drag = { x: e.clientX, y: e.clientY, v: { ...view.current } };
      cv.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent): void => {
      if (!drag) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) setManual();
      const v = drag.v;
      view.current = { lon0: v.lon0 - dx / (v.k * cosf(v)), lat0: clampLat(v.lat0 + dy / v.k), k: v.k };
      dirty.current = true;
    };
    const onUp = (): void => { drag = null; };
    const onDbl = (): void => {
      if (compact) return;
      auto.current = true;
      setIsAuto(true);
      dirty.current = true;
    };
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('dblclick', onDbl);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      cv.removeEventListener('wheel', onWheel);
      cv.removeEventListener('pointerdown', onDown);
      cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp);
      cv.removeEventListener('pointercancel', onUp);
      cv.removeEventListener('dblclick', onDbl);
    };
  }, [ctl, compact]);

  const zoom = (f: number): void => {
    const v = view.current;
    const el = host.current;
    if (!v || !el) return;
    auto.current = false;
    setIsAuto(false);
    const r = el.getBoundingClientRect();
    view.current = { ...v, k: Math.max(worldK(r.width, r.height) * 0.8, Math.min(6000, v.k * f)) };
    dirty.current = true;
  };
  const showWorld = (): void => {
    const el = host.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    auto.current = false;
    setIsAuto(false);
    view.current = { lon0: ctl.store.get().config.site.longitudeDeg, lat0: 0, k: worldK(r.width, r.height) };
    dirty.current = true;
  };
  const refit = (): void => {
    auto.current = true;
    setIsAuto(true);
    dirty.current = true;
  };

  return (
    <div className={`gmap${compact ? ' compact' : ''}`} ref={host}>
      <canvas
        ref={canvas}
        role="img"
        aria-label={ends.actual ? 'Map of the flight ground track and where it ended' : ends.forecast ? 'Map of the forecast ground track and landing point' : 'Map of the launch site'}
        onClick={compact ? onExpand : undefined}
        style={{ cursor: compact ? 'pointer' : 'grab' }}
      />
      {!world && <div className="gmap-loading">Loading map…</div>}
      {!compact && (
        <div className="gmap-tools" role="group" aria-label="Map controls">
          <button className="btn small" onClick={() => zoom(1.6)} aria-label="Zoom in">+</button>
          <button className="btn small" onClick={() => zoom(1 / 1.6)} aria-label="Zoom out">−</button>
          <button className="btn small" aria-pressed={isAuto} onClick={refit} title="Fit the tracks (double-click the map)">Fit</button>
          <button className="btn small" onClick={showWorld}>World</button>
        </div>
      )}
      {!compact && (
        <div className="gmap-legend">
          <span><i className="lg-site" />launch site</span>
          <span><i className="lg-flown" />flown</span>
          <span><i className="lg-fc" />forecast (same solver)</span>
          <span className="faint">Map: Natural Earth</span>
        </div>
      )}
    </div>
  );
}
