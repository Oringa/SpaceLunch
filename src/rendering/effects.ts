/**
 * Failure effects: a small pooled particle system for breakups, shared by the
 * three views.
 *
 *  - shards: tumbling solid fragments (one InstancedMesh), ballistic with
 *    linear drag and gravity, optionally colliding with a view-supplied
 *    surface (impulse response with Coulomb friction, so fragments skid along
 *    a curved wall and throw sparks before settling);
 *  - sparks: additive fat-line streaks (head at the particle, tail along
 *    -velocity) with optional glowing heads (constant-pixel points);
 *  - sprites: a short additive flash, smoke / dust puffs.
 *
 * Everything is allocated once and reused; positions are in the effect
 * group's local units. Views either leave the group at the scene origin
 * (launcher chamber: metres) or place it at the burst point and scale it so
 * one unit is one screen pixel (world/orbit views, where the vehicle marker
 * is magnified). Effects are animated in wall-clock time from the first frame
 * a failure is seen (FailureClock), since the simulation stops at a failure.
 */
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Snapshot } from '../sim/session';

const MAX_SHARDS = 160;
const MAX_SPARKS = 256;
const MAX_SPRITES = 24;
/** Restitution and friction coefficient for shard impacts. */
const RESTITUTION = 0.25;
const FRICTION = 0.3;
/** Sparks per second thrown by one shard skidding at full speed. */
const SKID_SPARK_RATE = 14;

/** Small deterministic PRNG (mulberry32), so a given failure always looks the same. */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Surface the shards collide with (view-specific, e.g. the chamber wall). */
export interface Collider {
  /**
   * If a sphere of radius r at p penetrates the surface, move p back onto it,
   * write the unit normal pointing INTO the surface (out of the free space)
   * into n and return true.
   */
  resolve(p: THREE.Vector3, r: number, n: THREE.Vector3): boolean;
}

export interface ShardSpawn {
  /** Spawn point (or the start of `to` for a line of shards). */
  at: THREE.Vector3;
  /** Spawn uniformly along the segment at -> to. */
  to?: THREE.Vector3;
  count: number;
  /** Shared base velocity. */
  vel?: THREE.Vector3;
  /** Per-shard base velocity from the spawn position (e.g. a rigid body's velocity field). */
  velAt?: (p: THREE.Vector3, out: THREE.Vector3) => void;
  /** Random isotropic speed added (uniform in a ball of this radius). */
  speed?: number;
  /** Random speed within a cone, added. */
  cone?: { dir: THREE.Vector3; angle: number; speed: number };
  /** Position jitter radius. */
  spread?: number;
  size: number;
  /** Relative size variation 0..1. */
  sizeVar?: number;
  color: THREE.ColorRepresentation | THREE.ColorRepresentation[];
  /** Max tumble rate (rad/s). */
  spin?: number;
  /** Seconds before removal (Infinity: persist), with a scale-out over `fade` seconds. */
  life?: number;
  fade?: number;
  /** Linear drag (1/s). */
  drag?: number;
  gravity?: THREE.Vector3;
  collide?: boolean;
  /** Skidding faster than this (units/s) on the collider throws sparks; 0 = never. */
  sparkSpeed?: number;
  /** Place at rest (no motion): reduced-motion scatter. */
  still?: boolean;
}

export interface SparkSpawn {
  at: THREE.Vector3;
  count: number;
  vel?: THREE.Vector3;
  speed?: number;
  cone?: { dir: THREE.Vector3; angle: number; speed: number };
  spread?: number;
  /** Life (s) and its relative variation. */
  life: number;
  lifeVar?: number;
  /** Streak length as seconds of travel. */
  streak?: number;
  drag?: number;
  gravity?: THREE.Vector3;
  hot?: THREE.ColorRepresentation;
  cool?: THREE.ColorRepresentation;
  /** Fraction of the sparks with a glowing head (0..1). */
  glow?: number;
}

export interface SpriteSpawn {
  at: THREE.Vector3;
  /** Start and end size (units). */
  size: number;
  size1?: number;
  life: number;
  color: THREE.ColorRepresentation;
  opacity?: number;
  /** 'flash': quick rise, fast decay, additive. 'puff': fade-in, slow fade-out. 'glow': slow additive swell. */
  kind?: 'flash' | 'puff' | 'glow';
  vel?: THREE.Vector3;
  drag?: number;
  gravity?: THREE.Vector3;
  /** Delay before it appears (s). */
  delay?: number;
}

interface Shard {
  p: THREE.Vector3;
  v: THREE.Vector3;
  g: THREE.Vector3;
  axis: THREE.Vector3;
  angle: number;
  spin: number;
  scale: THREE.Vector3;
  age: number;
  life: number;
  fade: number;
  drag: number;
  r: number;
  collide: boolean;
  rest: boolean;
  sparkSpeed: number;
  alive: boolean;
}

interface Spark {
  p: THREE.Vector3;
  v: THREE.Vector3;
  g: THREE.Vector3;
  age: number;
  life: number;
  streak: number;
  drag: number;
  hot: THREE.Color;
  cool: THREE.Color;
  glow: boolean;
  alive: boolean;
}

interface Puff {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  p: THREE.Vector3;
  v: THREE.Vector3;
  g: THREE.Vector3;
  age: number;
  life: number;
  size0: number;
  size1: number;
  opacity: number;
  drag: number;
  kind: 'flash' | 'puff' | 'glow';
  alive: boolean;
}

