/**
 * Worker-side orchestration, written as plain classes so it can be tested
 * headlessly without a Worker. The worker entry (simulation.worker.ts) only
 * wires these to postMessage.
 */
import { buildScenario, ConfigError, type BuildIssue } from '../sim/build';
import { Session, type SimEvent, type TimedCommand } from '../sim/session';
import type { SimConfig } from '../sim/config';
import type { FromWorker, PlaybackMode, PlaybackState, TelemetryBatch, ToWorker } from './protocol';
import { PREDICTION_CHANNELS } from './protocol';
import type { TelemetryTable } from '../sim/telemetry';

export type Post = (msg: FromWorker, transfer?: Transferable[]) => void;
export type Clock = () => number;
export type Defer = (fn: () => void, ms: number) => unknown;

const SNAPSHOT_INTERVAL_MS = 33; // ~30 Hz display telemetry
const TELEMETRY_INTERVAL_MS = 120;
const TICK_MS = 16;
const COMPUTE_BUDGET_MS = 10;

function batchOf(table: TelemetryTable, name: 'rotor' | 'flight', from: number, channels?: readonly string[]): TelemetryBatch {
  const all = table.slice(from);
  if (!channels) return { table: name, from, channels: table.channels, columns: all };
  const idx = channels.map((c) => table.index[c]);
  return { table: name, from, channels, columns: idx.map((i) => all[i]) };
}

/** Presentation-only time compression; never changes the physics. */
export function autoRate(s: Session): number {
  const d = s.s.derived;
  switch (s.phase) {
    case 'pumpdown':
      return Math.max(1, d.pump.time / 2.5);
    case 'spinup':
      return Math.max(1, (Number.isFinite(d.spinupTimeEstimate) ? d.spinupTimeEstimate : 600) / 5);
    case 'hold':
      // Manual training: slow enough to aim at the release window; the physical clock is unchanged.
      return s.s.config.launcher.release.mode === 'manual-training' ? 0.002 : 0.1;
    case 'corridor':
      return 0.004;
    case 'flight': {
      const fl = s.flight!;
      const t0 = s.releaseRecord?.t ?? s.t;
      if (s.t - t0 < 1.5) return 0.25;
      if (fl.discrete.engineOn) return 12;
      if (s.orbitInsertion) return 240;
      return 8;
    }
    default:
      return 1;
  }
}

export class LiveRun {
  readonly session: Session;
  private playing = false;
  private mode: PlaybackMode = { auto: true };
  private display = 0;
  private lastWall: number;
  private lastSnap = -Infinity;
  private lastTele = -Infinity;
  private sentRotor = 0;
  private sentFlight = 0;
  private sentEvents = 0;
  private finished = false;
  private computeLimited = false;
  private stopped = false;
  private timer: unknown = null;

  constructor(
    readonly runId: number,
    readonly configVersion: number,
    readonly config: SimConfig,
    commands: TimedCommand[],
    private post: Post,
    private now: Clock,
    private defer: Defer,
  ) {
    const sc = buildScenario(config);
    if (!sc.ok) throw new ConfigError(sc.issues);
    this.session = new Session(sc, commands);
    this.lastWall = now();
    post({ type: 'ready', runId, configVersion, issues: sc.issues, derived: sc.derived });
    this.publish(true);
  }

  setPlayback(playing: boolean, mode: PlaybackMode): void {
    this.playing = playing;
    this.mode = mode;
    this.lastWall = this.now();
    if (playing) this.schedule();
    this.publish(true);
  }

  command(kind: TimedCommand['kind']): void {
    this.session.command(kind);
    // Apply promptly even while paused.
    this.session.advanceTo(this.session.t, COMPUTE_BUDGET_MS, this.now);
    this.publish(true);
    if (!this.playing) this.schedule();
  }

  skipTo(target: 'release' | 'end'): void {
    const s = this.session;
    if (target === 'release') {
      const t0 = performanceSafe(this.now);
      while (!s.ended && !s.releaseRecord && this.now() - t0 < 5000) s.advanceTo(s.t + 30, 50, this.now);
      this.display = s.releaseRecord ? s.releaseRecord.t - 0.05 : s.t;
    } else {
      s.advanceTo(Infinity, 20000, this.now);
      this.display = s.t;
    }
    this.publish(true);
  }

