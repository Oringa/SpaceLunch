/**
 * Canvas2D fallback used when WebGL2 is unavailable: a launcher schematic
 * (chamber circle, arm at the rotor phase, exit tunnel at the release
 * elevation, vehicle) and an altitude-vs-downrange plot of the flown (solid)
 * and predicted (dashed) trajectories with an Earth-curvature hint.
 */
import type { Renderer, RenderSource } from './types';
import type { TelemetryTable } from '../sim/telemetry';
import type { Scenario } from '../sim/build';
import type { Snapshot } from '../sim/session';
import { R_EARTH } from '../physics/constants';
import { type Vec3, cross, dot, norm, rotZ, sub } from '../physics/vec3';
import { eciRowsToEcef, hasTrajectory } from './projection';
import { COLORS, fmtFixed, fmtInt, fmtKm, niceStep } from './style';

interface Profile {
  table: TelemetryTable | null;
  len: number;
  x: Float64Array; // downrange (m)
  y: Float64Array; // altitude (m)
}

const emptyProfile = (): Profile => ({ table: null, len: 0, x: new Float64Array(0), y: new Float64Array(0) });

export class Fallback2D implements Renderer {
  readonly kind = 'canvas2d' as const;
  private readonly container: HTMLElement;
  private readonly source: RenderSource;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly ro: ResizeObserver | null;
  private raf = 0;
  private running = false;
  private last = -Infinity;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private sizeDirty = true;
  private flownP = emptyProfile();
  private predP = emptyProfile();
  private readonly t0 = performance.now();