let _softCanvas: HTMLCanvasElement | null = null;
function softTexture(): THREE.Texture {
  if (!_softCanvas) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (g) {
      const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.22, 'rgba(255,255,255,0.75)');
      grd.addColorStop(0.55, 'rgba(255,255,255,0.22)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
    }
    _softCanvas = c;
  }
  const t = new THREE.CanvasTexture(_softCanvas);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _d = new THREE.Vector3();
const _b1 = new THREE.Vector3();
const _b2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const ZERO = new THREE.Vector3();

export interface BurstFxOptions {
  /** Draw on top of the scene (no depth test): marker-scale bursts in the world/orbit views. */
  overlay?: boolean;
  /** Spark streak width (CSS px). */
  sparkWidth?: number;
  /** Glowing spark head size (CSS px). */
  glowSize?: number;
  /** Unlit shards (scenes without lights, e.g. the orbit view). */
  unlit?: boolean;
}

export class BurstFx {
  readonly group = new THREE.Group();
  /** Surface shards with `collide` bounce off (view-specific). */
  collider: Collider | null = null;
  /** A shard touching a floor-like surface slower than this (units/s) comes to rest. */
  restSpeed = 0.05;
  private rand = rng(1);
  private readonly shardMesh: THREE.InstancedMesh;
  private readonly shardMat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
  private readonly heatColor = new THREE.Color('#ff7a1a');
  private readonly shards: Shard[] = [];
  private nShard = 0;
  private readonly sparks: Spark[] = [];
  private sparkHead = 0;
  private sparkHigh = 0;
  private readonly sparkPos = new Float32Array(MAX_SPARKS * 6);
  private readonly sparkCol = new Float32Array(MAX_SPARKS * 6);
  private readonly sparkPosBuf: THREE.InstancedInterleavedBuffer;
  private readonly sparkColBuf: THREE.InstancedInterleavedBuffer;
  private readonly sparkGeo: LineSegmentsGeometry;
  private readonly sparkMat: LineMaterial;
  private readonly sparkLines: LineSegments2;
  private readonly glowPos = new Float32Array(MAX_SPARKS * 3);
  private readonly glowCol = new Float32Array(MAX_SPARKS * 3);
  private readonly glowPoints: THREE.Points;
  private readonly puffs: Puff[] = [];
  private readonly tex: THREE.Texture;
  private alive = 0;
  private heat = { intensity: 0, decay: 1 };

