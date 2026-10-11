/**
 * Shared presentation helpers for the renderer: the inline stylesheet for
 * CSS2D labels and HTML overlays, label factories, number formatting and a
 * per-view HTML overlay (caption, banner, scale bar).
 */
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export const COLORS = {
  background: 0x0d1117,
  flown: '#ffb454',
  predicted: '#4cc9f0',
  warn: '#ff5c57',
  release: '#f2cc60',
  velocity: '#7ee787',
  accel: '#d2a8ff',
  conic: '#c9d1d9',
  band: '#3fb950',
  shell: '#5b8bd9',
  karman: '#8fb4ff',
  text: '#e6edf3',
  muted: '#8b949e',
} as const;

const STYLE_ID = 'cf-render-style';
const CSS = `
.cf-layer{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.cf-label{font:500 11px/1.3 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;color:#e6edf3;
  background:rgba(13,17,23,.80);border:1px solid rgba(139,148,158,.35);border-radius:3px;padding:2px 6px;
  white-space:pre;pointer-events:none;letter-spacing:.02em;text-shadow:none}
.cf-label--muted{color:#9da7b3;border-color:rgba(139,148,158,.22);background:rgba(13,17,23,.6)}
.cf-label--amber{border-color:rgba(255,180,84,.7);color:#ffd8a8}
.cf-label--cyan{border-color:rgba(76,201,240,.7);color:#c4f1ff}
.cf-label--warn{border-color:rgba(255,92,87,.85);color:#ffc1bf}
.cf-label--release{border-color:rgba(242,204,96,.8);color:#f8e3a1}
.cf-label--green{border-color:rgba(126,231,135,.75);color:#c9f7cd}
.cf-label--violet{border-color:rgba(210,168,255,.75);color:#ead9ff}
.cf-label--blue{border-color:rgba(143,180,255,.6);color:#cfe0ff;background:rgba(13,17,23,.55)}
.cf-label--band{border-color:rgba(63,185,80,.75);color:#bdf0c5}
.cf-banner{position:absolute;top:10px;left:50%;transform:translateX(-50%);max-width:calc(100% - 24px);
  font:600 12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;letter-spacing:.03em;
  color:#e6edf3;background:rgba(13,17,23,.86);border:1px solid rgba(139,148,158,.45);border-radius:4px;
  padding:5px 10px;text-align:center;white-space:pre-wrap}
.cf-banner--strobe{border-color:rgba(242,204,96,.9);color:#f8e3a1}
.cf-banner--warn{border-color:rgba(255,92,87,.9);color:#ffc1bf}
.cf-banner--ok{border-color:rgba(63,185,80,.85);color:#bdf0c5}
.cf-banner--info{border-color:rgba(76,201,240,.7);color:#c4f1ff}
.cf-caption{position:absolute;top:10px;left:12px;max-width:45%;
  font:500 11px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;color:#9da7b3;
  letter-spacing:.04em;white-space:pre;text-transform:none}
.cf-caption b{color:#e6edf3;font-weight:600}
.cf-scalebar{position:absolute;left:14px;bottom:14px;font:500 11px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  color:#c9d1d9}
.cf-scalebar-bar{height:6px;border:1.5px solid #c9d1d9;border-top:none;margin-top:3px}
`;

export function ensureStyle(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
}

export type LabelVariant = 'default' | 'muted' | 'amber' | 'cyan' | 'warn' | 'release' | 'green' | 'violet' | 'blue' | 'band';

/** CSS2D label. `center` is the anchor inside the label box (0..1, 0..1; y down). */
export function makeLabel(text: string, variant: LabelVariant = 'default', center: [number, number] = [0.5, 0.5]): CSS2DObject {
  const div = document.createElement('div');
  div.className = variant === 'default' ? 'cf-label' : `cf-label cf-label--${variant}`;
  div.textContent = text;
  const obj = new CSS2DObject(div);
  obj.center.set(center[0], center[1]);
  return obj;
}

/** Update label text only when it changes (avoids per-frame DOM churn). */
export function setLabelText(obj: CSS2DObject, text: string): void {
  if (obj.element.textContent !== text) obj.element.textContent = text;
}

export function setLabelVariant(obj: CSS2DObject, variant: LabelVariant): void {
  const cls = variant === 'default' ? 'cf-label' : `cf-label cf-label--${variant}`;
  if (obj.element.className !== cls) obj.element.className = cls;
}

// ------------------------------------------------------------------ formatting
export const fmtInt = (x: number): string => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—');
export const fmtFixed = (x: number, d = 1): string =>
  Number.isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
