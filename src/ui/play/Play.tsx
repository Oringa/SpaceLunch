/**
 * Play mode: the game-first presentation of the same simulation. Full-screen
 * 3D, mission cards, a friendly design dock, a flight HUD and a results card.
 * Every number still comes from the solver; Engineer mode shows the details.
 */
import { useEffect, useRef, useState } from 'react';
import type { Controller } from '../controller';
import { useStore } from '../store';
import { SimulationView } from '../components/SimulationView';
import { MISSIONS, type MissionResult } from '../../game/missions';
import { missionUnlocked, partUnlocked, totalStars, unlockHint, unlocksFor } from '../../game/progression';
import { MOTOR_PRESETS, PROTECTION_PRESETS, UPPER_STAGE_STACKS, BEARING_PRESETS, BALANCE_PRESETS, PAYLOAD_PRESETS, RCS_PRESETS, ARM_MATERIALS } from '../../data/presets';
import { AERO_FAMILIES } from '../../physics/aero';
import { PARAM_BY_PATH, fromDisplay, toDisplay } from '../../data/registry';
import { getPath } from '../../sim/config';
import { FAILURE_LABEL, type FailureKind, type RunSummary, type SimEvent } from '../../sim/session';
import { Help, Inspector } from '../components/Modals';
import * as F from '../format';

// ------------------------------------------------------------------ plain-language tips
const TIPS: Record<FailureKind | 'ground', string> = {
  'component-load': 'Your payload cannot take that many g for that long. Try a longer arm, a lower release speed, or a hardened payload.',
  'structural-limit': 'The arm was overstressed. Try a lower release speed, a stronger material, or a thicker, more tapered arm (Engineer mode).',
  'bearing-envelope': 'Once the vehicle leaves, the rotor is lopsided and the bearing takes the hit. Use the ballast-release counterbalance or a bigger bearing.',
  'exit-collision': 'The vehicle clipped the exit port. A rotating vehicle swings sideways: use the despin cradle, a wider port, or a shorter tunnel.',
  'aero-overload': 'The vehicle turned sideways in thick air and was overloaded. Add fins, put mass in the nose, or choose a more stable shape.',
  'unstable-flight': 'The vehicle lost control in thick air. Add fins, put mass in the nose, or choose a more stable shape.',
  'thermal-envelope': 'The nose overheated: heating grows with speed cubed. Choose a stronger heat shield, a blunter nose, or a slower release.',
  'propellant-exhausted': 'The rocket ran dry before reaching orbit. Carry less payload or launch faster and steeper so the rocket has less to do.',
  numerical: 'The solver could not continue with this design. Try less extreme settings.',
  'ground-contact': 'It came back down before the goal.',
  ground: 'It came back down. Reaching space is not orbit: you need about 7.8 km/s of sideways speed, which only a rocket stage can add.',
};

// ------------------------------------------------------------------ friendly dock controls
interface DockItem {
  path: string;
  label: string;
  /** Plain-language consequence. */
  note: (c: Controller) => string;
  status?: (c: Controller) => 'ok' | 'warn' | 'bad';
  options?: Record<string, string>;
  displayUnit?: string;
}

