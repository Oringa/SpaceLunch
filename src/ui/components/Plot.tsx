import { useEffect, useRef } from 'react';
import type { TelemetryTable } from '../../sim/telemetry';

export interface PlotSeries {
  table: TelemetryTable | null | undefined;
  channel: string;
  color: string;
  dashed?: boolean;
  label: string;
  width?: number;
}

interface Props {
  title: string;
  unit: string;
  scale: number;
  series: PlotSeries[];
  /** Time offset subtracted from t (e.g. release time) for the x axis. */
  t0: number;
  xLabel: string;
  cursor: number | null;
  onCursor: (t: number | null) => void;
  events?: Array<{ t: number; color: string }>;
  peak?: string;
  log?: boolean;
  xMax?: number;
}

const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

/** Min/max decimation per pixel column keeps peaks visible at any zoom. */
function drawSeries(ctx: CanvasRenderingContext2D, tcol: Float64Array, ycol: Float64Array, t0: number, x0: number, x1: number, ymin: number, ymax: number, w: number, h: number, pad: { l: number; t: number; b: number; r: number }, scale: number, log: boolean): void {
  const n = tcol.length;
  if (n < 2) return;
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
  const X = (t: number): number => pad.l + ((t - t0 - x0) / (x1 - x0)) * pw;
  const Y = (v: number): number => {
    const vv = log ? Math.log10(Math.max(v, 1e-30)) : v;
    return pad.t + ph - ((vv - ymin) / (ymax - ymin)) * ph;
  };
  ctx.beginPath();
  let col = -1, cmin = 0, cmax = 0, started = false;
  const flush = (c: number): void => {
    if (!started) {
      ctx.moveTo(c, Y(cmin));
      started = true;
    }
    ctx.lineTo(c, Y(cmin));
    if (cmax !== cmin) ctx.lineTo(c, Y(cmax));
  };
  for (let i = 0; i < n; i++) {
    const v = ycol[i] * scale;
    if (!Number.isFinite(v)) continue;
    const c = Math.round(X(tcol[i]));
    if (c !== col) {
      if (col >= 0) flush(col);
      col = c;
      cmin = cmax = v;
    } else {
      if (v < cmin) cmin = v;
      if (v > cmax) cmax = v;
    }
  }
  if (col >= 0) flush(col);
  ctx.stroke();
}

