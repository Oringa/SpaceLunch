/**
 * Standalone visual harness for the renderer (render-harness.html).
 *
 * Builds a reference design, runs the authoritative Session synchronously to
 * the end, and replays snapshotAt(t) through a RenderSource so each view can
 * be inspected/screenshotted without the game UI.
 *
 * Query parameters:
 *   design = edge-of-space | leo-reference | ...      (default edge-of-space)
 *   view   = launcher | world | orbit                 (default launcher)
 *   t      = seconds after release | spin | early | pump | hold | pre (no run)
 *   play   = simulation seconds per wall second (animates t; 0 = still)
 *   cursor = seconds after release for the time cursor
 *   ghost  = design id to overlay as a ghost trajectory
 *   fallback=1 forces the Canvas2D fallback; reduced=1 reduced motion;
 *   forces/atmo/pred/labels = 0 to switch overlays off; band=1 mission band.
 */
import { designById } from '../data/designs';
import { buildScenario } from '../sim/build';
import { Session, type Phase, type Snapshot } from '../sim/session';
import { TelemetryTable } from '../sim/telemetry';
import { G0 } from '../physics/constants';
import { createRenderer } from './index';
import { Fallback2D } from './fallback2d';
import type { Overlays, Renderer, RenderSource, ViewKind } from './types';

interface HarnessState {
  ready: boolean;
  error: string | null;
  info: Record<string, unknown>;
  renderer?: string;
}
const state: HarnessState = { ready: false, error: null, info: {} };
(window as unknown as { __harness: HarnessState }).__harness = state;
window.addEventListener('error', (e) => {
  state.error = String(e.message);
});

const q = new URLSearchParams(location.search);
const designId = q.get('design') ?? 'edge-of-space';
const viewKind = (q.get('view') ?? 'launcher') as ViewKind;
const tParam = q.get('t') ?? 'spin';
const play = Number(q.get('play') ?? 0);
const overlays: Overlays = {
  forces: q.get('forces') !== '0',
  atmosphere: q.get('atmo') !== '0',
  predicted: q.get('pred') !== '0',
  ghosts: true,
  labels: q.get('labels') !== '0',
};
const reduced = q.get('reduced') === '1';
const band = q.get('band') === '1' || designId.startsWith('leo') ? { periapsisMin: 200_000, apoapsisMax: 1_000_000 } : null;

function run(id: string): Session {
  const sc = buildScenario(designById(id));
  const s = new Session(sc);
  s.runToEnd();
  return s;
}

const t0 = performance.now();
const session = run(designId);
const sum = session.summary();
const tRelease = session.releaseRecord?.t ?? sum.times.end;
const tSpinStart = sum.times.pumpdown;
const tSpinEnd = sum.times.pumpdown + sum.times.spinup;
state.info.runMs = Math.round(performance.now() - t0);
state.info.terminal = sum.terminal;
state.info.tRelease = tRelease;

const ghosts: Array<{ table: TelemetryTable; color: string; label: string }> = [];
const ghostId = q.get('ghost');
if (ghostId) ghosts.push({ table: run(ghostId).flightTable, color: '#c58cff', label: `ghost · ${ghostId}` });

function firstTimeOmegaAbove(w: number): number {
  const rt = session.rotorTable;
  const t = rt.col('t'), om = rt.col('omega');
  for (let i = 0; i < rt.length; i++) if (om[i] >= w) return t[i];
  return tSpinStart;
}

let tDisplay: number | null;
switch (tParam) {
  case 'pre':
    tDisplay = null;
    break;
  case 'pump':
    tDisplay = tSpinStart * 0.5;
    break;
  case 'early':
    tDisplay = firstTimeOmegaAbove(1.2);
    break;
  case 'spin':
    tDisplay = tSpinStart + 0.6 * sum.times.spinup;
    break;
  case 'hold':
    tDisplay = tRelease - Math.min(0.05, sum.times.hold * 0.5);
    break;
  default:
    tDisplay = tRelease + Number(tParam);
}
const cursorParam = q.get('cursor');
const cursorTime = cursorParam !== null ? tRelease + Number(cursorParam) : null;

