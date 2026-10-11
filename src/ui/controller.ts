/**
 * Main-thread controller: owns the live-simulation worker and the
 * prediction worker, applies typed messages, rejects stale results, and
 * exposes state to React (via Store) and to the renderer (direct reads).
 */
import { Store } from './store';
import type { SimConfig } from '../sim/config';
import { cloneConfig, getPath, setPath } from '../sim/config';
import { buildScenario, ConfigError, type BuildIssue, type Scenario } from '../sim/build';
import type { FromWorker, PlaybackMode, PlaybackState, TelemetryBatch, ToWorker } from '../workers/protocol';
import { LatestJobTracker } from '../workers/protocol';
import type { CommandKind, RunSummary, SimEvent, Snapshot, TimedCommand } from '../sim/session';
import { TelemetryTable, ROTOR_CHANNELS, FLIGHT_CHANNELS } from '../sim/telemetry';
import { PREDICTION_CHANNELS } from '../workers/protocol';
import { designById } from '../data/designs';
import { evaluateWithStars, missionById, recordKey, type MissionResult } from '../game/missions';

export type Tab = 'build' | 'flight' | 'analysis';
export type ViewKind = 'launcher' | 'world' | 'orbit' | 'map';

export interface PredictionState {
  status: 'idle' | 'running' | 'done' | 'failed';
  jobId: number;
  configVersion: number;
  summary?: RunSummary;
  events?: SimEvent[];
  flight?: TelemetryTable;
  rotor?: TelemetryTable;
  issues?: BuildIssue[];
  message?: string;
  wallMs?: number;
  phase?: string;
}

export interface Ghost {
  id: number;
  label: string;
  summary: RunSummary;
  flight: TelemetryTable;
  color: string;
  configName: string;
}

export interface BatchState {
  status: 'idle' | 'running' | 'done' | 'cancelled';
  jobId: number;
  label: string;
  progress: number;
  kind?: 'robustness' | 'frontier' | 'counterfactual' | 'vacuum';
  results?: Array<{ tag: unknown; summary?: RunSummary; error?: string }>;
  wallMs?: number;
}

export type UiMode = 'play' | 'engineer';

export interface AppState {
  uiMode: UiMode;
  /** Play mode: show the mission-select home screen. */
  showHome: boolean;
  /** Play mode: camera follows the action (launcher -> world -> orbit) until the player picks a view. */
  autoCamera: boolean;
  /** Play mode: the full-screen ground-track map is open. */
  mapOpen: boolean;
  /** Missions completed in this browser (any passing run). */
  completed: Record<string, number>;
  config: SimConfig;
  configVersion: number;
  designId: string;
  scenario: Scenario | null;
  buildIssues: BuildIssue[];
  tab: Tab;
  view: ViewKind;
  mode: 'sandbox' | 'missions';
  missionId: string | null;
  prediction: PredictionState;
  run: {
    runId: number;
    status: 'idle' | 'starting' | 'live' | 'finished' | 'rejected';
    playback: PlaybackState;
    summary?: RunSummary;
    missionResult?: MissionResult;
    commandLog: TimedCommand[];
    message?: string;
    config?: SimConfig;
  };
  events: SimEvent[];
  ghosts: Ghost[];
  batch: BatchState;
  cursorTime: number | null;
  inspector: string | null;
  helpOpen: boolean;
  reducedMotion: boolean;
  overlays: { forces: boolean; atmosphere: boolean; predicted: boolean; ghosts: boolean; labels: boolean };
  bottomOpen: boolean;
  plotChannels: string[];
  /** When true the plot set follows the phase (rotor channels before release, flight after). */
  plotAuto: boolean;
  uiTick: number;
  records: Record<string, { score: number; label: string; t: number }>;
}

const GHOST_COLORS = ['#c58cff', '#6fd3c4', '#f0b65a'];
const RECORDS_KEY = 'centrifuge.records.v1';
const UIMODE_KEY = 'centrifuge.uimode.v1';
const COMPLETED_KEY = 'centrifuge.completed.v1';
const CONFIG_KEY = 'centrifuge.config.v1';