  constructor(opts: BurstFxOptions = {}) {
    const overlay = !!opts.overlay;
    const order = overlay ? 12 : 7;
    this.tex = softTexture();
    // Shards: an irregular plate (squashed octahedron, flat shaded); per-instance scale adds variety.
    const geo = new THREE.OctahedronGeometry(1, 0);
    geo.scale(1, 0.34, 0.62);
    geo.computeVertexNormals();
    this.shardMat = opts.unlit
      ? new THREE.MeshBasicMaterial({ color: '#ffffff', depthTest: !overlay, depthWrite: !overlay })
      : new THREE.MeshStandardMaterial({
        color: '#ffffff', metalness: 0.15, roughness: 0.55, flatShading: true, emissive: '#ff7a1a', emissiveIntensity: 0,
        depthTest: !overlay, depthWrite: !overlay,
      });
    this.shardMesh = new THREE.InstancedMesh(geo, this.shardMat, MAX_SHARDS);
    this.shardMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.shardMesh.setColorAt(0, _c.set('#ffffff'));
    this.shardMesh.count = 0;
    this.shardMesh.frustumCulled = false;
    this.shardMesh.renderOrder = order;
    for (let i = 0; i < MAX_SHARDS; i++) {
      this.shards.push({
        p: new THREE.Vector3(), v: new THREE.Vector3(), g: new THREE.Vector3(), axis: new THREE.Vector3(1, 0, 0), angle: 0, spin: 0,
        scale: new THREE.Vector3(1, 1, 1), age: 0, life: Infinity, fade: 0, drag: 0, r: 0, collide: false, rest: false, sparkSpeed: 0, alive: false,
      });
    }

    // Sparks: fat additive streaks, colours fade to black (invisible under additive blending).
    this.sparkGeo = new LineSegmentsGeometry();
    this.sparkPosBuf = new THREE.InstancedInterleavedBuffer(this.sparkPos, 6, 1);
    this.sparkColBuf = new THREE.InstancedInterleavedBuffer(this.sparkCol, 6, 1);
    this.sparkPosBuf.setUsage(THREE.DynamicDrawUsage);
    this.sparkColBuf.setUsage(THREE.DynamicDrawUsage);
    this.sparkGeo.setAttribute('instanceStart', new THREE.InterleavedBufferAttribute(this.sparkPosBuf, 3, 0));
    this.sparkGeo.setAttribute('instanceEnd', new THREE.InterleavedBufferAttribute(this.sparkPosBuf, 3, 3));
    this.sparkGeo.setAttribute('instanceColorStart', new THREE.InterleavedBufferAttribute(this.sparkColBuf, 3, 0));
    this.sparkGeo.setAttribute('instanceColorEnd', new THREE.InterleavedBufferAttribute(this.sparkColBuf, 3, 3));
    this.sparkGeo.instanceCount = 0;
    this.sparkMat = new LineMaterial({
      vertexColors: true, linewidth: opts.sparkWidth ?? 2, worldUnits: false, transparent: true, depthWrite: false,
      depthTest: !overlay, blending: THREE.AdditiveBlending,
    });
    this.sparkLines = new LineSegments2(this.sparkGeo, this.sparkMat);
    this.sparkLines.frustumCulled = false;
    this.sparkLines.renderOrder = order + 1;
    for (let i = 0; i < MAX_SPARKS; i++) {
      this.sparks.push({
        p: new THREE.Vector3(), v: new THREE.Vector3(), g: new THREE.Vector3(), age: 0, life: 1, streak: 0.05, drag: 0,
        hot: new THREE.Color(), cool: new THREE.Color(), glow: false, alive: false,
      });
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.glowPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('color', new THREE.BufferAttribute(this.glowCol, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setDrawRange(0, 0);
    this.glowPoints = new THREE.Points(pg, new THREE.PointsMaterial({
      size: opts.glowSize ?? 7, sizeAttenuation: false, map: this.tex, vertexColors: true, transparent: true, depthWrite: false,
      depthTest: !overlay, blending: THREE.AdditiveBlending,
    }));
    this.glowPoints.frustumCulled = false;
    this.glowPoints.renderOrder = order + 2;

    // Sprites: flash / smoke / glow.
    for (let i = 0; i < MAX_SPRITES; i++) {
      const mat = new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthWrite: false, depthTest: !overlay, opacity: 0 });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.frustumCulled = false;
      sprite.renderOrder = order + 3;
      this.group.add(sprite);
      this.puffs.push({
        sprite, mat, p: sprite.position, v: new THREE.Vector3(), g: new THREE.Vector3(), age: 0, life: 1, size0: 1, size1: 1, opacity: 1, drag: 0, kind: 'puff', alive: false,
      });
    }
    this.group.add(this.shardMesh, this.sparkLines, this.glowPoints);
  }

  setResolution(w: number, h: number): void {
    this.sparkMat.resolution.set(w, h);
  }

  /** Re-seed the random stream (deterministic look per failure). */
  seed(s: number): void {
    this.rand = rng(s);
  }

  random(): number {
    return this.rand();
  }

  /** True while anything is visible. */
  get active(): boolean {
    return this.alive > 0;
  }

  /** Global glow of all shards (hot fragments), decaying with time constant `decay` (s). */
  setShardHeat(color: THREE.ColorRepresentation, intensity: number, decay: number): void {
    this.heatColor.set(color);
    this.heat.intensity = intensity;
    this.heat.decay = Math.max(1e-3, decay);
    this.applyHeat();
  }

  /** Emissive glow (lit shards) or a tint towards the heat colour (unlit shards). */
  private applyHeat(): void {
    const m = this.shardMat, i = this.heat.intensity;
    if (m instanceof THREE.MeshStandardMaterial) {
      m.emissive.copy(this.heatColor);
      m.emissiveIntensity = i;
    } else m.color.setRGB(1, 1, 1).lerp(this.heatColor, Math.min(1, i / 1.6));
  }

  clear(): void {
    for (const s of this.shards) s.alive = false;
    for (const s of this.sparks) s.alive = false;
    for (const p of this.puffs) {
      p.alive = false;
      p.sprite.visible = false;
    }
    this.nShard = 0;
    this.sparkHead = 0;
    this.sparkHigh = 0;
    this.shardMesh.count = 0;
    this.sparkGeo.instanceCount = 0;
    this.glowPoints.geometry.setDrawRange(0, 0);
    this.heat.intensity = 0;
    this.applyHeat();
    this.alive = 0;
  }

  // ------------------------------------------------------------------ spawning
  private randomInBall(r: number, out: THREE.Vector3): THREE.Vector3 {
    const rnd = this.rand;
    const u = rnd() * 2 - 1, phi = rnd() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const k = r * Math.cbrt(rnd());
    return out.set(s * Math.cos(phi) * k, s * Math.sin(phi) * k, u * k);
  }

  private randomInCone(dir: THREE.Vector3, angle: number, speed: number, out: THREE.Vector3): THREE.Vector3 {
    const rnd = this.rand;
    const cosA = Math.cos(angle);
    const c = cosA + (1 - cosA) * rnd();
    const s = Math.sqrt(Math.max(0, 1 - c * c));
    const phi = rnd() * Math.PI * 2;
    _d.copy(dir).normalize();
    _b1.set(Math.abs(_d.x) < 0.9 ? 1 : 0, Math.abs(_d.x) < 0.9 ? 0 : 1, 0).cross(_d).normalize();
    _b2.crossVectors(_d, _b1);
    const k = speed * (0.35 + 0.65 * rnd());
    return out.copy(_d).multiplyScalar(c * k).addScaledVector(_b1, s * Math.cos(phi) * k).addScaledVector(_b2, s * Math.sin(phi) * k);
  }

  spawnShards(o: ShardSpawn): void {
    const rnd = this.rand;
    const colors = Array.isArray(o.color) ? o.color : [o.color];
    for (let i = 0; i < o.count; i++) {
      if (this.nShard >= MAX_SHARDS) break;
      const idx = this.nShard++;
      const s = this.shards[idx];
      if (o.to) s.p.lerpVectors(o.at, o.to, (i + rnd()) / o.count);
      else s.p.copy(o.at);
      if (o.spread) s.p.add(this.randomInBall(o.spread, _t));
      s.v.set(0, 0, 0);
      if (!o.still) {
        if (o.velAt) o.velAt(s.p, s.v);
        else if (o.vel) s.v.copy(o.vel);
        if (o.speed) s.v.add(this.randomInBall(o.speed, _t));
        if (o.cone) s.v.add(this.randomInCone(o.cone.dir, o.cone.angle, o.cone.speed, _t));
      }
      s.g.copy(o.gravity ?? ZERO);
      const sz = o.size * (1 + (o.sizeVar ?? 0.45) * (rnd() * 2 - 1));
      s.scale.set(sz * (0.7 + 0.6 * rnd()), sz * (0.7 + 0.6 * rnd()), sz * (0.7 + 0.6 * rnd()));
      s.r = sz * 0.45;
      this.randomInBall(1, s.axis);
      if (s.axis.lengthSq() < 1e-6) s.axis.set(0, 0, 1);
      s.axis.normalize();
      s.angle = rnd() * Math.PI * 2;
      s.spin = o.still ? 0 : (o.spin ?? 6) * (0.3 + 0.7 * rnd()) * (rnd() < 0.5 ? -1 : 1);
      s.age = 0;
      s.life = o.life ?? Infinity;
      s.fade = Math.max(1e-3, o.fade ?? 0.6);
      s.drag = o.drag ?? 0;
      s.collide = !!o.collide;
      s.rest = !!o.still;
      s.sparkSpeed = o.sparkSpeed ?? 0;
      s.alive = true;
      _c.set(colors[i % colors.length]);
      const j = 0.85 + 0.3 * rnd();
      _c.setRGB(Math.min(1, _c.r * j), Math.min(1, _c.g * j), Math.min(1, _c.b * j));
      this.shardMesh.setColorAt(idx, _c);
      this.alive++;
    }
    if (this.shardMesh.instanceColor) this.shardMesh.instanceColor.needsUpdate = true;
    this.shardMesh.count = this.nShard;
  }

  private nextSpark(): Spark {
    const s = this.sparks[this.sparkHead];
    if (!s.alive) this.alive++;
    this.sparkHead = (this.sparkHead + 1) % MAX_SPARKS;
    this.sparkHigh = Math.max(this.sparkHigh, this.sparkHead === 0 ? MAX_SPARKS : this.sparkHead);
    return s;
  }

  spawnSparks(o: SparkSpawn): void {
    const rnd = this.rand;
    const hot = _c.set(o.hot ?? '#fff1c4');
    const hr = hot.r, hg = hot.g, hb = hot.b;
    _c.set(o.cool ?? '#ff6a1a');
    const cr = _c.r, cg = _c.g, cb = _c.b;
    for (let i = 0; i < o.count; i++) {
      const s = this.nextSpark();
      s.p.copy(o.at);
      if (o.spread) s.p.add(this.randomInBall(o.spread, _t));
      s.v.set(0, 0, 0);
      if (o.vel) s.v.copy(o.vel);
      if (o.speed) s.v.add(this.randomInBall(o.speed, _t));
      if (o.cone) s.v.add(this.randomInCone(o.cone.dir, o.cone.angle, o.cone.speed, _t));
      s.g.copy(o.gravity ?? ZERO);
      s.age = 0;
      s.life = Math.max(0.05, o.life * (1 + (o.lifeVar ?? 0.4) * (rnd() * 2 - 1)));
      s.streak = o.streak ?? 0.05;
      s.drag = o.drag ?? 0;
      s.hot.setRGB(hr, hg, hb);
      s.cool.setRGB(cr, cg, cb);
      s.glow = rnd() < (o.glow ?? 0);
      s.alive = true;
    }
  }

  spawnSprite(o: SpriteSpawn): void {
    const p = this.puffs.find((q) => !q.alive);
    if (!p) return;
    p.alive = true;
    this.alive++;
    p.kind = o.kind ?? 'puff';
    p.p.copy(o.at);
    p.v.copy(o.vel ?? ZERO);
    p.g.copy(o.gravity ?? ZERO);
    p.age = -(o.delay ?? 0);
    p.life = o.life;
    p.size0 = o.size;
    p.size1 = o.size1 ?? o.size;
    p.opacity = o.opacity ?? 1;
    p.drag = o.drag ?? 0;
    p.mat.color.set(o.color);
    p.mat.blending = p.kind === 'puff' ? THREE.NormalBlending : THREE.AdditiveBlending;
    p.mat.opacity = 0;
    p.sprite.visible = false;
  }

  // ------------------------------------------------------------------ simulation
  /** Advance by dt seconds (sub-stepped) and upload the buffers. */
  update(dt: number): void {
    if (this.alive <= 0) return;
    const steps = Math.min(16, Math.max(1, Math.ceil(dt / (1 / 60))));
    const h = dt / steps;
    for (let k = 0; k < steps; k++) this.step(h);
    if (this.heat.intensity > 0) {
      this.heat.intensity *= Math.exp(-dt / this.heat.decay);
      if (this.heat.intensity < 0.01) this.heat.intensity = 0;
      this.applyHeat();
    }
    this.write();
  }

  private step(h: number): void {
    const rnd = this.rand;
    for (let i = 0; i < this.nShard; i++) {
      const s = this.shards[i];
      if (!s.alive) continue;
      s.age += h;
      if (s.age > s.life) {
        s.alive = false;
        this.alive--;
        continue;
      }
      if (s.rest) continue;
      s.v.addScaledVector(s.g, h);
      if (s.drag) s.v.multiplyScalar(Math.exp(-s.drag * h));
      s.p.addScaledVector(s.v, h);
      s.angle += s.spin * h;
      if (s.collide && this.collider && this.collider.resolve(s.p, s.r, _n)) {
        const vn = s.v.dot(_n);
        if (vn > 0) {
          _t.copy(s.v).addScaledVector(_n, -vn);
          const vt = _t.length();
          const jn = (1 + RESTITUTION) * vn;
          s.v.addScaledVector(_n, -jn);
          if (vt > 1e-9) s.v.addScaledVector(_t, -Math.min(vt, FRICTION * jn) / vt);
          s.spin *= 0.92;
          if (s.sparkSpeed > 0 && vt > s.sparkSpeed && rnd() < SKID_SPARK_RATE * h * Math.min(1, vt / (3 * s.sparkSpeed))) {
            this.skidSpark(s, _n, _t, vt);
          }
        }
        s.v.multiplyScalar(Math.max(0, 1 - 1.2 * h));
        // Static friction only holds near the bottom of a curved floor (shallow slope).
        if (_n.y < -0.9 && s.v.lengthSq() < this.restSpeed * this.restSpeed) {
          s.rest = true;
          s.v.set(0, 0, 0);
          s.spin = 0;
        }
      }
    }
    for (let i = 0; i < this.sparkHigh; i++) {
      const s = this.sparks[i];
      if (!s.alive) continue;
      s.age += h;
      if (s.age > s.life) {
        s.alive = false;
        this.alive--;
        continue;
      }
      s.v.addScaledVector(s.g, h);
      if (s.drag) s.v.multiplyScalar(Math.exp(-s.drag * h));
      s.p.addScaledVector(s.v, h);
    }
    for (const p of this.puffs) {
      if (!p.alive) continue;
      p.age += h;
      if (p.age > p.life) {
        p.alive = false;
        p.sprite.visible = false;
        this.alive--;
        continue;
      }
      if (p.age < 0) continue;
      p.v.addScaledVector(p.g, h);
      if (p.drag) p.v.multiplyScalar(Math.exp(-p.drag * h));
      p.p.addScaledVector(p.v, h);
    }
  }

  /** A spark thrown off a fragment skidding along the collider (contact point, along the slide). */
  private skidSpark(s: Shard, n: THREE.Vector3, tang: THREE.Vector3, vt: number): void {
    const rnd = this.rand;
    const sp = this.nextSpark();
    sp.p.copy(s.p).addScaledVector(n, s.r);
    sp.v.copy(tang).multiplyScalar(0.6 + 0.5 * rnd());
    sp.v.addScaledVector(n, -vt * (0.05 + 0.25 * rnd()));
    sp.v.add(this.randomInBall(vt * 0.18, _d));
    sp.g.copy(s.g);
    sp.age = 0;
    sp.life = 0.25 + 0.4 * rnd();
    sp.streak = 0.06;
    sp.drag = 0;
    sp.hot.set('#fff3cf');
    sp.cool.set('#ff5a14');
    sp.glow = rnd() < 0.3;
    sp.alive = true;
  }

  private write(): void {
    for (let i = 0; i < this.nShard; i++) {
      const s = this.shards[i];
      let k = 0;
      if (s.alive) k = Number.isFinite(s.life) ? Math.min(1, (s.life - s.age) / s.fade) : 1;
      _q.setFromAxisAngle(s.axis, s.angle);
      _s.copy(s.scale).multiplyScalar(Math.max(k, 0));
      _m.compose(s.p, _q, _s);
      this.shardMesh.setMatrixAt(i, _m);
    }
    this.shardMesh.instanceMatrix.needsUpdate = true;

    const pos = this.sparkPos, col = this.sparkCol, gp = this.glowPos, gc = this.glowCol;
    for (let i = 0; i < this.sparkHigh; i++) {
      const s = this.sparks[i];
      const o = i * 6, g = i * 3;
      if (!s.alive) {
        pos.fill(0, o, o + 6);
        col.fill(0, o, o + 6);
        gc.fill(0, g, g + 3);
        continue;
      }
      const u = s.age / s.life;
      const k = 1 - u * u;
      const w = 1 - u;
      pos[o] = s.p.x;
      pos[o + 1] = s.p.y;
      pos[o + 2] = s.p.z;
      pos[o + 3] = s.p.x - s.v.x * s.streak;
      pos[o + 4] = s.p.y - s.v.y * s.streak;
      pos[o + 5] = s.p.z - s.v.z * s.streak;
      const hr = (s.cool.r + (s.hot.r - s.cool.r) * w) * k, hg = (s.cool.g + (s.hot.g - s.cool.g) * w) * k, hb = (s.cool.b + (s.hot.b - s.cool.b) * w) * k;
      col[o] = hr;
      col[o + 1] = hg;
      col[o + 2] = hb;
      col[o + 3] = s.cool.r * k * 0.3;
      col[o + 4] = s.cool.g * k * 0.3;
      col[o + 5] = s.cool.b * k * 0.3;
      gp[g] = s.p.x;
      gp[g + 1] = s.p.y;
      gp[g + 2] = s.p.z;
      const gk = s.glow ? 0.9 : 0;
      gc[g] = hr * gk;
      gc[g + 1] = hg * gk;
      gc[g + 2] = hb * gk;
    }
    this.sparkGeo.instanceCount = this.sparkHigh;
    this.sparkPosBuf.needsUpdate = true;
    this.sparkColBuf.needsUpdate = true;
    const pgeo = this.glowPoints.geometry;
    pgeo.setDrawRange(0, this.sparkHigh);
    (pgeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (pgeo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;

    for (const p of this.puffs) {
      if (!p.alive || p.age < 0) {
        p.sprite.visible = false;
        continue;
      }
      p.sprite.visible = true;
      const fin = Number.isFinite(p.life);
      const u = fin ? Math.min(1, p.age / p.life) : 1;
      let a: number, size: number;
      if (!fin) {
        a = p.opacity;
        size = p.size1;
      } else if (p.kind === 'flash') {
        a = p.opacity * (u < 0.08 ? u / 0.08 : Math.pow(1 - (u - 0.08) / 0.92, 2));
        size = p.size0 + (p.size1 - p.size0) * (1 - Math.pow(1 - u, 3));
      } else if (p.kind === 'glow') {
        a = p.opacity * Math.sin(Math.PI * u) ** 1.5;
        size = p.size0 + (p.size1 - p.size0) * u;
      } else {
        a = p.opacity * Math.min(1, p.age / 0.12) * Math.pow(1 - u, 1.5);
        size = p.size0 + (p.size1 - p.size0) * (1 - (1 - u) * (1 - u));
      }
      p.mat.opacity = a;
      p.sprite.scale.set(size, size, 1);
    }
  }

  dispose(): void {
    this.shardMesh.geometry.dispose();
    this.shardMat.dispose();
    this.shardMesh.dispose();
    this.sparkGeo.dispose();
    this.sparkMat.dispose();
    this.glowPoints.geometry.dispose();
    (this.glowPoints.material as THREE.Material).dispose();
    for (const p of this.puffs) p.mat.dispose();
    this.tex.dispose();
    this.group.removeFromParent();
  }
}

// ------------------------------------------------------------------ failure clock

/**
 * Starts an effect on the first frame a failure is seen and times it in wall
 * clock (the simulation clock stops at a failure). Steps are clamped (0.25 s) so
 * a stalled or hidden tab does not skip the whole effect.
 */
export class FailureClock {
  private key = '';
  /** Seconds since the failure was first seen by this view. */
  t = 0;
  kind = '';

  /** 'start' on the first frame of a new failure, 'run' while it persists, 'reset' when it went away. */
  sync(snap: Snapshot | null, dtWall: number): 'none' | 'start' | 'run' | 'reset' {
    const f = snap?.failure;
    const key = f ? `${f.kind}|${f.t}` : '';
    if (key !== this.key) {
      const had = this.key !== '';
      this.key = key;
      this.kind = f ? String(f.kind) : '';
      this.t = 0;
      if (key) return 'start';
      return had ? 'reset' : 'none';
    }
    if (!key) return 'none';
    this.t += FailureClock.step(dtWall);
    return 'run';
  }

  /** Forget the current failure so the next frame restarts it. */
  forget(): void {
    this.key = '';
    this.kind = '';
    this.t = 0;
  }

  /** Clamped step for the effect integrators (slow frames still run in real time; a long stall does not skip the effect). */
  static step(dtWall: number): number {
    return Math.min(Math.max(dtWall, 0), 0.25);
  }
}

/** Seed for a failure's random stream (same failure, same debris). */
export function failureSeed(snap: Snapshot | null): number {
  const f = snap?.failure;
  if (!f) return 1;
  let h = Math.floor(f.t * 1e6) >>> 0;
  for (const ch of String(f.kind)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h || 1;
}

// ------------------------------------------------------------------ recipes (pixel units)

/** Failure kinds that break the vehicle up in flight (fireball + debris). */
export function isBreakup(kind: string): boolean {
  return kind === 'aero-overload' || kind === 'unstable-flight' || kind === 'thermal-envelope' || kind === 'exit-collision';
}

/** Failure kinds that happen on (or to) the machine, not to a free-flying vehicle. */
export function isMachineFailure(kind: string): boolean {
  return kind === 'component-load' || kind === 'structural-limit' || kind === 'bearing-envelope' || kind === 'drive-stall';
}

/** Kinds that need no visual event at the vehicle (nothing breaks). */
export function isQuietFailure(kind: string): boolean {
  return kind === 'propellant-exhausted' || kind === 'numerical' || kind === 'drive-stall';
}

export interface FlightBurstOptions {
  kind: string;
  /** Unit velocity direction of the vehicle (scene axes). */
  velDir: THREE.Vector3;
  /** Unit local-down direction (scene axes). */
  down: THREE.Vector3;
  reduced: boolean;
  /** Overall size multiplier. */
  scale?: number;
}

const _o = new THREE.Vector3();
const _g = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * In-flight breakup at the group origin, in pixel units: a fireball flash,
 * fragments carried forward by the vehicle's momentum and slowed by the air,
 * spark streaks; 'thermal-envelope' burns up into long-lived glowing embers
 * (a meteor-like breakup) instead of a fireball.
 */
export function flightBurst(fx: BurstFx, o: FlightBurstOptions): void {
  const k = o.scale ?? 1;
  _o.set(0, 0, 0);
  const dir = _dir.copy(o.velDir);
  if (dir.lengthSq() < 1e-12) dir.set(1, 0, 0);
  dir.normalize();
  if (o.reduced) {
    // Static scatter of a few fragments ahead along the path; no flash, no motion.
    for (let i = 0; i < 9; i++) {
      const a = 10 + 70 * (i / 8);
      _vb.copy(dir).multiplyScalar(a * k).addScaledVector(o.down, (a * a) / 400 * k);
      fx.spawnShards({ at: _vb, count: 1, spread: 9 * k, size: 4.5 * k, color: ['#c9d1d9', '#8b949e', '#6e7681'], still: true });
    }
    return;
  }
  const thermal = o.kind === 'thermal-envelope';
  _g.copy(o.down).multiplyScalar(thermal ? 26 * k : 45 * k);
  if (thermal) {
    fx.spawnSprite({ at: _o, size: 36 * k, size1: 90 * k, life: 0.7, color: '#ffd9a0', opacity: 0.95, kind: 'flash' });
    fx.spawnSprite({ at: _o, size: 60 * k, size1: 150 * k, life: 1.4, color: '#ff7a2a', opacity: 0.5, kind: 'flash' });
    fx.spawnSparks({
      at: _o, count: 70, vel: _vb.copy(dir).multiplyScalar(120 * k), cone: { dir, angle: 0.5, speed: 90 * k }, speed: 18 * k,
      life: 2.0, lifeVar: 0.45, streak: 0.22, drag: 0.85, gravity: _g, hot: '#fff0b8', cool: '#ff5a00', glow: 0.75,
    });
    fx.spawnShards({
      at: _o, count: 14, vel: _vb.copy(dir).multiplyScalar(90 * k), cone: { dir, angle: 0.6, speed: 60 * k }, size: 4.5 * k,
      color: ['#d0d7de', '#aab3bd'], spin: 7, life: 2.6, fade: 1, drag: 0.7, gravity: _g,
    });
    fx.setShardHeat('#ff7a1a', 1.6, 1.4);
    for (let i = 0; i < 4; i++) {
      fx.spawnSprite({
        at: _o, size: 18 * k, size1: 70 * k, life: 2.4, color: '#4a4f57', opacity: 0.32, kind: 'puff',
        vel: _vb.copy(dir).multiplyScalar((20 + 25 * i) * k), drag: 0.8, delay: 0.1 + i * 0.12,
      });
    }
    return;
  }
  const big = o.kind === 'aero-overload' ? 1 : o.kind === 'exit-collision' ? 0.7 : o.kind === 'unstable-flight' ? 0.8 : 0.6;
  const s = k * big;
  // Fireball: white core and an orange halo.
  fx.spawnSprite({ at: _o, size: 30 * s, size1: 80 * s, life: 0.45, color: '#fff4dc', opacity: 1, kind: 'flash' });
  fx.spawnSprite({ at: _o, size: 60 * s, size1: 160 * s, life: 0.9, color: '#ff8a2a', opacity: 0.75, kind: 'flash' });
  fx.spawnSprite({ at: _o, size: 40 * s, size1: 110 * s, life: 1.2, color: '#ff4d1a', opacity: 0.35, kind: 'flash', delay: 0.05 });
  // Fragments: carried forward by the vehicle's momentum (a fan along the path), slowed by the air, drooping.
  fx.spawnShards({
    at: _o, count: Math.round(40 * big + 8), vel: _vb.copy(dir).multiplyScalar(150 * s), cone: { dir, angle: 0.6, speed: 70 * s }, speed: 40 * s,
    size: 4.8 * k, color: ['#d0d7de', '#aab3bd', '#8b949e', '#30363d'], spin: 9, life: 2.8, fade: 0.9, drag: 1.5, gravity: _g,
  });
  fx.spawnSparks({
    at: _o, count: Math.round(60 * big + 10), vel: _vb.copy(dir).multiplyScalar(160 * s), cone: { dir, angle: 0.75, speed: 120 * s }, speed: 45 * s,
    life: 0.85, lifeVar: 0.5, streak: 0.1, drag: 1.8, gravity: _g, hot: '#fff1c4', cool: '#ff6a1a', glow: 0.35,
  });
  // Smoke of the breakup, drifting along the path.
  for (let i = 0; i < 5; i++) {
    fx.spawnSprite({
      at: _o, size: 20 * s, size1: (80 + 14 * i) * s, life: 2.8, color: i % 2 ? '#3d4249' : '#545a62', opacity: 0.4, kind: 'puff',
      vel: _vb.copy(dir).multiplyScalar((15 + 22 * i) * s).addScaledVector(o.down, 6 * s), drag: 0.7, delay: 0.08 + 0.05 * i,
    });
  }
}

/** Dust raised by a ground impact at the group origin (pixel units); `up` is the local vertical. */
export function dustPuff(fx: BurstFx, up: THREE.Vector3, reduced: boolean, scale = 1): void {
  const k = scale;
  _o.set(0, 0, 0);
  if (reduced) {
    fx.spawnSprite({ at: _vb.copy(up).multiplyScalar(12 * k), size: 80 * k, life: Infinity, color: '#b09a7a', opacity: 0.5, kind: 'puff' });
    fx.spawnSprite({ at: _vb.copy(up).multiplyScalar(28 * k), size: 56 * k, life: Infinity, color: '#cbb898', opacity: 0.4, kind: 'puff' });
    return;
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + fx.random() * 0.5;
    // Horizontal direction perpendicular to `up`.
    _d.set(Math.cos(a), 0, Math.sin(a));
    _d.addScaledVector(up, -_d.dot(up)).normalize();
    fx.spawnSprite({
      at: _vb.copy(up).multiplyScalar(4 * k), size: 20 * k, size1: (75 + 50 * fx.random()) * k, life: 2.8 + 0.6 * fx.random(),
      color: i % 3 ? '#b09a7a' : '#cbb898', opacity: 0.8, kind: 'puff',
      vel: _g.copy(_d).multiplyScalar((40 + 30 * fx.random()) * k).addScaledVector(up, (25 + 50 * fx.random()) * k), drag: 1.6,
      delay: 0.03 * i,
    });
  }
  fx.spawnShards({
    at: _o, count: 12, cone: { dir: up, angle: 0.9, speed: 120 * k }, size: 3.5 * k, color: ['#5b4d3c', '#3b3128', '#6e6250'],
    spin: 8, life: 1.6, fade: 0.4, drag: 0.8, gravity: _g.copy(up).multiplyScalar(-160 * k),
  });
}

// ------------------------------------------------------------------ breakup at a vehicle marker

export interface BreakupStart {
  /** Vehicle position in the caller's physical frame (kept as the effect anchor). */
  anchor: [number, number, number];
  /** Unit velocity direction and local down (scene axes). */
  velDir: THREE.Vector3;
  down: THREE.Vector3;
}

/**
 * In-flight failure shown at a (magnified) vehicle marker in the world and
 * orbit views: a breakup or dust puff in screen-pixel units, preceded by a
 * short tumble (unstable flight) or a white-hot glow (burn-up). Failures of
 * the machine or without a physical event at the vehicle show nothing here.
 */
export class BreakupFx {
  readonly fx: BurstFx;
  private readonly clock = new FailureClock();
  /** Anchor of the effect in the caller's frame while one is showing. */
  anchor: [number, number, number] | null = null;
  /** The vehicle marker should be hidden (destroyed). */
  vehicleGone = false;
  /** Extra tumble (rad, about the body z axis) before an unstable-flight breakup. */
  tumble = 0;
  /** Nose temperature override (K) while burning up, else null. */
  heat: number | null = null;
  private tumbling = false;
  private heatUntil = 0;
  private pending: Array<{ at: number; run: () => void }> = [];

  constructor(opts: BurstFxOptions = {}) {
    this.fx = new BurstFx({ overlay: true, ...opts });
  }

  get group(): THREE.Group {
    return this.fx.group;
  }

  reset(): void {
    this.fx.clear();
    this.anchor = null;
    this.vehicleGone = false;
    this.tumble = 0;
    this.heat = null;
    this.tumbling = false;
    this.heatUntil = 0;
    this.pending = [];
  }

  /**
   * Per frame. `start` is asked for the vehicle state only on the first frame
   * a failure is seen; it returns null when there is no free vehicle.
   */
  update(snap: Snapshot | null, dtWall: number, reduced: boolean, start: () => BreakupStart | null): void {
    const st = this.clock.sync(snap, dtWall);
    if (st === 'start' || st === 'reset') this.reset();
    if (st === 'start' && snap?.failure) this.begin(String(snap.failure.kind), reduced, start, failureSeed(snap));
    if (!this.anchor) return;
    const t = this.clock.t;
    if (this.pending.length) {
      const due = this.pending.filter((p) => p.at <= t);
      if (due.length) {
        this.pending = this.pending.filter((p) => p.at > t);
        for (const p of due) p.run();
      }
    }
    this.tumble = this.tumbling && !this.vehicleGone ? 15 * t * t : 0;
    this.heat = t < this.heatUntil ? 1300 + 1700 * (t / this.heatUntil) : null;
    this.fx.update(FailureClock.step(dtWall));
  }

  private begin(kind: string, reduced: boolean, start: () => BreakupStart | null, seed: number): void {
    if (isMachineFailure(kind) || isQuietFailure(kind)) return;
    const s = start();
    if (!s) return;
    this.anchor = [...s.anchor];
    this.fx.seed(seed);
    const velDir = s.velDir.clone(), down = s.down.clone();
    const burst = (): void => {
      this.vehicleGone = true;
      if (kind === 'ground-contact') dustPuff(this.fx, down.clone().multiplyScalar(-1), reduced);
      else flightBurst(this.fx, { kind, velDir, down, reduced });
    };
    if (reduced) burst();
    else if (kind === 'unstable-flight') {
      this.tumbling = true;
      this.pending.push({ at: 0.5, run: burst });
    } else if (kind === 'thermal-envelope') {
      this.heatUntil = 0.4;
      this.pending.push({ at: 0.4, run: burst });
    } else burst();
  }

  /** Scale the group (already positioned) so one unit is about one screen pixel there. */
  scaleToPixels(camera: THREE.PerspectiveCamera, heightPx: number, k = 1): void {
    const d = Math.max(camera.position.distanceTo(this.fx.group.position), 1e-9);
    const ppu = heightPx / 2 / (d * Math.tan((camera.fov * Math.PI) / 360));
    this.fx.group.scale.setScalar((k * Math.min(1.3, Math.max(0.7, heightPx / 720))) / Math.max(ppu, 1e-12));
  }

  setResolution(w: number, h: number): void {
    this.fx.setResolution(w, h);
  }

  dispose(): void {
    this.fx.dispose();
  }
}