export function Plot({ title, unit, scale, series, t0, xLabel, cursor, onCursor, events, peak, log = false, xMax }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const cv = ref.current, box = wrap.current;
    if (!cv || !box) return;
    const dpr = window.devicePixelRatio || 1;
    const w = box.clientWidth, h = box.clientHeight;
    cv.width = Math.max(1, Math.floor(w * dpr));
    cv.height = Math.max(1, Math.floor(h * dpr));
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pad = { l: 48, r: 8, t: 18, b: 18 };
    // Ranges
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of series) {
      const tb = s.table;
      if (!tb || tb.length < 1 || !(s.channel in tb.index)) continue;
      const tc = tb.col('t'), yc = tb.col(s.channel);
      x0 = Math.min(x0, tc[0] - t0);
      x1 = Math.max(x1, tc[tc.length - 1] - t0);
      for (let i = 0; i < yc.length; i++) {
        let v = yc[i] * scale;
        if (!Number.isFinite(v)) continue;
        if (log) {
          if (v <= 0) continue;
          v = Math.log10(v);
        }
        if (v < y0) y0 = v;
        if (v > y1) y1 = v;
      }
    }
    const grid = css('--line');
    const faint = css('--text-faint');
    ctx.font = '10px ui-monospace, monospace';
    if (!Number.isFinite(x0) || !Number.isFinite(y0)) {
      ctx.fillStyle = faint;
      ctx.fillText('no data yet', pad.l + 6, h / 2);
      return;
    }
    if (xMax !== undefined) x1 = Math.min(x1, xMax);
    if (x1 <= x0) x1 = x0 + 1;
    if (y1 <= y0) { y1 = y0 + (Math.abs(y0) || 1) * 0.1; y0 = y0 - (Math.abs(y0) || 1) * 0.1; }
    const yr = y1 - y0;
    y1 += yr * 0.06;
    if (!log && y0 > 0 && y0 < yr * 0.5) y0 = 0;
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    // Grid + ticks
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = faint;
    for (let k = 0; k <= 3; k++) {
      const yy = pad.t + (ph * k) / 3;
      ctx.beginPath();
      ctx.moveTo(pad.l, yy);
      ctx.lineTo(w - pad.r, yy);
      ctx.stroke();
      const v = y1 - ((y1 - y0) * k) / 3;
      const lab = log ? `1e${v.toFixed(1)}` : Math.abs(v) >= 1e4 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : v.toFixed(Math.abs(v) < 10 ? 2 : 0);
      ctx.fillText(lab, 2, yy + 3);
    }
    for (let k = 0; k < 4; k++) {
      const xx = pad.l + (pw * k) / 4;
      const v = x0 + ((x1 - x0) * k) / 4;
      ctx.fillText(Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(0), xx - (k === 0 ? 0 : 8), h - 5);
    }
    const xl = `${Math.abs(x1) < 10 ? x1.toFixed(2) : x1.toFixed(0)} ${xLabel}`;
    ctx.fillText(xl, w - pad.r - ctx.measureText(xl).width, h - 5);
    // Events
    if (events) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      for (const e of events) {
        const xx = pad.l + ((e.t - t0 - x0) / (x1 - x0)) * pw;
        if (xx < pad.l || xx > w - pad.r) continue;
        ctx.strokeStyle = e.color;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(xx, pad.t);
        ctx.lineTo(xx, h - pad.b);
        ctx.stroke();
      }
      ctx.restore();
    }
    // Series
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t - 2, pw, ph + 4);
    ctx.clip();
    for (const s of series) {
      const tb = s.table;
      if (!tb || tb.length < 2 || !(s.channel in tb.index)) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width ?? 1.5;
      ctx.setLineDash(s.dashed ? [5, 4] : []);
      drawSeries(ctx, tb.col('t'), tb.col(s.channel), t0, x0, x1, y0, y1, w, h, pad, scale, log);
    }
    ctx.restore();
    // Cursor
    if (cursor !== null) {
      const xx = pad.l + ((cursor - t0 - x0) / (x1 - x0)) * pw;
      if (xx >= pad.l && xx <= w - pad.r) {
        ctx.strokeStyle = css('--text');
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(xx, pad.t);
        ctx.lineTo(xx, h - pad.b);
        ctx.stroke();
        // Readout from the first series.
        const s = series.find((q) => q.table && q.table.length > 1 && q.channel in q.table.index);
        if (s?.table) {
          const r = s.table.rowAt(cursor);
          const v = s.table.get(s.channel, r) * scale;
          ctx.fillStyle = css('--text');
          const txt = `${Number.isFinite(v) ? (Math.abs(v) >= 1e4 ? v.toExponential(3) : v.toFixed(3)) : '—'} ${unit} @ ${(cursor - t0).toFixed(3)}`;
          ctx.fillText(txt, Math.min(xx + 4, w - pad.r - ctx.measureText(txt).width), pad.t + 10);
        }
      }
    }
  });
  const onMove = (e: React.MouseEvent): void => {
    const box = wrap.current;
    const s = series.find((q) => q.table && q.table.length > 1);
    if (!box || !s?.table) return;
    const rect = box.getBoundingClientRect();
    const tc = s.table.col('t');
    let x0 = tc[0] - t0, x1 = tc[tc.length - 1] - t0;
    for (const q of series) {
      if (!q.table || q.table.length < 2) continue;
      const c = q.table.col('t');
      x0 = Math.min(x0, c[0] - t0);
      x1 = Math.max(x1, c[c.length - 1] - t0);
    }
    if (xMax !== undefined) x1 = Math.min(x1, xMax);
    const f = (e.clientX - rect.left - 48) / (rect.width - 56);
    if (f < 0 || f > 1) return;
    onCursor(t0 + x0 + f * (x1 - x0));
  };
  return (
    <div className="plot" ref={wrap} onMouseMove={onMove} onMouseLeave={() => onCursor(null)} role="img" aria-label={`${title} plot`}>
      <canvas ref={ref} />
      <span className="title">{title} <span className="faint">({unit})</span></span>
      {peak && <span className="peak">{peak}</span>}
    </div>
  );
}