function loadJSON<T>(key: string): T | null {
  try {
    const s = localStorage.getItem(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}
function saveJSON(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable: ignore (per-viewer convenience only) */
  }
}

function tableFrom(batch: TelemetryBatch, existing?: TelemetryTable): TelemetryTable {
  const t = existing ?? new TelemetryTable(batch.channels, Math.max(1024, batch.columns[0]?.length ?? 0));
  const n = batch.columns[0]?.length ?? 0;
  const row = new Array<number>(batch.channels.length);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < batch.columns.length; c++) row[c] = batch.columns[c][r];
    t.push(row);
  }
  return t;
}

const FLIGHT_SET = (sc: Scenario | null): string[] =>
  sc && sc.stages.length ? ['alt', 'orbit', 'accel', 'prop'] : ['alt', 'vAir', 'q', 'heatFlux'];

export class Controller {
  readonly store: Store<AppState>;
  private live: Worker | null = null;
  private predictor: Worker | null = null;
  private jobSeq = { n: 0 };
  private predictTracker = new LatestJobTracker(this.jobSeq);
  private batchTracker = new LatestJobTracker(this.jobSeq);
  private predictTimer: ReturnType<typeof setTimeout> | null = null;
  private runCounter = 0;
  private ghostCounter = 0;
  /** High-rate data for the renderer (not React state). */
  snapshot: Snapshot | null = null;
  snapshotWall = 0;
  rotorTable = new TelemetryTable(ROTOR_CHANNELS);
  flightTable = new TelemetryTable(FLIGHT_CHANNELS);
  frontier = 0;
  /** Stars held before the latest passing run (to announce a new best). */
  lastBest: { missionId: string; previous: number } | null = null;
  private uiTimer: ReturnType<typeof setInterval> | null = null;
  private dirtyUi = false;

  constructor(initialDesign = 'instrument-hop') {
    const saved = loadJSON<{ config: SimConfig; designId: string }>(CONFIG_KEY);
    const config = saved?.config && saved.config.modelVersion ? saved.config : designById(initialDesign);
    this.store = new Store<AppState>({
      uiMode: loadJSON<UiMode>(UIMODE_KEY) ?? 'play',
      showHome: true,
      autoCamera: true,
      mapOpen: false,
      completed: loadJSON(COMPLETED_KEY) ?? {},
      config,
      configVersion: 1,
      designId: saved?.designId ?? initialDesign,
      scenario: null,
      buildIssues: [],
      tab: 'build',
      view: 'launcher',
      mode: 'sandbox',
      missionId: null,
      prediction: { status: 'idle', jobId: 0, configVersion: 0 },
      run: { runId: 0, status: 'idle', playback: { playing: false, auto: true, rate: 1, computeLimited: false }, commandLog: [] },
      events: [],
      ghosts: [],
      batch: { status: 'idle', jobId: 0, label: '', progress: 0 },
      cursorTime: null,
      inspector: null,
      helpOpen: false,
      reducedMotion: typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
      overlays: { forces: true, atmosphere: true, predicted: true, ghosts: true, labels: true },
      bottomOpen: true,
      plotChannels: ['alt', 'vAir', 'q', 'heatFlux'],
      plotAuto: true,
      uiTick: 0,
      records: loadJSON(RECORDS_KEY) ?? {},
    });
    this.rebuild();
  }

  // ---------------------------------------------------------------- workers
  start(): void {
    if (this.live) return;
    this.live = new Worker(new URL('../workers/simulation.worker.ts', import.meta.url), { type: 'module' });
    this.predictor = new Worker(new URL('../workers/simulation.worker.ts', import.meta.url), { type: 'module' });
    this.live.onmessage = (e: MessageEvent<FromWorker>) => this.onLive(e.data);
    this.predictor.onmessage = (e: MessageEvent<FromWorker>) => this.onPredict(e.data);
    this.uiTimer = setInterval(() => {
      if (this.dirtyUi) {
        this.dirtyUi = false;
        this.store.set((s) => ({ uiTick: s.uiTick + 1 }));
      }
    }, 100);
    this.schedulePrediction(0);
  }

  dispose(): void {
    this.live?.terminate();
    this.predictor?.terminate();
    this.live = this.predictor = null;
    if (this.uiTimer) clearInterval(this.uiTimer);
    if (this.predictTimer) clearTimeout(this.predictTimer);
  }