  stop(): void {
    this.stopped = true;
  }

  private schedule(): void {
    if (this.timer !== null || this.stopped) return;
    this.timer = this.defer(() => {
      this.timer = null;
      this.tick();
    }, TICK_MS);
  }

  currentRate(): number {
    return this.mode.auto ? autoRate(this.session) : this.mode.rate;
  }

  tick(): void {
    if (this.stopped) return;
    const wall = this.now();
    const dt = Math.min(0.25, (wall - this.lastWall) / 1000);
    this.lastWall = wall;
    const s = this.session;
    if (this.playing) {
      const target = this.display + this.currentRate() * dt;
      s.advanceTo(target, COMPUTE_BUDGET_MS, this.now);
      this.computeLimited = !s.ended && s.t < target;
      this.display = Math.min(target, s.t);
      if (s.ended && this.display >= s.t) {
        this.display = s.t;
        this.playing = false;
      }
    }
    this.publish(false);
    if (this.playing || (s.ended && !this.finished)) this.schedule();
  }

  playbackState(): PlaybackState {
    return { playing: this.playing, auto: this.mode.auto, rate: this.currentRate(), computeLimited: this.computeLimited };
  }

  private publish(force: boolean): void {
    const wall = this.now();
    const s = this.session;
    if (force || wall - this.lastSnap >= SNAPSHOT_INTERVAL_MS) {
      this.lastSnap = wall;
      this.post({ type: 'snapshot', runId: this.runId, configVersion: this.configVersion, snapshot: s.snapshotAt(this.display), playback: this.playbackState(), frontier: s.t });
    }
    if (force || wall - this.lastTele >= TELEMETRY_INTERVAL_MS || s.ended) {
      this.lastTele = wall;
      if (s.rotorTable.length > this.sentRotor) {
        const b = batchOf(s.rotorTable, 'rotor', this.sentRotor);
        this.sentRotor = s.rotorTable.length;
        this.post({ type: 'telemetry', runId: this.runId, batch: b }, b.columns.map((c) => c.buffer));
      }
      if (s.flightTable.length > this.sentFlight) {
        const b = batchOf(s.flightTable, 'flight', this.sentFlight);
        this.sentFlight = s.flightTable.length;
        this.post({ type: 'telemetry', runId: this.runId, batch: b }, b.columns.map((c) => c.buffer));
      }
      // Events are released when the DISPLAY reaches them (the solver frontier may be ahead).
      let n = this.sentEvents;
      while (n < s.events.length && (s.events[n].t <= this.display + 1e-9 || (s.ended && this.display >= s.t))) n++;
      if (n > this.sentEvents) {
        const ev: SimEvent[] = s.events.slice(this.sentEvents, n);
        this.post({ type: 'events', runId: this.runId, from: this.sentEvents, events: ev });
        this.sentEvents = n;
      }
    }
    if (s.ended && !this.finished && this.display >= s.t) {
      this.finished = true;
      this.post({ type: 'finished', runId: this.runId, configVersion: this.configVersion, summary: s.summary(), commandLog: s.commandLog });
    }
  }
}

function performanceSafe(now: Clock): number {
  return now();
}

/** Cooperative prediction/batch runner: works in slices so cancel messages get through. */
export class JobRunner {
  private cancelled = new Set<number>();
  constructor(
    private post: Post,
    private now: Clock,
    private defer: Defer,
  ) {}

  cancel(jobId: number): void {
    this.cancelled.add(jobId);
  }

  predict(jobId: number, configVersion: number, config: SimConfig): void {
    const t0 = this.now();
    let session: Session;
    let issues: BuildIssue[] = [];
    try {
      const sc = buildScenario(config);
      issues = sc.issues;
      if (!sc.ok) {
        this.post({ type: 'prediction-failed', jobId, configVersion, issues, message: 'Configuration has errors.' });
        return;
      }
      session = new Session(sc);
    } catch (e) {
      const iss = e instanceof ConfigError ? e.issues : [{ level: 'error' as const, message: String(e) }];
      this.post({ type: 'prediction-failed', jobId, configVersion, issues: iss, message: String(e) });
      return;
    }
    const slice = (): void => {
      if (this.cancelled.has(jobId)) {
        this.cancelled.delete(jobId);
        this.post({ type: 'cancelled', jobId });
        return;
      }
      session.advanceTo(Infinity, 25, this.now);
      if (!session.ended) {
        this.post({ type: 'progress', jobId, configVersion, fraction: NaN, label: session.phase, phase: session.phase });
        this.defer(slice, 0);
        return;
      }
      const flight = batchOf(session.flightTable, 'flight', 0, PREDICTION_CHANNELS);
      const rotor = batchOf(session.rotorTable, 'rotor', 0);
      this.post(
        { type: 'prediction', jobId, configVersion, summary: session.summary(), events: session.events, flight, rotor, issues, wallMs: this.now() - t0 },
        [...flight.columns.map((c) => c.buffer), ...rotor.columns.map((c) => c.buffer)],
      );
    };
    // Defer the first slice so a cancel that arrives right behind this job wins.
    this.defer(slice, 0);
  }

