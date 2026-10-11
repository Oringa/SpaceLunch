/**
 * WebGL2 renderer: owns the THREE.WebGLRenderer (logarithmic depth), the
 * CSS2D label layer, the animation loop (capped at 60 fps) and the three
 * views (launcher / world / orbit), switching between them according to
 * source.view(). It only reads the RenderSource; it never changes physics.
 */
import * as THREE from 'three';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { Renderer, RenderSource, ViewKind } from './types';
import { NO_INSETS, type FrameContext, type View } from './viewBase';
import { LauncherView } from './launcherView';
import { WorldView } from './worldView';
import { OrbitView } from './orbitView';
import { COLORS, ensureStyle } from './style';

let _supported: boolean | null = null;

export class SceneManager implements Renderer {
  readonly kind = 'webgl2' as const;

  /** True iff a WebGL2 context can be created in this browser. */
  static supported(): boolean {
    if (_supported !== null) return _supported;
    try {
      if (typeof document === 'undefined') return (_supported = false);
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      _supported = !!gl;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      _supported = false;
    }
    return _supported;
  }

  private readonly container: HTMLElement;
  private readonly source: RenderSource;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels: CSS2DRenderer;
  private readonly overlayRoot: HTMLDivElement;
  private readonly views: Partial<Record<ViewKind, View>> = {};
  private active: View | null = null;
  private activeKind: ViewKind | null = null;
  private readonly ro: ResizeObserver | null;
  private raf = 0;
  private running = false;
  private disposed = false;
  private lastFrame = -Infinity;
  private lastWall = 0;
  private width = 1;
  private height = 1;
  private sizeDirty = true;
  private readonly t0 = performance.now();
  private readonly errorsSeen = new Set<string>();
  private contextLost = false;
  private readonly onLost = (e: Event): void => {
    e.preventDefault();
    this.contextLost = true;
  };
  private readonly onRestored = (): void => {
    this.contextLost = false;
  };

  constructor(container: HTMLElement, source: RenderSource) {
    this.container = container;
    this.source = source;
    ensureStyle(container.ownerDocument);
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, alpha: false, stencil: true, powerPreference: 'high-performance' });
    if (!this.renderer.capabilities.isWebGL2) throw new Error('WebGL2 context required');
    // 1.5x cap keeps MSAA affordable on laptop iGPUs; labels are HTML and stay crisp.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(COLORS.background, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const canvas = this.renderer.domElement;
    canvas.style.position = 'absolute';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';
    canvas.setAttribute('aria-label', 'Launch visualisation (3D)');
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    container.appendChild(canvas);

    this.labels = new CSS2DRenderer();
    const ld = this.labels.domElement;
    ld.style.position = 'absolute';
    ld.style.inset = '0';
    ld.style.pointerEvents = 'none';
    ld.style.overflow = 'hidden';
    container.appendChild(ld);

    this.overlayRoot = document.createElement('div');
    this.overlayRoot.className = 'cf-layer';
    container.appendChild(this.overlayRoot);

    this.ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => (this.sizeDirty = true)) : null;
    this.ro?.observe(container);
    this.applySize();
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.raf = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  resize(): void {
    this.sizeDirty = true;
    if (!this.running) this.applySize();
  }

  resetCamera(): void {
    this.active?.resetCamera(this.context(0));
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.ro?.disconnect();
    for (const v of Object.values(this.views)) v?.dispose();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onLost);
    canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
    this.labels.domElement.remove();
    this.overlayRoot.remove();
  }

  // ------------------------------------------------------------------ internals
  private applySize(): void {
    this.sizeDirty = false;
    const w = Math.max(1, Math.floor(this.container.clientWidth));
    const h = Math.max(1, Math.floor(this.container.clientHeight));
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.labels.setSize(w, h);
    for (const v of Object.values(this.views)) v?.resize(w, h);
  }

  private view(kind: ViewKind): View {
    let v = this.views[kind];
    if (!v) {
      const dom = this.renderer.domElement;
      v = kind === 'launcher' ? new LauncherView(dom, this.overlayRoot) : kind === 'world' ? new WorldView(dom, this.overlayRoot) : new OrbitView(dom, this.overlayRoot);
      v.resize(this.width, this.height);
      this.views[kind] = v;
    }
    return v;
  }

  private context(wall: number): FrameContext {
    const s = this.source;
    const ins = s.insets?.();
    return {
      source: s,
      insets: ins ? { top: ins.top || 0, bottom: ins.bottom || 0, left: ins.left || 0, right: ins.right || 0 } : NO_INSETS,
      variant: s.variant?.() ?? 'engineer',
      goalAltitude: s.goalAltitude?.() ?? null,
      snap: s.snapshot(),
      scenario: s.scenario(),
      flown: s.flown(),
      predicted: s.predicted(),
      overlays: s.overlays(),
      reducedMotion: s.reducedMotion(),
      width: this.width,
      height: this.height,
      wall,
      dtWall: Math.max(0, wall - this.lastWall),
    };
  }

  private switchTo(kind: ViewKind): void {
    if (kind === this.activeKind) return;
    const old = this.active;
    if (old) {
      old.deactivate();
      // Hide the old scene's CSS2D labels.
      old.scene.visible = false;
      this.labels.render(old.scene, old.camera);
      old.scene.visible = true;
    }
    this.active = this.view(kind);
    this.activeKind = kind;
    this.active.activate();
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    if (now - this.lastFrame < 1000 / 60 - 2) return;
    this.lastFrame = now;
    if (this.contextLost) return;
    try {
      this.renderOnce((now - this.t0) / 1000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!this.errorsSeen.has(msg)) {
        this.errorsSeen.add(msg);
        console.error('[renderer]', e);
      }
    }
  };

  /** Render one frame now (also used by tests/harnesses). */
  renderOnce(wall = (performance.now() - this.t0) / 1000): void {
    if (this.sizeDirty) this.applySize();
    this.switchTo(this.source.view());
    const v = this.active;
    if (!v) return;
    const ctx = this.context(wall);
    this.lastWall = wall;
    v.update(ctx);
    this.renderer.render(v.scene, v.camera);
    const ins = v.inset?.();
    if (ins) {
      const r = this.renderer;
      r.setScissorTest(true);
      r.setViewport(ins.x, ins.y, ins.w, ins.h);
      r.setScissor(ins.x, ins.y, ins.w, ins.h);
      r.render(v.scene, ins.camera);
      r.setScissorTest(false);
      r.setViewport(0, 0, this.width, this.height);
    }
    this.labels.render(v.scene, v.camera);
  }
}