  private sendLive(msg: ToWorker): void {
    this.live?.postMessage(msg);
  }
  private sendPredict(msg: ToWorker): void {
    this.predictor?.postMessage(msg);
  }

  // ---------------------------------------------------------------- configuration
  get config(): SimConfig {
    return this.store.get().config;
  }

  private rebuild(): void {
    const c = this.store.get().config;
    try {
      const sc = buildScenario(c);
      this.store.set({ scenario: sc, buildIssues: sc.issues });
    } catch (e) {
      const issues = e instanceof ConfigError ? e.issues : [{ level: 'error' as const, message: String(e) }];
      this.store.set({ scenario: null, buildIssues: issues });
    }
  }

  setConfig(c: SimConfig, designId?: string): void {
    this.store.set((s) => ({ config: c, configVersion: s.configVersion + 1, designId: designId ?? s.designId }));
    saveJSON(CONFIG_KEY, { config: c, designId: designId ?? this.store.get().designId });
    this.rebuild();
    this.schedulePrediction(350);
  }

  setParam(path: string, value: unknown): void {
    const c = cloneConfig(this.config);
    setPath(c, path, value);
    this.setConfig(c);
  }

  getParam(path: string): unknown {
    return getPath(this.config, path);
  }

  loadDesign(id: string): void {
    const c = designById(id);
    this.setConfig(c, id);
  }

  // ---------------------------------------------------------------- prediction
  schedulePrediction(delay: number): void {
    if (this.predictTimer) clearTimeout(this.predictTimer);
    this.predictTimer = setTimeout(() => this.predictNow(), delay);
  }

  predictNow(): void {
    const s = this.store.get();
    const prev = this.predictTracker.current;
    if (prev.jobId) this.sendPredict({ type: 'cancel', jobId: prev.jobId });
    if (!s.scenario || !s.scenario.ok) {
      this.store.set({ prediction: { status: 'failed', jobId: 0, configVersion: s.configVersion, issues: s.buildIssues, message: 'Fix configuration errors to predict.' } });
      return;
    }
    const jobId = this.predictTracker.next(s.configVersion);
    this.store.set({ prediction: { ...s.prediction, status: 'running', jobId, configVersion: s.configVersion } });
    this.sendPredict({ type: 'predict', jobId, configVersion: s.configVersion, config: s.config });
  }

  private onPredict(m: FromWorker): void {
    switch (m.type) {
      case 'progress': {
        if (this.batchTracker.accept(m)) {
          this.store.set((s) => ({ batch: { ...s.batch, progress: m.fraction, label: m.label } }));
        } else if (this.predictTracker.accept(m)) {
          this.store.set((s) => ({ prediction: { ...s.prediction, phase: m.label } }));
        }
        return;
      }
      case 'prediction': {
        if (!this.predictTracker.accept(m)) return; // stale: superseded configuration
        const flight = tableFrom(m.flight);
        const rotor = tableFrom(m.rotor);
        this.store.set({ prediction: { status: 'done', jobId: m.jobId, configVersion: m.configVersion, summary: m.summary, events: m.events, flight, rotor, issues: m.issues, wallMs: m.wallMs } });
        return;
      }
      case 'prediction-failed': {
        if (!this.predictTracker.accept(m)) return;
        this.store.set({ prediction: { status: 'failed', jobId: m.jobId, configVersion: m.configVersion, issues: m.issues, message: m.message } });
        return;
      }
      case 'batch-result': {
        if (!this.batchTracker.accept(m)) return;
        this.store.set((s) => ({ batch: { ...s.batch, status: 'done', progress: 1, results: m.results, wallMs: m.wallMs, label: m.label } }));
        return;
      }
      case 'cancelled':
        if (m.jobId === this.batchTracker.current.jobId) this.store.set((s) => ({ batch: { ...s.batch, status: 'cancelled' } }));
        return;
      default:
        return;
    }
  }