  batch(jobId: number, configVersion: number, label: string, configs: SimConfig[], tags: unknown[]): void {
    const t0 = this.now();
    const results: Array<{ tag: unknown; summary?: ReturnType<Session['summary']>; error?: string }> = [];
    let i = 0;
    let current: Session | null = null;
    const slice = (): void => {
      if (this.cancelled.has(jobId)) {
        this.cancelled.delete(jobId);
        this.post({ type: 'cancelled', jobId });
        return;
      }
      const sliceStart = this.now();
      while (i < configs.length && this.now() - sliceStart < 30) {
        if (!current) {
          try {
            const sc = buildScenario(configs[i]);
            if (!sc.ok) {
              results.push({ tag: tags[i], error: sc.issues.filter((x) => x.level === 'error').map((x) => x.message).join(' ') });
              i++;
              continue;
            }
            current = new Session(sc);
          } catch (e) {
            results.push({ tag: tags[i], error: e instanceof ConfigError ? e.message : String(e) });
            i++;
            continue;
          }
        }
        current.advanceTo(Infinity, 25, this.now);
        if (current.ended) {
          results.push({ tag: tags[i], summary: current.summary() });
          current = null;
          i++;
        }
      }
      this.post({ type: 'progress', jobId, configVersion, fraction: i / configs.length, label: `${label}: ${i}/${configs.length}` });
      if (i < configs.length) this.defer(slice, 0);
      else this.post({ type: 'batch-result', jobId, configVersion, label, results, wallMs: this.now() - t0 });
    };
    this.defer(slice, 0);
  }
}

/** Message router used by the worker entry and by tests. */
export class WorkerHost {
  private run: LiveRun | null = null;
  private jobs: JobRunner;
  constructor(
    private post: Post,
    private now: Clock,
    private defer: Defer,
  ) {
    this.jobs = new JobRunner(post, now, defer);
  }

  handle(msg: ToWorker): void {
    try {
      switch (msg.type) {
        case 'init':
          this.run?.stop();
          this.run = null;
          try {
            this.run = new LiveRun(msg.runId, msg.configVersion, msg.config, msg.commands ?? [], this.post, this.now, this.defer);
          } catch (e) {
            const issues = e instanceof ConfigError ? e.issues : [{ level: 'error' as const, message: String(e) }];
            this.post({ type: 'rejected', runId: msg.runId, configVersion: msg.configVersion, issues, message: String(e) });
          }
          return;
        case 'playback':
          if (this.run && this.run.runId === msg.runId) this.run.setPlayback(msg.playing, msg.mode);
          return;
        case 'command':
          if (this.run && this.run.runId === msg.runId) this.run.command(msg.kind);
          return;
        case 'skip-to':
          if (this.run && this.run.runId === msg.runId) this.run.skipTo(msg.phase);
          return;
        case 'stop':
          if (this.run && this.run.runId === msg.runId) {
            this.run.stop();
            this.run = null;
          }
          return;
        case 'predict':
          this.jobs.predict(msg.jobId, msg.configVersion, msg.config);
          return;
        case 'batch':
          this.jobs.batch(msg.jobId, msg.configVersion, msg.label, msg.configs, msg.tags);
          return;
        case 'cancel':
          this.jobs.cancel(msg.jobId);
          return;
      }
    } catch (e) {
      this.post({ type: 'error', id: 'runId' in msg ? msg.runId : 'jobId' in msg ? msg.jobId : 0, message: String(e) });
    }
  }
}