const DOCK: DockItem[] = [
  {
    path: 'launcher.armRadiusM', label: 'Arm length',
    note: (c) => { const d = c.store.get().scenario?.derived; return d ? `${F.num(d.rpm, 0)} rpm · payload feels ${F.num(d.aRadialG, 0)} g` : ''; },
    status: (c) => { const s = c.store.get().scenario; if (!s) return 'bad'; return s.derived.lateralLoadG > s.vehicle.envelopes.payloadLateralSustainedG ? 'bad' : s.derived.stressMargin < s.config.launcher.structure.safetyFactor ? 'warn' : 'ok'; },
  },
  {
    path: 'launcher.targetTipSpeedMps', label: 'Release speed',
    note: (c) => { const d = c.store.get().scenario?.derived; return d ? `${F.num(d.tipSpeed * 3.6, 0)} km/h · spin-up ${F.duration(d.spinupTimeEstimate)}` : ''; },
    status: (c) => { const s = c.store.get().scenario; if (!s) return 'bad'; return s.derived.equilibriumTipSpeed < s.config.launcher.targetTipSpeedMps ? 'bad' : s.derived.stressMargin < 1 ? 'bad' : 'ok'; },
  },
  {
    path: 'flightPlan.elevationDeg', label: 'Launch angle',
    note: () => 'steeper climbs higher; shallower goes farther',
  },
  {
    path: 'vehicle.payloadMassKg', label: 'Payload',
    note: (c) => { const d = c.store.get().scenario?.derived; return d ? `whole vehicle ${F.mass(d.wetMass)}` : ''; },
  },
  {
    path: 'vehicle.aeroFamilyId', label: 'Body shape',
    options: { 'slender-ogive': 'Slender dart', 'blunted-cone': 'Cone', 'hemisphere-cylinder': 'Blunt nose' },
    note: (c) => { const d = c.store.get().scenario?.derived; return d ? (d.stabilityMarginHypersonicCal > 0 ? 'stable at high speed ✓' : 'unstable at high speed — add fins or nose weight') : ''; },
    status: (c) => ((c.store.get().scenario?.derived.stabilityMarginHypersonicCal ?? 0) > 0 ? 'ok' : 'warn'),
  },
  {
    path: 'vehicle.protectionId', label: 'Heat shield',
    options: { none: 'None', 'ti-light': 'Titanium', 'cc-standard': 'Carbon-carbon', 'uhtc-heavy': 'UHTC ceramic' },
    note: (c) => { const s = c.store.get().scenario; const p = c.store.get().prediction.summary; if (!s) return ''; const lim = s.vehicle.thermal.noseMaterial.maxTemperatureK; return p ? `nose peak ${F.num(p.extrema.maxT1.value, 0)} K of ${lim} K` : `nose limit ${lim} K`; },
    status: (c) => { const s = c.store.get().scenario; const p = c.store.get().prediction.summary; if (!s || !p) return 'ok'; const r = p.extrema.maxT1.value / s.vehicle.thermal.noseMaterial.maxTemperatureK; return r >= 1 ? 'bad' : r > 0.9 ? 'warn' : 'ok'; },
  },
  {
    path: 'vehicle.stackId', label: 'Rocket stage',
    options: { none: 'None', 'kick-solid': 'Solid kick motor', l1: '1 liquid stage', 'l1-l2': '2 liquid stages', 'l1lt-l2': '2 stages (light)' },
    note: (c) => { const d = c.store.get().scenario?.derived; return d && d.idealDeltaV ? `adds up to ${F.num(d.idealDeltaV, 0)} m/s in space` : 'no rocket: what goes up comes down'; },
  },
  {
    path: 'flightPlan.guidance.mode', label: 'After release',
    options: { none: 'Coast', 'assisted-insertion': 'Autopilot to orbit', prograde: 'Burn prograde', 'pitch-program': 'Pitch program' },
    note: (c) => (c.store.get().scenario?.stages.length ? 'what the rocket does once in thin air' : 'needs a rocket stage'),
  },
];

function DockControl({ ctl, item, locked }: { ctl: Controller; item: DockItem; locked: boolean }) {
  useStore(ctl.store, (s) => s.configVersion);
  const completed = useStore(ctl.store, (s) => s.completed);
  const sandbox = useStore(ctl.store, (s) => !s.missionId);
  useStore(ctl.store, (s) => s.prediction.status);
  const def = PARAM_BY_PATH[item.path];
  const v = getPath(ctl.store.get().config, item.path);
  const status = item.status?.(ctl) ?? 'ok';
  return (
    <div className={`dock-card ${status}`}>
      <div className="dock-label">
        <span>{item.label}</span>
        <span className="dock-status" aria-label={status === 'ok' ? 'ok' : status === 'warn' ? 'warning' : 'problem'}>{status === 'ok' ? '✓' : status === 'warn' ? '▲' : '✖'}</span>
      </div>
      {def.kind === 'number' ? (
        <>
          <div className="dock-value">{F.num(toDisplay(def, v as number), def.precision ?? 0)}<small> {def.unit.display}</small></div>
          <input
            type="range"
            aria-label={item.label}
            min={toDisplay(def, def.min!)}
            max={toDisplay(def, item.path === 'vehicle.payloadMassKg' ? 300 : def.max!)}
            step={item.path === 'launcher.targetTipSpeedMps' ? 10 : item.path === 'vehicle.payloadMassKg' ? 0.5 : 0.5}
            value={toDisplay(def, v as number)}
            disabled={locked}
            onChange={(e) => ctl.setParam(item.path, fromDisplay(def, Number(e.target.value)))}
          />
        </>
      ) : (
        <select aria-label={item.label} value={String(v)} disabled={locked} onChange={(e) => ctl.setParam(item.path, e.target.value)}>
          {Object.entries(item.options ?? {}).map(([k, l]) => {
            const open = partUnlocked(k, completed, sandbox) || k === String(v);
            return <option key={k} value={k} disabled={!open}>{open ? l : `🔒 ${l} — ${unlockHint(k)}`}</option>;
          })}
        </select>
      )}
      <div className="dock-note">{item.note(ctl)}</div>
    </div>
  );
}