export function fmtKm(m: number): string {
  if (!Number.isFinite(m)) return '∞';
  const km = m / 1000;
  if (Math.abs(km) >= 1000) return `${fmtInt(km)} km`;
  if (Math.abs(km) >= 10) return `${fmtFixed(km, 1)} km`;
  if (Math.abs(km) >= 1) return `${fmtFixed(km, 2)} km`;
  return `${fmtInt(m)} m`;
}
export function fmtLen(m: number): string {
  if (m >= 1000) return `${fmtFixed(m / 1000, m >= 10_000 ? 0 : 1)} km`;
  if (m >= 1) return `${fmtFixed(m, m >= 10 ? 0 : 1)} m`;
  return `${fmtFixed(m * 100, 0)} cm`;
}

/** Largest 1-2-5 step not exceeding x. */
export function niceStep(x: number): number {
  if (!(x > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

// ------------------------------------------------------------------ overlay

export type BannerVariant = 'default' | 'strobe' | 'warn' | 'ok' | 'info';

/** Per-view HTML overlay inside the renderer container. */
export class Overlay {
  readonly root: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly caption: HTMLDivElement;
  private readonly scale: HTMLDivElement;
  private readonly scaleText: HTMLDivElement;
  private readonly scaleBar: HTMLDivElement;
  private bannerKey = '';
  private captionKey = '';
  private scaleKey = '';

  constructor(parent: HTMLElement) {
    ensureStyle(parent.ownerDocument);
    this.root = document.createElement('div');
    this.root.className = 'cf-layer';
    this.root.style.display = 'none';
    this.caption = document.createElement('div');
    this.caption.className = 'cf-caption';
    this.banner = document.createElement('div');
    this.banner.className = 'cf-banner';
    this.banner.style.display = 'none';
    this.scale = document.createElement('div');
    this.scale.className = 'cf-scalebar';
    this.scaleText = document.createElement('div');
    this.scaleBar = document.createElement('div');
    this.scaleBar.className = 'cf-scalebar-bar';
    this.scale.append(this.scaleText, this.scaleBar);
    this.scale.style.display = 'none';
    this.root.append(this.caption, this.banner, this.scale);
    parent.appendChild(this.root);
  }

  show(on: boolean): void {
    this.root.style.display = on ? '' : 'none';
  }

  private layoutKey = '';
  /** Keep HTML overlays clear of UI insets; the corner caption is hidden in 'play'. */
  layout(insets: { top: number; bottom: number; left: number; right: number }, variant: 'engineer' | 'play'): void {
    const key = `${insets.top}|${insets.bottom}|${insets.left}|${insets.right}|${variant}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.caption.style.display = variant === 'play' ? 'none' : '';
    this.caption.style.top = `${insets.top + 10}px`;
    this.caption.style.left = `${insets.left + 12}px`;
    this.banner.style.top = `${insets.top + 10}px`;
    this.banner.style.left = `calc(${insets.left}px + (100% - ${insets.left + insets.right}px) / 2)`;
    this.banner.style.maxWidth = `calc(100% - ${insets.left + insets.right + 24}px)`;
    this.scale.style.left = `${insets.left + 14}px`;
    this.scale.style.bottom = `${insets.bottom + 14}px`;
  }

  setBanner(text: string | null, variant: BannerVariant = 'default'): void {
    const key = text === null ? '' : `${variant}|${text}`;
    if (key === this.bannerKey) return;
    this.bannerKey = key;
    if (text === null) {
      this.banner.style.display = 'none';
      return;
    }
    this.banner.style.display = '';
    this.banner.className = variant === 'default' ? 'cf-banner' : `cf-banner cf-banner--${variant}`;
    this.banner.textContent = text;
  }

  setCaption(title: string, detail: string): void {
    const key = `${title}|${detail}`;
    if (key === this.captionKey) return;
    this.captionKey = key;
    this.caption.replaceChildren();
    const b = document.createElement('b');
    b.textContent = title;
    this.caption.append(b, document.createTextNode(detail ? `\n${detail}` : ''));
  }

  /**
   * Scale bar for `pxPerMetre` at the camera target. Picks a 1-2-5 length
   * whose bar is roughly 70-160 px long.
   */
  setScale(pxPerMetre: number | null): void {
    if (pxPerMetre === null || !(pxPerMetre > 0) || !Number.isFinite(pxPerMetre)) {
      if (this.scaleKey !== '') {
        this.scaleKey = '';
        this.scale.style.display = 'none';
      }
      return;
    }
    const len = niceStep(150 / pxPerMetre);
    const px = Math.round(len * pxPerMetre);
    const key = `${len}|${px}`;
    if (key === this.scaleKey) return;
    this.scaleKey = key;
    this.scale.style.display = '';
    this.scaleText.textContent = fmtLen(len);
    this.scaleBar.style.width = `${px}px`;
  }

  dispose(): void {
    this.root.remove();
  }
}