  constructor(container: HTMLElement, source: RenderSource) {
    this.container = container;
    this.source = source;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Launch diagnostic view (2D)');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => (this.sizeDirty = true)) : null;
    this.ro?.observe(container);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  resize(): void {
    this.sizeDirty = true;
  }

  resetCamera(): void {
    /* fixed framing */
  }

  dispose(): void {
    this.stop();
    this.ro?.disconnect();
    this.canvas.remove();
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    if (now - this.last < 1000 / 60 - 2) return;
    this.last = now;
    this.draw((now - this.t0) / 1000);
  };

  private applySize(): void {
    this.sizeDirty = false;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, this.container.clientWidth);
    this.h = Math.max(1, this.container.clientHeight);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /** Draw one frame immediately. */
  draw(wall = (performance.now() - this.t0) / 1000): void {
    const g = this.ctx;
    if (!g) return;
    if (this.sizeDirty) this.applySize();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#0d1117';
    g.fillRect(0, 0, this.w, this.h);
    const sc = this.source.scenario();
    const snap = this.source.snapshot();
    const banner = 40;
    const narrow = this.w < 640;
    const pad = 16;
    const leftW = narrow ? this.w - 2 * pad : Math.min(this.w * 0.42, this.h - banner - pad);
    const lx = pad, ly = banner;
    const lh = narrow ? (this.h - banner - pad) * 0.5 : this.h - banner - pad;
    const rx = narrow ? pad : lx + leftW + pad;
    const ry = narrow ? ly + lh + pad : banner;
    const rw = narrow ? this.w - 2 * pad : this.w - rx - pad;
    const rh = narrow ? this.h - ry - pad : this.h - banner - pad;
    if (sc) this.drawLauncher(g, sc, snap, lx, ly, leftW, lh, wall);
    this.drawPlot(g, sc, snap, rx, ry, rw, rh);
    // Banner.
    g.font = '600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const text = 'WebGL2 unavailable — 2D diagnostic view';
    const tw = g.measureText(text).width + 24;
    g.fillStyle = 'rgba(13,17,23,0.9)';
    g.strokeStyle = 'rgba(242,204,96,0.85)';
    g.lineWidth = 1;
    g.fillRect(this.w / 2 - tw / 2, 8, tw, 24);
    g.strokeRect(this.w / 2 - tw / 2 + 0.5, 8.5, tw - 1, 23);
    g.fillStyle = '#f8e3a1';
    g.fillText(text, this.w / 2, 20);
  }

  private drawLauncher(g: CanvasRenderingContext2D, sc: Scenario, snap: Snapshot | null, x: number, y: number, w: number, h: number, wall: number): void {
    const geo = sc.geometry;
    const Rc = geo.chamberRadius, R = geo.armRadius;
    const extent = Math.max(Rc * 1.15, geo.sEnd * 0.7);
    const s = (Math.min(w, h) / 2 - 18) / extent;
    const cx = x + w / 2, cy = y + h / 2 + Rc * s * 0.1;
    const P = (lh: number, lu: number): [number, number] => [cx + lh * s, cy - lu * s];
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    // Ground.
    const [, gy] = P(0, -geo.hubHeight);
    g.strokeStyle = '#253141';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x, gy);
    g.lineTo(x + w, gy);
    g.stroke();
    // Chamber.
    g.fillStyle = '#141b25';
    g.strokeStyle = '#9aa7b8';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(cx, cy, Rc * s, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    // Vehicle circle (dashed) and release marker.
    g.setLineDash([4, 4]);
    g.strokeStyle = '#6e7681';
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, cy, R * s, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    // Canvas angle for phase phi: point (cos phi, -sin phi) in (h, u) -> canvas (cos phi, +sin phi).
    const pr = geo.phiRelease;
    g.strokeStyle = COLORS.release;
    g.lineWidth = 5;
    g.beginPath();
    g.arc(cx, cy, R * s, pr - 0.05, pr + 0.05);
    g.stroke();
    // Tunnel.
    const th = -Math.sin(pr), tu = -Math.cos(pr);
    const oh = R * Math.cos(pr), ou = -R * Math.sin(pr);
    const [ax, ay] = P(oh + th * geo.sWall, ou + tu * geo.sWall);
    const [bx, by] = P(oh + th * geo.sEnd, ou + tu * geo.sEnd);
    const [ox, oy] = P(oh, ou);
    g.setLineDash([3, 3]);
    g.strokeStyle = COLORS.release;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(ox, oy);
    g.lineTo(ax, ay);
    g.stroke();
    g.setLineDash([]);
    g.strokeStyle = '#9aa7b8';
    g.lineWidth = Math.max(4, geo.apertureRadius * 2 * s);
    g.beginPath();
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.stroke();
    // Rotor.
    const omega = snap ? snap.rotor.omega : 0;
    const released = !!snap?.vehicle && snap.rotor.attached === false;
    const fl = this.source.flown();
    const tRel = hasTrajectory(fl) ? fl.get('t', 0) : NaN;
    const trueWindow = snap?.phase === 'hold' || snap?.phase === 'corridor' || (released && snap!.t - tRel < 0.3);
    const strobe = !!snap && omega > 2 && !trueWindow;
    let phi = snap ? snap.rotor.phi : Math.PI / 2;
    if (strobe) {
      phi = pr - Math.PI / 2 + (this.source.reducedMotion() ? 0 : 0.12 * wall);
      if (!this.source.reducedMotion()) {
        g.fillStyle = 'rgba(159,179,200,0.10)';
        g.beginPath();
        g.arc(cx, cy, (R + sc.vehicle.length / 2) * s, 0, Math.PI * 2);
        g.fill();
      }
    }
    const Rcw = sc.rotor.counterRadius;
    g.strokeStyle = '#8b949e';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx - Rcw * Math.cos(phi) * s, cy - Rcw * Math.sin(phi) * s);
    g.lineTo(cx + R * Math.cos(phi) * s, cy + R * Math.sin(phi) * s);
    g.stroke();
    if (!(released && sc.release.balance.releasesBallast)) {
      g.fillStyle = '#9e6a3a';
      g.fillRect(cx - Rcw * Math.cos(phi) * s - 4, cy - Rcw * Math.sin(phi) * s - 4, 8, 8);
    }
    g.fillStyle = '#8b949e';
    g.beginPath();
    g.arc(cx, cy, 5, 0, Math.PI * 2);
    g.fill();
    // Vehicle.
    let vx = cx + R * Math.cos(phi) * s, vy = cy + R * Math.sin(phi) * s;
    if (released && snap?.vehicle) {
      const pE = rotZ(snap.vehicle.r, -snap.earthAngle);
      const d = sub(pE, geo.hubEcef);
      [vx, vy] = P(dot(d, geo.h), dot(d, geo.u));
    }
    const onCanvas = vx >= x && vx <= x + w && vy >= y && vy <= y + h;
    if (onCanvas) {
      g.fillStyle = COLORS.flown;
      g.beginPath();
      g.arc(vx, vy, 4.5, 0, Math.PI * 2);
      g.fill();
    }
    // Labels.
    g.fillStyle = '#9da7b3';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillText(`chamber Ø ${fmtInt(2 * Rc)} m · arm ${fmtInt(R)} m · elevation ${fmtFixed((geo.elevation * 180) / Math.PI, 0)}°`, x + 4, y + 4);
    if (snap) g.fillText(`${snap.phase} · ${fmtFixed(snap.rotor.rpm, 1)} rpm · tip ${fmtInt(snap.rotor.tipSpeed)} m/s`, x + 4, y + 18);
    if (strobe) {
      g.fillStyle = '#f8e3a1';
      g.fillText(`STROBOSCOPIC — actual rotor ${fmtFixed(snap!.rotor.rpm, 1)} rpm`, x + 4, y + 32);
    }
    if (released && !onCanvas && snap?.vehicle) {
      g.fillStyle = '#ffd8a8';
      g.fillText(`vehicle ↗ ${fmtKm(snap.vehicle.altitude)}`, x + 4, y + h - 16);
    }
    g.restore();
  }