  runBatch(kind: BatchState['kind'], label: string, configs: SimConfig[], tags: unknown[]): void {
    const prev = this.batchTracker.current;
    if (prev.jobId) this.sendPredict({ type: 'cancel', jobId: prev.jobId });
    const v = this.store.get().configVersion;
    const jobId = this.batchTracker.next(v);
    this.store.set({ batch: { status: 'running', jobId, label, progress: 0, kind } });
    this.sendPredict({ type: 'batch', jobId, configVersion: v, label, configs, tags });
  }

  cancelBatch(): void {
    const j = this.batchTracker.current.jobId;
    if (j) this.sendPredict({ type: 'cancel', jobId: j });
  }

  // ---------------------------------------------------------------- live run
  launch(commands: TimedCommand[] = []): void {
    const s = this.store.get();
    if (!s.scenario?.ok) return;
    this.runCounter += 1;
    const runId = this.runCounter;
    this.snapshot = null;
    this.rotorTable = new TelemetryTable(ROTOR_CHANNELS);
    this.flightTable = new TelemetryTable(FLIGHT_CHANNELS);
    this.frontier = 0;
    this.store.set({
      tab: 'flight',
      events: [],
      cursorTime: null,
      run: { runId, status: 'starting', playback: { playing: true, auto: true, rate: 1, computeLimited: false }, commandLog: [], config: cloneConfig(s.config) },
    });
    this.sendLive({ type: 'init', runId, configVersion: s.configVersion, config: s.config, commands });
    this.sendLive({ type: 'playback', runId, playing: true, mode: { auto: true } });
  }

  replay(): void {
    const r = this.store.get().run;
    if (!r.config) return;
    const log = r.commandLog.map((c) => ({ ...c }));
    this.setConfig(cloneConfig(r.config));
    this.launch(log);
  }

  setPlayback(playing: boolean, mode: PlaybackMode): void {
    const r = this.store.get().run;
    this.sendLive({ type: 'playback', runId: r.runId, playing, mode });
  }

  command(kind: CommandKind): void {
    this.sendLive({ type: 'command', runId: this.store.get().run.runId, kind });
  }

  skipTo(phase: 'release' | 'end'): void {
    this.sendLive({ type: 'skip-to', runId: this.store.get().run.runId, phase });
  }

  reset(): void {
    const r = this.store.get().run;
    if (r.runId) this.sendLive({ type: 'stop', runId: r.runId });
    this.snapshot = null;
    this.store.set((s) => ({ run: { ...s.run, status: 'idle', summary: undefined, missionResult: undefined, commandLog: [] }, events: [], tab: 'build', cursorTime: null }));
  }

  private onLive(m: FromWorker): void {
    const r = this.store.get().run;
    if ('runId' in m && m.runId !== r.runId) return; // stale run
    switch (m.type) {
      case 'ready':
        this.store.set((s) => ({ run: { ...s.run, status: 'live' } }));
        return;
      case 'rejected':
        this.store.set((s) => ({ run: { ...s.run, status: 'rejected', message: m.message } }));
        return;
      case 'snapshot':
        if (this.store.get().plotAuto) {
          const pre = m.snapshot.phase === 'pumpdown' || m.snapshot.phase === 'spinup' || m.snapshot.phase === 'hold';
          const want = pre ? ['tip', 'power', 'energy', 'pressure'] : m.snapshot.phase === 'corridor' ? ['clearance', 'alpha', 'vAir', 'q'] : FLIGHT_SET(this.store.get().scenario);
          const cur = this.store.get().plotChannels;
          if (want.join() !== cur.join()) this.store.set({ plotChannels: want });
        }
        this.snapshot = m.snapshot;
        this.snapshotWall = performance.now();
        this.autoView();
        this.frontier = m.frontier;
        if (m.playback.playing !== r.playback.playing || m.playback.rate !== r.playback.rate || m.playback.auto !== r.playback.auto || m.playback.computeLimited !== r.playback.computeLimited) {
          this.store.set((s) => ({ run: { ...s.run, playback: m.playback } }));
        }
        this.dirtyUi = true;
        return;
      case 'telemetry':
        if (m.batch.table === 'rotor') tableFrom(m.batch, this.rotorTable);
        else tableFrom(m.batch, this.flightTable);
        this.dirtyUi = true;
        return;
      case 'events':
        this.store.set((s) => ({ events: [...s.events.slice(0, m.from), ...m.events] }));
        return;
      case 'finished': {
        const s = this.store.get();
        const sc = s.scenario;
        let missionResult: MissionResult | undefined;
        if (s.missionId && sc) {
          const mission = missionById(s.missionId);
          if (mission) missionResult = evaluateWithStars(mission, m.summary, sc);
        }
        this.store.set((st) => ({ run: { ...st.run, status: 'finished', summary: m.summary, commandLog: m.commandLog, missionResult } }));
        if (missionResult?.passed && missionResult.score !== null && r.config) this.recordScore(r.config, missionResult);
        if (missionResult?.passed) {
          const prevStars = this.store.get().completed[missionResult.missionId] ?? 0;
          this.lastBest = { missionId: missionResult.missionId, previous: prevStars };
          const done = { ...this.store.get().completed, [missionResult.missionId]: Math.max(prevStars, missionResult.stars ?? 1) };
          saveJSON(COMPLETED_KEY, done);
          this.store.set({ completed: done });
        }
        this.addGhost(m.summary);
        return;
      }
      default:
        return;
    }
  }