function predictionLine(ctl: Controller): { text: string; tone: 'ok' | 'bad' | 'wait' } {
  const st = ctl.store.get();
  const p = st.prediction;
  if (st.buildIssues.some((i) => i.level === 'error')) return { text: st.buildIssues.find((i) => i.level === 'error')!.message, tone: 'bad' };
  if (p.status === 'running') return { text: 'Simulating your design…', tone: 'wait' };
  if (p.status !== 'done' || !p.summary) return { text: p.message ?? 'Waiting for prediction', tone: 'wait' };
  const s = p.summary;
  const m = st.missionId ? MISSIONS.find((x) => x.id === st.missionId) : undefined;
  if (s.failure) return { text: `Predicted: ${FAILURE_LABEL[s.failure.kind].toLowerCase()}`, tone: 'bad' };
  if (m && st.scenario) {
    const r = m.evaluate(s, st.scenario);
    if (!r.passed) return { text: `Predicted: mission not met — ${r.objectives.find((o) => !o.passed)?.label.toLowerCase() ?? ''}`, tone: 'bad' };
    return { text: `Predicted: mission passes ✓ (${s.orbit?.validated ? `orbit ${F.num(s.orbit.periapsisAltitude / 1000, 0)} × ${F.num(s.orbit.apoapsisAltitude / 1000, 0)} km` : `apogee ${F.km(s.extrema.maxAltitude.value)}`})`, tone: 'ok' };
  }
  return { text: s.orbit?.validated ? `Predicted: orbit ${F.num(s.orbit.periapsisAltitude / 1000, 0)} × ${F.num(s.orbit.apoapsisAltitude / 1000, 0)} km` : `Predicted: climbs to ${F.km(s.extrema.maxAltitude.value)}, then falls back`, tone: 'ok' };
}