  private profile(p: Profile, t: TelemetryTable | null, sc: Scenario | null): Profile {
    if (!hasTrajectory(t) || !sc) return emptyProfile();
    if (p.table === t && p.len === t.length) return p;
    const n = t.length;
    const rot = sc.config.physics.earthRotation;
    const site = sc.geometry.hubEcef;
    const h = sc.geometry.h;
    const out: Profile = { table: t, len: n, x: new Float64Array(n), y: new Float64Array(n) };
    const buf = new Float64Array(3);
    const hasAlt = 'alt' in t.index;
    for (let i = 0; i < n; i++) {
      eciRowsToEcef(t, i, i + 1, rot, buf);
      const pE: Vec3 = [buf[0], buf[1], buf[2]];
      const ang = Math.atan2(norm(cross(site, pE)), dot(site, pE));
      const sgn = dot(sub(pE, site), h) >= 0 ? 1 : -1;
      out.x[i] = sgn * ang * R_EARTH;
      out.y[i] = hasAlt ? t.get('alt', i) : norm(pE) - R_EARTH;
    }
    return out;
  }

  private drawPlot(g: CanvasRenderingContext2D, sc: Scenario | null, snap: Snapshot | null, x: number, y: number, w: number, h: number): void {
    this.flownP = this.profile(this.flownP, this.source.flown(), sc);
    const showPred = this.source.overlays().predicted;
    this.predP = showPred ? this.profile(this.predP, this.source.predicted(), sc) : emptyProfile();
    const ml = 52, mb = 30, mt = 10, mr = 12;
    const px = x + ml, py = y + mt, pw = Math.max(10, w - ml - mr), ph = Math.max(10, h - mt - mb);
    let xMax = 10_000, yMax = 10_000, xMin = 0;
    for (const p of [this.flownP, this.predP]) {
      for (let i = 0; i < p.len; i++) {
        xMax = Math.max(xMax, p.x[i]);
        xMin = Math.min(xMin, p.x[i]);
        yMax = Math.max(yMax, p.y[i]);
      }
    }
    xMax *= 1.05;
    yMax *= 1.1;
    const X = (v: number): number => px + ((v - xMin) / (xMax - xMin)) * pw;
    const Y = (v: number): number => py + ph - (v / yMax) * ph;
    g.save();
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    g.strokeStyle = '#30363d';
    g.lineWidth = 1;
    g.strokeRect(px + 0.5, py + 0.5, pw, ph);
    // Grid + ticks (km).
    g.fillStyle = '#8b949e';
    const xs = niceStep((xMax - xMin) / 6), ys = niceStep(yMax / 5);
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let v = Math.ceil(xMin / xs) * xs; v <= xMax; v += xs) {
      g.strokeStyle = '#1c232c';
      g.beginPath();
      g.moveTo(X(v) + 0.5, py);
      g.lineTo(X(v) + 0.5, py + ph);
      g.stroke();
      g.fillText(fmtInt(v / 1000), X(v), py + ph + 4);
    }
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (let v = 0; v <= yMax; v += ys) {
      g.strokeStyle = '#1c232c';
      g.beginPath();
      g.moveTo(px, Y(v) + 0.5);
      g.lineTo(px + pw, Y(v) + 0.5);
      g.stroke();
      g.fillText(fmtInt(v / 1000), px - 6, Y(v));
    }
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    g.fillText('downrange (km)', px + pw / 2, y + h);
    g.save();
    g.translate(x + 10, py + ph / 2);
    g.rotate(-Math.PI / 2);
    g.textBaseline = 'middle';
    g.fillText('altitude (km)', 0, 0);
    g.restore();
    g.beginPath();
    g.rect(px, py, pw, ph);
    g.clip();
    // Earth-curvature hint: the site's tangent plane rises d^2 / 2R above the surface.
    g.setLineDash([2, 4]);
    g.strokeStyle = '#56657a';
    g.beginPath();
    for (let i = 0; i <= 100; i++) {
      const d = xMin + ((xMax - xMin) * i) / 100;
      const yy = Y((d * d) / (2 * R_EARTH));
      if (i === 0) g.moveTo(X(d), yy);
      else g.lineTo(X(d), yy);
    }
    g.stroke();
    // 100 km line.
    if (yMax > 100_000) {
      g.strokeStyle = 'rgba(143,180,255,0.6)';
      g.setLineDash([6, 4]);
      g.beginPath();
      g.moveTo(px, Y(100_000));
      g.lineTo(px + pw, Y(100_000));
      g.stroke();
    }
    g.setLineDash([]);
    const line = (p: Profile, color: string, dashed: boolean, width: number): void => {
      if (p.len < 2) return;
      g.strokeStyle = color;
      g.lineWidth = width;
      g.setLineDash(dashed ? [8, 6] : []);
      g.beginPath();
      g.moveTo(X(p.x[0]), Y(p.y[0]));
      const step = Math.max(1, Math.floor(p.len / 4000));
      for (let i = step; i < p.len; i += step) g.lineTo(X(p.x[i]), Y(p.y[i]));
      g.lineTo(X(p.x[p.len - 1]), Y(p.y[p.len - 1]));
      g.stroke();
    };
    line(this.predP, COLORS.predicted, true, 1.6);
    line(this.flownP, COLORS.flown, false, 2.4);
    g.setLineDash([]);
    if (snap?.vehicle && this.flownP.len) {
      const i = this.flownP.len - 1;
      g.fillStyle = COLORS.flown;
      g.beginPath();
      g.arc(X(this.flownP.x[i]), Y(this.flownP.y[i]), 4, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
    // Legend.
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    const lgx = px + 10;
    let lgy = py + 12;
    const item = (color: string, dashed: boolean, text: string): void => {
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.setLineDash(dashed ? [5, 4] : []);
      g.beginPath();
      g.moveTo(lgx, lgy);
      g.lineTo(lgx + 22, lgy);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#c9d1d9';
      g.fillText(text, lgx + 28, lgy);
      lgy += 15;
    };
    item(COLORS.flown, false, 'flown');
    if (showPred) item(COLORS.predicted, true, 'predicted');
    item('#56657a', true, 'site horizon plane (Earth curves away)');
  }
}