function phaseAt(t: number): Phase {
  if (t < tSpinStart) return 'pumpdown';
  if (t < tSpinEnd) return 'spinup';
  if (t < tRelease) return 'hold';
  if (t < tRelease + sum.times.corridor) return 'corridor';
  if (t < sum.times.end) return 'flight';
  return 'ended';
}

/** Replay snapshot with the display-time phase and (pre-release) rotor state from telemetry. */
function snapshotAt(t: number): Snapshot {
  const s = session.snapshotAt(t);
  s.phase = phaseAt(t);
  if (t < tRelease) {
    const rt = session.rotorTable;
    const row = rt.rowAt(t);
    const ta = rt.get('t', row);
    const nb = Math.min(rt.length - 1, row + 1);
    const tb = rt.get('t', nb);
    const f = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 0;
    const omega = rt.get('omega', row) + (rt.get('omega', nb) - rt.get('omega', row)) * f;
    const phi = (rt.get('phi', row) + omega * (t - ta)) % (2 * Math.PI);
    const R = session.s.geometry.armRadius;
    s.rotor = {
      ...s.rotor,
      phi,
      omega,
      tipSpeed: omega * R,
      rpm: (omega * 60) / (2 * Math.PI),
      aRadialG: (omega * omega * R) / G0,
      pressure: rt.get('pressure', row),
      attached: true,
    };
    delete s.vehicle;
  }
  return s;
}

// Flown table grows with the display time, like a live run.
const flown = new TelemetryTable(session.flightTable.channels);
const full = session.flightTable;
let flownRows = 0;
const rowBuf = new Array<number>(full.channels.length);
function growFlown(t: number | null): void {
  if (t === null) return;
  while (flownRows < full.length && full.get('t', flownRows) <= t) {
    for (let c = 0; c < full.channels.length; c++) rowBuf[c] = full.get(full.channels[c], flownRows);
    flown.push(rowBuf);
    flownRows++;
  }
}
growFlown(tDisplay);

const wallStart = performance.now();
function currentT(): number | null {
  if (tDisplay === null) return null;
  if (!play) return tDisplay;
  return Math.min(sum.times.end, tDisplay + ((performance.now() - wallStart) / 1000) * play);
}

let lastSnapT = NaN;
let lastSnap: Snapshot | null = null;
const source: RenderSource = {
  snapshot() {
    const t = currentT();
    if (t === null) return null;
    if (t !== lastSnapT) {
      lastSnapT = t;
      lastSnap = snapshotAt(t);
      growFlown(t);
    }
    return lastSnap;
  },
  scenario: () => session.s,
  flown: () => (tDisplay === null || flown.length === 0 ? null : flown),
  predicted: () => full,
  ghosts: () => ghosts,
  view: () => viewKind,
  overlays: () => overlays,
  cursorTime: () => cursorTime,
  reducedMotion: () => reduced,
  orbitBand: () => band,
};

const container = document.getElementById('view');
if (!container) throw new Error('#view missing');
let renderer: Renderer;
try {
  renderer = q.get('fallback') === '1' ? new Fallback2D(container, source) : createRenderer(container, source);
  state.renderer = renderer.kind;
  renderer.start();
} catch (e) {
  state.error = String(e);
  throw e;
}
const snap0 = source.snapshot();
state.info.t = tDisplay;
state.info.phase = snap0?.phase ?? 'pre-run';
state.info.rpm = snap0?.rotor.rpm;
state.info.alt = snap0?.vehicle?.altitude;
let frames = 0;
const tick = (): void => {
  if (++frames >= 12) {
    state.ready = true;
    return;
  }
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
(window as unknown as { __renderer: Renderer }).__renderer = renderer;