function DesignDock({ ctl }: { ctl: Controller }) {
  useStore(ctl.store, (s) => s.prediction.status);
  useStore(ctl.store, (s) => s.configVersion);
  const missionId = useStore(ctl.store, (s) => s.missionId);
  const ok = useStore(ctl.store, (s) => !!s.scenario?.ok);
  const [open, setOpen] = useState(true);
  const m = missionId ? MISSIONS.find((x) => x.id === missionId) : undefined;
  const best = useStore(ctl.store, (s) => (missionId ? s.completed[missionId] ?? 0 : 0));
  const pl = predictionLine(ctl);
  return (
    <div className={`dock${open ? '' : ' closed'}`}>
      <div className="dock-head">
        <div>
          <div className="dock-mission">{m ? `Mission ${m.index} · ${m.name}` : 'Sandbox'}</div>
          <div className="dock-brief">{m ? m.brief : 'Free play: every part unlocked, design anything the physics allows.'}</div>
          {m && (
            <div className="dock-stars">
              <span className="st on">★</span> complete · <span className={`st${best >= 2 ? ' on' : ''}`}>★</span> {m.starTiers[0].label} · <span className={`st${best >= 3 ? ' on' : ''}`}>★</span> {m.starTiers[1].label}
            </div>
          )}
        </div>
        <div className="spacer" />
        <button className="btn small" onClick={() => ctl.store.set({ showHome: true })}>Missions</button>
        <button className="btn small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide design ▾' : 'Design ▴'}</button>
      </div>
      {open && (
        <div className="dock-row">
          {DOCK.map((d) => <DockControl key={d.path} ctl={ctl} item={d} locked={false} />)}
        </div>
      )}
      <div className="dock-foot">
        <div className={`prediction-pill ${pl.tone}`} aria-live="polite">{pl.tone === 'wait' ? '⏳' : pl.tone === 'ok' ? '✓' : '✖'} {pl.text}</div>
        <button className="launch-btn" disabled={!ok} onClick={() => ctl.launch()}>LAUNCH</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ home
function Home({ ctl }: { ctl: Controller }) {
  const completed = useStore(ctl.store, (s) => s.completed);
  const stars = totalStars(completed);
  const firstTime = Object.keys(completed).length === 0;
  const nextM = MISSIONS.find((m) => !completed[m.id] && missionUnlocked(m.id, completed)) ?? MISSIONS[0];
  return (
    <div className="home" role="dialog" aria-label="Choose a mission">
      <div className="home-inner">
        <div className="home-title">CENTRIFUGE</div>
        <div className="home-tag">Spin it up. Let it go. Reach orbit — if the physics agrees.</div>
        <div className="home-progress">★ {stars} / {MISSIONS.length * 3}</div>
        <button className="first-launch" onClick={() => ctl.startMission(nextM.id)}>
          <span className="fl-k">{firstTime ? 'Start here' : 'Continue'}</span>
          <span className="fl-t">Mission {nextM.index} · {nextM.name}</span>
          <span className="fl-d">{firstTime ? 'A 15 m centrifuge flings a small instrument at 1 km/s. Press LAUNCH and watch.' : nextM.brief}</span>
        </button>
        <div className="level-path">
          {MISSIONS.map((m, i) => {
            const open = missionUnlocked(m.id, completed);
            const got = completed[m.id] ?? 0;
            return (
              <div className="level-step" key={m.id}>
                {i > 0 && <div className={`level-link${open ? ' open' : ''}`} />}
                <button className={`level-node${open ? '' : ' locked'}${got ? ' done' : ''}`} disabled={!open} onClick={() => ctl.startMission(m.id)} aria-label={`Mission ${m.index}: ${m.name}${open ? '' : ' (locked)'}`}>
                  <span className="ln-n">{open ? m.index : '🔒'}</span>
                  <span className="ln-stars">{[1, 2, 3].map((k) => <span key={k} className={k <= got ? 'on' : ''}>★</span>)}</span>
                  <span className="ln-t">{m.name}</span>
                  <span className="ln-d">{open ? m.brief : `Complete Mission ${m.index - 1} to unlock`}</span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="home-row">
          <button className="mission-card sandbox" onClick={() => ctl.startMission(null)}>
            <span className="mc-t">∞ Sandbox</span>
            <span className="mc-d">No goals, every part unlocked. Break things on purpose.</span>
          </button>
          <button className="mission-card" onClick={() => { ctl.store.set({ showHome: false }); ctl.setUiMode('engineer'); }}>
            <span className="mc-t">⚙ Engineer mode</span>
            <span className="mc-d">Every parameter, live plots, model inspector and experiments.</span>
          </button>
          <button className="mission-card" onClick={() => ctl.store.set({ helpOpen: true })}>
            <span className="mc-t">? How it works</span>
            <span className="mc-d">What is simulated, what is not, and the sources.</span>
          </button>
        </div>
        <p className="home-fine">A reduced-order physics simulation inspired by kinetic-launch concepts — not a model of any real company's system.</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ flight HUD
function phaseBanner(ctl: Controller): { title: string; sub: string; progress: number | null } {
  const s = ctl.snapshot;
  const st = ctl.store.get();
  if (!s) return { title: 'Preparing…', sub: '', progress: null };
  const sc = st.scenario;
  switch (s.phase) {
    case 'pumpdown': {
      const p0 = 101325, pt = sc?.config.launcher.vacuum.targetPressurePa ?? 1;
      return { title: 'Pumping the chamber to vacuum', sub: `${F.pressure(s.rotor.pressure)} → ${F.pressure(pt)} (time-lapse)`, progress: Math.log(p0 / s.rotor.pressure) / Math.log(p0 / pt) };
    }
    case 'spinup': {
      const target = sc?.config.launcher.targetTipSpeedMps ?? 1;
      return { title: 'Spinning up', sub: `${F.num(s.rotor.tipSpeed, 0)} of ${F.num(target, 0)} m/s · ${F.num(s.rotor.rpm, 0)} rpm · payload feels ${F.num(s.rotor.aRadialG, 0)} g (time-lapse)`, progress: s.rotor.tipSpeed / target };
    }
    case 'hold':
      return { title: 'Locking onto the release angle', sub: `${F.num(s.rotor.rpm, 1)} rpm — slow motion`, progress: null };
    case 'corridor':
      return { title: 'RELEASE', sub: s.vehicle ? `${F.mps(s.vehicle.vAir)} through the exit tunnel — slow motion` : '', progress: null };
    case 'flight': {
      const v = s.vehicle!;
      if (v.engineOn) return { title: 'Rocket burning', sub: `periapsis ${F.km(v.orbit.periapsisAltitude, 0)} → orbit needs > 200 km`, progress: null };
      if (st.run.summary?.orbit || v.orbit.bound && !v.orbit.intersectsEarth) return { title: 'In orbit', sub: `${F.num(v.orbit.periapsisAltitude / 1000, 0)} × ${F.num(v.orbit.apoapsisAltitude / 1000, 0)} km — confirming one full orbit (time-lapse)`, progress: null };
      return { title: v.orbit.radialVelocity > 0 ? 'Climbing' : 'Falling back', sub: v.altitude > 100_000 ? 'Above 100 km — but this path still hits Earth' : `${F.km(v.altitude)} · ${F.mps(v.vAir)}`, progress: null };
    }
    default:
      return { title: 'Run complete', sub: '', progress: null };
  }
}

const TOAST_KINDS = new Set(['release', 'clean-release', 'alt-30km', 'alt-100km', 'apogee', 'ignition', 'staging', 'jettison', 'orbit-insertion', 'orbit-validated', 'ground-contact', 'at-speed']);
const TOAST_TITLE: Record<string, (e: SimEvent) => string> = {
  'at-speed': () => 'Up to speed',
  release: () => 'Released!',
  'clean-release': () => 'Clean exit ✓',
  'alt-30km': () => '30 km',
  'alt-100km': () => '100 km — edge of space',
  apogee: (e) => `Peak ${F.km(e.values?.altitude ?? 0)}`,
  ignition: () => 'Ignition',
  staging: () => 'Stage separation',
  jettison: () => 'Shell jettisoned',
  'orbit-insertion': () => 'Orbit!',
  'orbit-validated': () => 'Orbit confirmed ✓',
  'ground-contact': () => 'Touchdown',
};

function Toasts({ ctl }: { ctl: Controller }) {
  const events = useStore(ctl.store, (s) => s.events);
  const [shown, setShown] = useState<Array<{ id: number; title: string; tone: string }>>([]);
  const seen = useRef(0);
  const nextId = useRef(1);
  useEffect(() => {
    if (events.length < seen.current) seen.current = 0;
    const fresh = events.slice(seen.current);
    seen.current = events.length;
    const add = fresh.filter((e) => (TOAST_KINDS.has(e.kind) || e.severity === 'failure') && !e.kind.startsWith('end:'));
    for (const e of add) {
      const id = nextId.current++;
      const title = e.severity === 'failure' ? `✖ ${e.label.split(':')[0]}` : (TOAST_TITLE[e.kind]?.(e) ?? e.label);
      setShown((s) => [...s, { id, title, tone: e.severity }].slice(-3));
      // Each toast owns its timer, so later events never cancel earlier removals.
      setTimeout(() => setShown((s) => s.filter((x) => x.id !== id)), 3200);
    }
  }, [events]);
  return (
    <div className="toasts" aria-live="polite">
      {shown.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.title}</div>)}
    </div>
  );
}

function FlightHud({ ctl }: { ctl: Controller }) {
  useStore(ctl.store, (s) => s.uiTick);
  const run = useStore(ctl.store, (s) => s.run);
  const view = useStore(ctl.store, (s) => s.view);
  const autoCam = useStore(ctl.store, (s) => s.autoCamera);
  const missionId = useStore(ctl.store, (s) => s.missionId);
  const events = useStore(ctl.store, (s) => s.events);
  const snap = ctl.snapshot;
  const b = phaseBanner(ctl);
  const v = snap?.vehicle;
  const pb = run.playback;
  const m = missionId ? MISSIONS.find((x) => x.id === missionId) : undefined;
  return (
    <>
      <div className="hud-banner">
        <div className="hud-title">{b.title}</div>
        <div className="hud-sub">{b.sub}</div>
        {b.progress !== null && <div className="hud-progress"><i style={{ width: `${Math.max(0, Math.min(1, b.progress)) * 100}%` }} /></div>}
      </div>
      <div className="hud-left">
        {v ? (
          <>
            <Big label="Altitude" value={F.km(v.altitude, v.altitude < 10_000 ? 2 : 1)} />
            {v.altitude < 100_000 ? <Big label="Speed (vs air)" value={F.speed(v.vAir)} /> : <Big label="Orbital speed" value={F.speed(v.vInertial)} />}
            <Big label="G-force felt" value={F.g(Math.hypot(v.axialG, v.lateralG))} />
            <Big label="Nose temperature" value={v.aeroshell ? F.kelvin(v.temps[0]) : '—'} />
          </>
        ) : snap?.phase === 'pumpdown' ? (
          <>
            <Big label="Chamber pressure" value={F.pressure(snap.rotor.pressure)} />
            <Big label="Target" value={F.pressure(ctl.store.get().config.launcher.vacuum.targetPressurePa)} />
            <Big label="Time to vacuum" value={F.duration(ctl.store.get().scenario?.derived.pump.time ?? NaN)} />
          </>
        ) : snap ? (
          <>
            <Big label="Tip speed" value={F.mps(snap.rotor.tipSpeed)} />
            <Big label="Rotor" value={`${F.num(snap.rotor.rpm, 0)} rpm`} />
            <Big label="Payload load" value={`${F.num(snap.rotor.aRadialG, 0)} g`} />
            <Big label="Power" value={F.power(snap.rotor.powerElec)} />
          </>
        ) : null}
      </div>
      {m && (
        <div className="hud-right">
          <div className="hud-obj-title">Mission {m.index} · milestones</div>
          {(MILESTONES[m.id] ?? []).map(([kind, label]) => {
            const done = events.some((e) => e.kind === kind);
            const failed = events.some((e) => e.severity === 'failure');
            return <div key={kind} className={`hud-obj${done ? ' done' : failed ? ' miss' : ''}`}>{done ? '✓' : failed ? '✖' : '○'} {label}</div>;
          })}
        </div>
      )}
      <div className="hud-controls">
        <button className="btn" onClick={() => ctl.setPlayback(!pb.playing, pb.auto ? { auto: true } : { auto: false, rate: pb.rate })} aria-label={pb.playing ? 'Pause' : 'Play'}>{pb.playing ? '❚❚' : '▶'}</button>
        <span className="hud-rate" title="Time compression (physics unchanged)">{F.rate(pb.rate)}</span>
        {!v && <button className="btn" onClick={() => ctl.skipTo('release')}>Skip to release</button>}
        <button className="btn" onClick={() => ctl.skipTo('end')}>Skip to end</button>
        <div className="seg" role="group" aria-label="Camera">
          {(['launcher', 'world', 'orbit'] as const).map((k) => (
            <button key={k} aria-pressed={view === k && !autoCam} onClick={() => ctl.store.set({ view: k, autoCamera: false })}>{k === 'launcher' ? 'Machine' : k === 'world' ? 'World' : 'Orbit'}</button>
          ))}
          <button aria-pressed={autoCam} onClick={() => ctl.store.set({ autoCamera: !autoCam })} title="Camera follows the action">Auto</button>
        </div>
        <button className="btn danger" onClick={() => ctl.command('abort')}>Abort</button>
      </div>
    </>
  );
}

const MILESTONES: Record<string, Array<[string, string]>> = {
  'm1-clean-release': [['at-speed', 'Up to speed'], ['clean-release', 'Clean exit through the port'], ['apogee', 'Reach the peak intact']],
  'm2-thirty-km': [['clean-release', 'Clean exit'], ['alt-30km', 'Reach 30 km'], ['apogee', 'Peak']],
  'm3-edge-of-space': [['clean-release', 'Clean exit'], ['alt-30km', '30 km'], ['alt-100km', 'Cross 100 km']],
  'm4-leo': [['clean-release', 'Clean exit'], ['ignition', 'Rocket ignition'], ['alt-100km', 'Cross 100 km'], ['orbit-insertion', 'Orbit insertion'], ['orbit-validated', 'One full orbit']],
  'm5-optimise': [['clean-release', 'Clean exit'], ['ignition', 'Rocket ignition'], ['orbit-insertion', 'Orbit insertion'], ['orbit-validated', 'One full orbit']],
};

function Big({ label, value }: { label: string; value: string }) {
  return (
    <div className="big">
      <div className="big-v">{value}</div>
      <div className="big-l">{label}</div>
    </div>
  );
}

// ------------------------------------------------------------------ results
const PART_NAME = (id: string): string =>
  MOTOR_PRESETS[id]?.name ?? PROTECTION_PRESETS[id]?.name ?? UPPER_STAGE_STACKS[id]?.name ?? BEARING_PRESETS[id]?.name ?? BALANCE_PRESETS[id]?.name ??
  PAYLOAD_PRESETS[id]?.name ?? RCS_PRESETS[id]?.name ?? ARM_MATERIALS[id]?.name ?? AERO_FAMILIES[id]?.name ?? id;

function Confetti() {
  const pieces = Array.from({ length: 36 }, (_, i) => i);
  return (
    <div className="confetti" aria-hidden>
      {pieces.map((i) => (
        <i key={i} style={{ left: `${(i * 37) % 100}%`, animationDelay: `${(i % 9) * 0.07}s`, background: ['#ffb454', '#4cc9f0', '#5fd38d', '#c58cff'][i % 4], transform: `rotate(${i * 23}deg)` }} />
      ))}
    </div>
  );
}

function Results({ ctl, summary, result }: { ctl: Controller; summary: RunSummary; result?: MissionResult }) {
  const missionId = useStore(ctl.store, (s) => s.missionId);
  const reduced = useStore(ctl.store, (s) => s.reducedMotion);
  const m = missionId ? MISSIONS.find((x) => x.id === missionId) : undefined;
  const next = m ? MISSIONS.find((x) => x.index === m.index + 1) : undefined;
  const passed = result ? result.passed : !summary.failure;
  const f = summary.failure;
  const headline = result ? (passed ? ['', 'Mission complete', 'Great flight', 'Perfect!'][result.stars ?? 1] : 'Mission not passed') : f ? FAILURE_LABEL[f.kind] : summary.orbit?.validated ? 'In orbit!' : 'Flight complete';
  const tip = f ? TIPS[f.kind] : result && !passed && summary.terminal === 'ground-contact' ? TIPS.ground : null;
  const lb = ctl.lastBest;
  const newBest = !!(result?.passed && lb && lb.missionId === result.missionId && (result.stars ?? 0) > lb.previous);
  const firstClear = !!(result?.passed && lb && lb.missionId === result.missionId && lb.previous === 0);
  const unlocked = firstClear && m ? unlocksFor(m.id) : [];
  return (
    <div className="results" role="dialog" aria-label="Results">
      {passed && result && !reduced && <Confetti />}
      <div className={`results-head ${passed ? 'ok' : 'bad'}`}>{passed ? '' : '✖ '}{headline}</div>
      {result && (
        <div className="results-stars" aria-label={`${result.stars ?? 0} of 3 stars`}>
          {[0, 1, 2].map((k) => <span key={k} className={`big-star${k < (result.stars ?? 0) ? ' on' : ''}`} style={{ animationDelay: `${0.25 + k * 0.25}s` }}>★</span>)}
        </div>
      )}
      {newBest && <div className="new-best">New best!</div>}
      {result?.starDetails && (
        <div className="stars">
          {result.starDetails.map((o, i) => (
            <div key={i} className={`star ${o.earned ? 'on' : ''}`}><span>{o.earned ? '★' : '☆'}</span>{o.label}</div>
          ))}
        </div>
      )}
      {result && !passed && (
        <div className="stars">
          {result.objectives.filter((o) => !o.passed && o.id !== 'not-orbit').map((o) => <div key={o.id} className="star"><span>✖</span>{o.label}<small>{o.detail}</small></div>)}
        </div>
      )}
      {f && <p className="results-why">{f.message}</p>}
      {tip && <p className="results-tip">💡 {tip}</p>}
      <div className="results-stats">
        <Stat k="Highest point" v={F.km(summary.extrema.maxAltitude.value)} />
        <Stat k="Release speed" v={summary.release ? F.mps(summary.release.tipSpeed) : '—'} />
        <Stat k="Peak payload load" v={F.g(Math.max(summary.extrema.maxSpinLateralG.value, summary.extrema.maxPayloadLateralG.value))} />
        <Stat k="Hottest nose" v={F.kelvin(summary.extrema.maxT1.value)} />
        <Stat k="Electricity" v={`${F.num(summary.energy.electricalJ / 3.6e9, 2)} MWh`} />
        {summary.orbit ? <Stat k="Orbit" v={`${F.num(summary.orbit.periapsisAltitude / 1000, 0)} × ${F.num(summary.orbit.apoapsisAltitude / 1000, 0)} km`} /> : <Stat k="Flight time" v={F.duration(summary.times.flight)} />}
      </div>
      {unlocked.length > 0 && (
        <div className="unlocks"><b>Unlocked:</b> {unlocked.map((u) => PART_NAME(u)).join(' · ')}{next ? ` · Mission ${next.index}` : ''}</div>
      )}
      <div className="results-actions">
        <button className="btn primary" onClick={() => ctl.launch()} autoFocus>↻ Launch again</button>
        <button className="btn" onClick={() => ctl.reset()}>Tweak design</button>
        {passed && next && <button className="btn primary" onClick={() => ctl.startMission(next.id)}>Next mission →</button>}
        <button className="btn" onClick={() => { ctl.setUiMode('engineer'); ctl.store.set({ tab: 'analysis' }); }}>Engineering analysis</button>
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (<div className="stat"><div className="stat-v">{v}</div><div className="stat-k">{k}</div></div>);
}

// ------------------------------------------------------------------ shell
export function PlayShell({ ctl }: { ctl: Controller }) {
  const showHome = useStore(ctl.store, (s) => s.showHome);
  const run = useStore(ctl.store, (s) => s.run);
  const events = useStore(ctl.store, (s) => s.events);
  const reduced = useStore(ctl.store, (s) => s.reducedMotion);
  const [dismissed, setDismissed] = useState(0);
  const [flash, setFlash] = useState(false);
  const released = events.some((e) => e.kind === 'release');
  useEffect(() => {
    if (!released || reduced) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 650);
    return () => clearTimeout(t);
  }, [released, reduced]);
  const live = run.status === 'live' || run.status === 'starting';
  const finished = run.status === 'finished' && run.summary && dismissed !== run.runId;
  return (
    <div className={`play${flash ? ' release-flash' : ''}`}>
      <SimulationView ctl={ctl} variant="play" />
      <div className="play-top">
        <span className="play-logo">CENTRIFUGE</span>
        <span className="spacer" />
        <div className="seg" role="group" aria-label="Interface mode">
          <button aria-pressed onClick={() => ctl.setUiMode('play')}>Play</button>
          <button aria-pressed={false} onClick={() => ctl.setUiMode('engineer')} title="All parameters, instruments, plots and experiments">Engineer</button>
        </div>
        <button className="btn icon" onClick={() => ctl.store.set({ helpOpen: true })} aria-label="Help">?</button>
      </div>
      {showHome && !live && <Home ctl={ctl} />}
      {!showHome && !live && !finished && <DesignDock ctl={ctl} />}
      {live && <FlightHud ctl={ctl} />}
      {(live || finished) && <Toasts ctl={ctl} />}
      {finished && (
        <div className="results-back">
          <Results ctl={ctl} summary={run.summary!} result={run.missionResult} />
          <button className="results-close" onClick={() => setDismissed(run.runId)} aria-label="Close results and look around">Look around ✕</button>
        </div>
      )}
      <Inspector ctl={ctl} />
      <Help ctl={ctl} />
    </div>
  );
}