  private recordScore(c: SimConfig, res: MissionResult): void {
    const key = recordKey(c, res.missionId);
    const recs = { ...this.store.get().records };
    const lowerIsBetter = /lower is better/.test(res.scoreLabel);
    const prev = recs[key];
    const better = !prev || (lowerIsBetter ? res.score! < prev.score : res.score! > prev.score);
    if (better) {
      recs[key] = { score: res.score!, label: res.scoreLabel, t: Date.now() };
      saveJSON(RECORDS_KEY, recs);
      this.store.set({ records: recs });
    }
  }

  private addGhost(summary: RunSummary): void {
    if (this.flightTable.length < 2) return;
    const s = this.store.get();
    this.ghostCounter += 1;
    const g: Ghost = {
      id: this.ghostCounter,
      label: `Run ${this.ghostCounter}: ${s.run.config?.name ?? ''}`,
      summary,
      flight: this.flightTable,
      color: GHOST_COLORS[(this.ghostCounter - 1) % GHOST_COLORS.length],
      configName: s.run.config?.name ?? '',
    };
    this.store.set((st) => ({ ghosts: [...st.ghosts, g].slice(-3) }));
  }

  removeGhost(id: number): void {
    this.store.set((s) => ({ ghosts: s.ghosts.filter((g) => g.id !== id) }));
  }

  setUiMode(m: UiMode): void {
    saveJSON(UIMODE_KEY, m);
    // Play mode shows the map as an overlay, not as a camera view.
    const view = m === 'play' && this.store.get().view === 'map' ? 'world' : this.store.get().view;
    this.store.set({ uiMode: m, view, mapOpen: false });
  }

  /** Play mode: pick a mission (or sandbox) and load its tested design. */
  startMission(id: string | null): void {
    const m = id ? missionById(id) : undefined;
    this.store.set({ missionId: id, mode: id ? 'missions' : 'sandbox', showHome: false, view: 'launcher', autoCamera: true });
    if (m) this.loadDesign(m.referenceDesign);
    this.reset();
  }

  /** Play-mode camera direction: launcher until shortly after release, then the world view, then orbit. */
  autoView(): void {
    const st = this.store.get();
    if (!st.autoCamera || !this.snapshot) return;
    const s = this.snapshot;
    let want: ViewKind = 'launcher';
    if (s.vehicle) {
      const sinceRelease = this.flightTable.length ? s.t - this.flightTable.get('t', 0) : 0;
      if (sinceRelease > 2.5) want = 'world';
      if (s.vehicle.altitude > 160_000 && (s.vehicle.orbit.bound || s.vehicle.engineOn || (st.scenario?.stages.length ?? 0) > 0)) want = 'orbit';
    }
    if (want !== st.view) this.store.set({ view: want });
  }

  // ---------------------------------------------------------------- export helpers
  exportTelemetryCSV(which: 'flight' | 'rotor' | 'prediction'): string {
    if (which === 'prediction') return this.store.get().prediction.flight?.toCSV() ?? '';
    return which === 'flight' ? this.flightTable.toCSV() : this.rotorTable.toCSV();
  }
}

export { PREDICTION_CHANNELS };
