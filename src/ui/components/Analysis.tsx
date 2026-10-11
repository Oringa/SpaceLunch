import { useEffect, useMemo, useRef, useState } from 'react';
import type { Controller } from '../controller';
import { useStore } from '../store';
import * as F from '../format';
import { FAILURE_LABEL, type RunSummary } from '../../sim/session';
import { PARAMS, PARAM_BY_PATH, fromDisplay, toDisplay } from '../../data/registry';
import { cloneConfig, getPath, setPath, type SimConfig } from '../../sim/config';
import { missionById } from '../../game/missions';
import { AMORTISATION_LAUNCHES } from '../../game/costs';

function outcomeText(s: RunSummary | undefined): string {
  if (!s) return '—';
  if (s.failure) return `✖ ${FAILURE_LABEL[s.failure.kind]}`;
  if (s.orbit?.validated) return `✔ Orbit ${F.km(s.orbit.periapsisAltitude, 0)} × ${F.km(s.orbit.apoapsisAltitude, 0)}`;
  if (s.terminal === 'aborted') return 'Aborted';
  return `Apogee ${F.km(s.extrema.maxAltitude.value)} · ${s.terminal === 'ground-contact' ? 'returned to ground' : s.terminal ?? ''}`;
}

function Autopsy({ ctl, s }: { ctl: Controller; s: RunSummary }) {
  const f = s.failure!;
  const relT = s.release?.t ?? 0;
  const focus = (): void => {
    const map: Record<string, string[]> = {
      'thermal-envelope': ['temps', 'heatFlux', 'vAir', 'alt'],
      'exit-collision': ['clearance', 'alpha'],
      'aero-overload': ['alpha', 'q', 'accel'],
      'unstable-flight': ['alpha', 'q', 'accel'],
      'component-load': ['accel', 'tip', 'stress'],
      'structural-limit': ['stress', 'tip', 'power'],
      'propellant-exhausted': ['orbit', 'prop', 'alt'],
      'bearing-envelope': ['tip', 'energy'],
    };
    ctl.store.set({ plotChannels: map[f.kind] ?? ['alt', 'q'], plotAuto: false, cursorTime: f.t, bottomOpen: true });
  };
  return (
    <div className="card autopsy" role="alert">
      <h3>Failure autopsy — {FAILURE_LABEL[f.kind]}</h3>
      <p style={{ margin: '4px 0 8px' }}>{f.message}</p>
      <dl className="kv">
        <dt>Criterion</dt><dd>{f.criterion}</dd>
        <dt>Value / threshold</dt><dd className="bad">{F.num(f.value, 2)} / {F.num(f.threshold, 2)} {f.unit}</dd>
        <dt>Time</dt><dd>{f.t >= relT && s.release ? `T+${F.duration(f.t - relT)} after release` : `${F.clock(f.t)} (before release)`}</dd>
      </dl>
      {f.contributing.length > 0 && (
        <>
          <div className="faint" style={{ fontSize: 11, marginTop: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Contributing conditions</div>
          <dl className="kv">{f.contributing.map((c) => (<FragmentRow key={c.label} k={c.label} v={c.value} />))}</dl>
        </>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <button className="btn small" onClick={focus}>Show preceding data</button>
        <button className="btn small" onClick={() => ctl.store.set({ inspector: f.kind === 'thermal-envelope' ? 'thermal' : f.kind === 'exit-collision' ? 'release' : f.kind.includes('aero') || f.kind === 'unstable-flight' ? 'aero' : f.kind === 'structural-limit' ? 'arm-stress' : f.kind === 'propellant-exhausted' ? 'propulsion' : 'rotor' })}>Inspect the model</button>
      </div>
      <p className="faint" style={{ fontSize: 11, marginBottom: 0 }}>The run stopped at the first failed criterion. For approximate models this states that the selected envelope was exceeded, not an exact real-world destruction mechanism.</p>
    </div>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (<><dt>{k}</dt><dd style={{ whiteSpace: 'normal' }}>{v}</dd></>);
}

export function Analysis({ ctl }: { ctl: Controller }) {
  const run = useStore(ctl.store, (s) => s.run);
  const pred = useStore(ctl.store, (s) => s.prediction);
  const sc = useStore(ctl.store, (s) => s.scenario);
  const ghosts = useStore(ctl.store, (s) => s.ghosts);
  const records = useStore(ctl.store, (s) => s.records);
  const s = run.summary ?? pred.summary;
  const source = run.summary ? 'Last run' : pred.summary ? 'Prediction (not yet flown)' : '';
  const mission = useStore(ctl.store, (st) => (st.missionId ? missionById(st.missionId) : undefined));
  const missionRes = run.missionResult ?? (mission && pred.summary && sc ? mission.evaluate(pred.summary, sc) : undefined);

  return (
    <div className="analysis" aria-label="Analysis">
      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <h3>{source || 'No results yet'}</h3>
        {s ? (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <b style={{ fontSize: 16 }} className={s.failure ? 'ev-failure' : s.orbit?.validated ? 'ev-achievement' : ''}>{outcomeText(s)}</b>
            <span className="dim">{s.configName} · {s.modelVersion} · {s.fidelity}{s.fidelityFlags.length ? ` · ${s.fidelityFlags.join(' · ')}` : ''} · seed {s.seed}</span>
            {run.summary && <button className="btn small" onClick={() => ctl.replay()}>Replay this run (same commands)</button>}
            {run.summary && <ExportRun ctl={ctl} />}
          </div>
        ) : <span className="dim">Launch, or wait for the prediction, to see results.</span>}
      </div>
      {s?.failure && <Autopsy ctl={ctl} s={s} />}
      {missionRes && mission && (
        <div className={`card ${missionRes.passed ? 'success-card' : 'autopsy'}`}>
          <h3>Mission {mission.index}: {mission.name} — {missionRes.passed ? 'passed' : 'not passed'}{!run.missionResult ? ' (predicted)' : ''}</h3>
          {missionRes.objectives.map((o) => (
            <div className="objective" key={o.id}><span className={o.passed ? 'sym-ok ev-achievement' : 'ev-failure'}>{o.passed ? '✔' : '✖'}</span><span>{o.label}</span><span className="faint mono">{o.detail}</span></div>
          ))}
          {missionRes.score !== null && <div style={{ marginTop: 6 }}>{missionRes.scoreLabel}: <b className="mono">{F.num(missionRes.score, 2)}</b></div>}
        </div>
      )}
      {s && <Extremes s={s} />}
      {s && <EnergyCard s={s} />}
      {sc && (
        <div className="card">
          <h3>Cost per launch (fictional credits) <button className="inspect" onClick={() => ctl.store.set({ inspector: 'costs' })} aria-label="Inspect cost model">ⓘ</button></h3>
          <table className="table"><tbody>
            {sc.derived.costs.items.filter((i) => i.category === 'per-launch').map((i) => (<tr key={i.name}><td>{i.name}<div className="faint" style={{ fontSize: 11 }}>{i.note}</div></td><td className="n">{F.credits(i.credits)}</td></tr>))}
            <tr><td><b>Total per launch</b></td><td className="n"><b>{F.credits(sc.derived.costs.perLaunch)}</b></td></tr>
            <tr><td className="faint">Facility capital (amortised over {AMORTISATION_LAUNCHES})</td><td className="n faint">{F.credits(sc.derived.costs.capital)}</td></tr>
          </tbody></table>
        </div>
      )}
      {sc && (
        <div className="card">
          <h3>Mass breakdown (wet {F.mass(sc.derived.wetMass)})</h3>
          <table className="table"><tbody>
            {sc.derived.massBreakdown.map((m) => (<tr key={m.name}><td>{m.name}<span className="faint"> · {m.group}</span></td><td className="n">{F.mass(m.mass)}</td></tr>))}
            <tr><td className="faint">Cradle (stays on the rotor)</td><td className="n faint">{F.mass(sc.derived.tipMass - sc.derived.wetMass)}</td></tr>
          </tbody></table>
        </div>
      )}
      <GhostCompare ctl={ctl} ghosts={ghosts} />
      <Experiments ctl={ctl} />
      <div className="card">
        <h3>Local records</h3>
        <p className="faint" style={{ fontSize: 11, margin: '0 0 6px' }}>Separated by mission, model version, fidelity, physics toggles, uncertainty and release mode. A vacuum run never beats an atmosphere record.</p>
        {Object.keys(records).length === 0 ? <span className="dim">No records yet: pass a mission to set one.</span> : (
          <table className="table"><tbody>{Object.entries(records).map(([k, r]) => (<tr key={k}><td style={{ fontSize: 11 }}>{k.split('|').join(' · ')}</td><td className="n">{F.num(r.score, 2)}</td></tr>))}</tbody></table>
        )}
      </div>
    </div>
  );
}

function ExportRun({ ctl }: { ctl: Controller }) {
  const run = useStore(ctl.store, (s) => s.run);
  const events = useStore(ctl.store, (s) => s.events);
  return (
    <button className="btn small" onClick={() => {
      const blob = new Blob([JSON.stringify({ kind: 'centrifuge-run', config: run.config, commands: run.commandLog, events, summary: run.summary }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'centrifuge-run.json';
      a.click();
      URL.revokeObjectURL(a.href);
    }}>Export run record</button>
  );
}

function Extremes({ s }: { s: RunSummary }) {
  const X = s.extrema;
  const rel = s.release?.t ?? 0;
  const at = (t: number, alt?: number): string => (Number.isFinite(t) ? `T+${F.duration(t - rel)}${alt !== undefined && Number.isFinite(alt) ? ` @ ${F.km(alt, 1)}` : ''}` : '');
  return (
    <div className="card">
      <h3>Peaks (recorded at solver resolution)</h3>
      <table className="table"><tbody>
        <tr><td>Apogee</td><td className="n">{F.km(X.maxAltitude.value)}</td><td className="faint">{at(X.maxAltitude.t)}</td></tr>
        <tr><td>Max dynamic pressure</td><td className="n">{F.pressure(X.maxQ.value)}</td><td className="faint">{at(X.maxQ.t, X.maxQ.alt)}</td></tr>
        <tr><td>Max stagnation heat flux</td><td className="n">{F.flux(X.maxHeatFlux.value)}</td><td className="faint">{at(X.maxHeatFlux.t, X.maxHeatFlux.alt)}</td></tr>
        <tr><td>Stagnation heat load</td><td className="n">{F.num(X.maxHeatLoad.value / 1e6, 2)} MJ/m²</td><td /></tr>
        <tr><td>Nose / body / payload-bay temp.</td><td className="n">{F.kelvin(X.maxT1.value)} / {F.kelvin(X.maxT3.value)} / {F.kelvin(X.maxT4.value)}</td><td /></tr>
        <tr><td>Max proper accel. (flight) axial / lateral</td><td className="n">{F.g(X.maxAxialG.value)} / {F.g(X.maxLateralG.value)}</td><td className="faint">{at(X.maxAxialG.t, X.maxAxialG.alt)}</td></tr>
        <tr><td>Max lateral load on the arm</td><td className="n">{F.g(X.maxSpinLateralG.value)}</td><td /></tr>
        <tr><td>Max arm stress / threshold</td><td className="n">{F.num(X.maxArmStressRatio.value * 100, 1)}%</td><td /></tr>
        <tr><td>Min exit clearance</td><td className="n">{F.length(X.minClearance.value)}</td><td className="faint">{at(X.minClearance.t)}</td></tr>
        <tr><td>Max angle of attack (above q threshold)</td><td className="n">{F.deg(X.maxAlphaAboveQ.value, 2)}</td><td /></tr>
        {s.release && <tr><td>Release timing / direction error</td><td className="n">{F.duration(s.release.timingErrorS)} / {F.deg(s.release.directionErrorRad, 4)}</td><td /></tr>}
        {s.orbit && <tr><td>Orbit (inc. {s.orbit.inclination === null ? '—' : F.deg(s.orbit.inclination, 2)})</td><td className="n">{F.km(s.orbit.periapsisAltitude)} × {F.km(s.orbit.apoapsisAltitude)}</td><td className="faint">{s.orbit.validated ? 'validated' : 'not validated'}</td></tr>}
        <tr><td>Thrust Δv delivered / propellant used</td><td className="n">{F.num(s.thrustDeltaV, 0)} m/s / {F.mass(s.propellantUsed)}</td><td /></tr>
      </tbody></table>
    </div>
  );
}

function EnergyCard({ s }: { s: RunSummary }) {
  const E = s.energy;
  return (
    <div className="card">
      <h3>Energy accounting</h3>
      <table className="table"><tbody>
        <tr><td>Electrical (drive)</td><td className="n">{F.energy(E.electricalJ)}</td></tr>
        <tr><td className="faint">  motor losses</td><td className="n">{F.energy(E.motorLossJ)}</td></tr>
        <tr><td className="faint">  bearing losses</td><td className="n">{F.energy(E.bearingLossJ)}</td></tr>
        <tr><td className="faint">  residual-gas drag</td><td className="n">{F.energy(E.gasLossJ)}</td></tr>
        <tr><td>Vacuum pumps</td><td className="n">{F.energy(E.pumpJ)}</td></tr>
        <tr><td>Rotor KE at release</td><td className="n">{F.energy(E.rotorKEAtRelease)}</td></tr>
        <tr><td>Vehicle translational KE at release</td><td className="n">{F.energy(E.vehicleKEAtRelease)}</td></tr>
        <tr><td>Rotor KE left after release</td><td className="n">{F.energy(E.rotorKEAfterRelease)}</td></tr>
        <tr><td>Recoverable by regenerative braking</td><td className="n">{F.energy(E.recoverableJ)}</td></tr>
        <tr><td>Lost tearing the exit membrane</td><td className="n">{F.energy(E.membraneLossJ)}</td></tr>
      </tbody></table>
      <p className="faint" style={{ fontSize: 11, marginBottom: 0 }}>The vehicle's kinetic energy is only part of the electricity bill: the whole rotor, counterbalance and losses must be paid for.</p>
    </div>
  );
}

function GhostCompare({ ctl, ghosts }: { ctl: Controller; ghosts: ReturnType<Controller['store']['get']>['ghosts'] }) {
  return (
    <div className="card">
      <h3>Ghost trajectories (last {ghosts.length}/3 runs)</h3>
      {ghosts.length === 0 ? <span className="dim">Completed runs appear here and as faint ghosts in the plots and 3D views.</span> : (
        <table className="table"><thead><tr><th /><th>Run</th><th>Outcome</th><th>Apogee</th><th>Max q</th><th /></tr></thead><tbody>
          {ghosts.map((g) => (
            <tr key={g.id}>
              <td><span style={{ display: 'inline-block', width: 12, height: 3, background: g.color }} /></td>
              <td>{g.label}</td>
              <td style={{ fontSize: 11 }}>{outcomeText(g.summary)}</td>
              <td className="n">{F.km(g.summary.extrema.maxAltitude.value)}</td>
              <td className="n">{F.pressure(g.summary.extrema.maxQ.value)}</td>
              <td><button className="btn small" onClick={() => ctl.removeGhost(g.id)} aria-label={`Remove ${g.label}`}>✕</button></td>
            </tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ experiments
const NUMERIC = PARAMS.filter((p) => p.kind === 'number' && p.group !== 'numerics' && p.path !== 'seed' && p.path !== 'environment.weatherSeed');

function metricsOf(s?: RunSummary): Record<string, string> {
  if (!s) return {};
  return {
    Outcome: outcomeText(s),
    Apogee: F.km(s.extrema.maxAltitude.value),
    'Max q': F.pressure(s.extrema.maxQ.value),
    'Peak flux': F.flux(s.extrema.maxHeatFlux.value),
    'Nose max': F.kelvin(s.extrema.maxT1.value),
    'Min clearance': F.length(s.extrema.minClearance.value),
    'Electrical energy': F.energy(s.energy.electricalJ),
    Periapsis: s.orbit ? F.km(s.orbit.periapsisAltitude) : '—',
  };
}

function Experiments({ ctl }: { ctl: Controller }) {
  const batch = useStore(ctl.store, (s) => s.batch);
  const config = useStore(ctl.store, (s) => s.config);
  const [path, setPath2] = useState('launcher.targetTipSpeedMps');
  const def = PARAM_BY_PATH[path];
  const curDisplay = toDisplay(def, getPath(config, path) as number);
  const [newVal, setNewVal] = useState<string>(String(curDisplay));
  useEffect(() => setNewVal(String(Number(curDisplay.toPrecision(4)))), [path]); // eslint-disable-line react-hooks/exhaustive-deps
  const [nRobust, setNRobust] = useState(16);
  const running = batch.status === 'running';

  const counterfactual = (): void => {
    const v = Number(newVal);
    if (!Number.isFinite(v)) return;
    const b = cloneConfig(config);
    const m = cloneConfig(config);
    setPath(m, path, fromDisplay(def, v));
    m.name = `${config.name} (${def.name} = ${v} ${def.unit.display})`;
    ctl.runBatch('counterfactual', `Counterfactual: ${def.name}`, [b, m], ['baseline', 'changed']);
  };
  const vacuum = (): void => {
    const b = cloneConfig(config);
    const m = cloneConfig(config);
    m.physics.atmosphere = false;
    m.name = `${config.name} (vacuum)`;
    ctl.runBatch('vacuum', 'Vacuum thought experiment', [b, m], ['atmosphere', 'vacuum']);
  };
  const robustness = (): void => {
    const cs: SimConfig[] = [];
    const tags: number[] = [];
    for (let i = 0; i < nRobust; i++) {
      const c = cloneConfig(config);
      c.seed = 1000 + i;
      c.environment.weatherSeed = 2000 + i;
      c.uncertainty.enabled = true;
      c.environment.perturbation.enabled = true;
      cs.push(c);
      tags.push(i);
    }
    ctl.runBatch('robustness', `Robustness (${nRobust} seeded samples)`, cs, tags);
  };
  const frontier = (): void => {
    const R0 = config.launcher.armRadiusM, V0 = config.launcher.targetTipSpeedMps;
    const radii = [0.6, 0.8, 1, 1.2, 1.4].map((f) => Math.round(R0 * f * 10) / 10);
    const speeds = [0.7, 0.85, 1, 1.1, 1.2].map((f) => Math.round(V0 * f));
    const cs: SimConfig[] = [];
    const tags: Array<{ R: number; V: number }> = [];
    for (const R of radii) for (const V of speeds) {
      const c = cloneConfig(config);
      c.launcher.armRadiusM = R;
      c.launcher.chamberRadiusM = config.launcher.chamberRadiusM * (R / R0);
      c.launcher.targetTipSpeedMps = V;
      c.maxFlightTimeS = Math.min(c.maxFlightTimeS, 3600);
      c.orbitValidationRevs = 0;
      cs.push(c);
      tags.push({ R, V });
    }
    ctl.runBatch('frontier', 'Constraint frontier (radius × tip speed)', cs, tags);
  };

  return (
    <div className="card" style={{ gridColumn: '1 / -1' }}>
      <h3>Experiments (all run through the same solver)</h3>
      <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <div>
          <b>Counterfactual retry</b>
          <p className="faint" style={{ fontSize: 11, margin: '2px 0 4px' }}>Duplicate the design, change one cause, and compare solver outcomes.</p>
          <select value={path} onChange={(e) => setPath2(e.target.value)} style={{ width: '100%', background: 'var(--panel-2)', border: '1px solid var(--line-strong)', borderRadius: 4, padding: 4 }} aria-label="Parameter to change">
            {NUMERIC.map((p) => <option key={p.path} value={p.path}>{p.name}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
            <span className="faint mono" style={{ fontSize: 11 }}>{Number(curDisplay.toPrecision(4))} →</span>
            <span className="param"><span className="numbox"><input value={newVal} onChange={(e) => setNewVal(e.target.value)} aria-label="New value" /><span className="unit">{def.unit.display}</span></span></span>
            <button className="btn small" onClick={counterfactual} disabled={running}>Run pair</button>
          </div>
        </div>
        <div>
          <b>Vacuum thought experiment</b>
          <p className="faint" style={{ fontSize: 11, margin: '2px 0 4px' }}>Same design with atmospheric forces and heating removed; gravity and orbital mechanics stay. Shows what the air costs, and that a single ground impulse still cannot make an orbit.</p>
          <button className="btn small" onClick={vacuum} disabled={running}>Run with and without air</button>
        </div>
        <div>
          <b>Robustness</b>
          <p className="faint" style={{ fontSize: 11, margin: '2px 0 4px' }}>Seeded batch over the stated uncertainties (aero, heating, strength, drive, Isp, release jitter, weather).</p>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select value={nRobust} onChange={(e) => setNRobust(Number(e.target.value))} aria-label="Sample count" style={{ background: 'var(--panel-2)', border: '1px solid var(--line-strong)', borderRadius: 4, padding: 3 }}>
              {[8, 16, 32, 64].map((n) => <option key={n} value={n}>{n} samples</option>)}
            </select>
            <button className="btn small" onClick={robustness} disabled={running}>Run batch</button>
          </div>
        </div>
        <div>
          <b>Constraint frontier</b>
          <p className="faint" style={{ fontSize: 11, margin: '2px 0 4px' }}>5 × 5 grid of arm radius × tip speed around this design (chamber scaled with radius), coloured by the limiting modelled constraint.</p>
          <button className="btn small" onClick={frontier} disabled={running}>Map frontier</button>
        </div>
      </div>
      {batch.status !== 'idle' && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <b style={{ fontSize: 12 }}>{batch.label}</b>
            <span className="faint" style={{ fontSize: 11 }}>{batch.status}{batch.wallMs ? ` · ${F.num(batch.wallMs / 1000, 1)} s` : ''}</span>
            {running && <button className="btn small" onClick={() => ctl.cancelBatch()}>Cancel</button>}
          </div>
          {running && <div className="progress" style={{ marginTop: 4 }}><i style={{ width: `${(batch.progress || 0) * 100}%` }} /></div>}
          {batch.status === 'done' && batch.results && <BatchResults batch={batch} />}
        </div>
      )}
    </div>
  );
}

function BatchResults({ batch }: { batch: ReturnType<Controller['store']['get']>['batch'] }) {
  const results = batch.results!;
  if (batch.kind === 'frontier') return <Frontier results={results} />;
  if (batch.kind === 'robustness') return <Robustness results={results} />;
  const rows = results.map((r) => ({ tag: String(r.tag), m: r.summary ? metricsOf(r.summary) : { Outcome: `✖ ${r.error}` } }));
  const keys = Array.from(new Set(rows.flatMap((r) => Object.keys(r.m))));
  return (
    <>
      <table className="table" style={{ marginTop: 6 }}>
        <thead><tr><th>Metric</th>{rows.map((r) => <th key={r.tag}>{r.tag}</th>)}</tr></thead>
        <tbody>{keys.map((k) => <tr key={k}><td>{k}</td>{rows.map((r) => <td key={r.tag} className="n" style={{ textAlign: 'left' }}>{r.m[k] ?? '—'}</td>)}</tr>)}</tbody>
      </table>
      {batch.kind === 'vacuum' && <p className="faint" style={{ fontSize: 11 }}>In vacuum the same release reaches far higher, yet the trajectory still intersects Earth: a single impulse from the ground cannot produce an orbit around it. Orbit needs onboard horizontal Δv after leaving the atmosphere.</p>}
      {batch.kind === 'counterfactual' && <p className="faint" style={{ fontSize: 11 }}>Both columns were computed by the solver; differences are tested outcomes, not hypotheses.</p>}
    </>
  );
}

function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

function Robustness({ results }: { results: Array<{ tag: unknown; summary?: RunSummary; error?: string }> }) {
  const ok = results.filter((r) => r.summary);
  const n = ok.length;
  const success = ok.filter((r) => !r.summary!.failure).length;
  const [lo, hi] = wilson(success, n);
  const ap = ok.map((r) => r.summary!.extrema.maxAltitude.value).sort((a, b) => a - b);
  const q = (arr: number[], p: number): number => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : NaN);
  const kinds = new Map<string, number>();
  for (const r of ok) if (r.summary!.failure) kinds.set(r.summary!.failure.kind, (kinds.get(r.summary!.failure.kind) ?? 0) + 1);
  const peri = ok.filter((r) => r.summary!.orbit).map((r) => r.summary!.orbit!.periapsisAltitude).sort((a, b) => a - b);
  return (
    <div style={{ marginTop: 6 }}>
      <dl className="kv">
        <dt>Samples</dt><dd>{n}{results.length > n ? ` (+${results.length - n} invalid)` : ''}</dd>
        <dt>No failure criterion triggered</dt><dd>{success}/{n} = {F.num((100 * success) / Math.max(1, n), 0)}% (95% interval {F.num(lo * 100, 0)}–{F.num(hi * 100, 0)}%)</dd>
        <dt>Apogee 5th / median / 95th pct.</dt><dd>{F.km(q(ap, 0.05))} / {F.km(q(ap, 0.5))} / {F.km(q(ap, 0.95))}</dd>
        {peri.length > 0 && (<><dt>Periapsis 5th / median</dt><dd>{F.km(q(peri, 0.05))} / {F.km(q(peri, 0.5))}</dd></>)}
        {[...kinds].map(([k, c]) => (<FragmentRow key={k} k={FAILURE_LABEL[k as keyof typeof FAILURE_LABEL]} v={`${c}`} />))}
      </dl>
      <p className="faint" style={{ fontSize: 11 }}>With {n} samples the interval is wide; this is an estimate under the stated model uncertainties, not a reliability certification.</p>
    </div>
  );
}

const KIND_COLOR: Record<string, string> = {
  ok: '#5fd38d', 'component-load': '#c58cff', 'structural-limit': '#ff6b6b', 'bearing-envelope': '#ff9f6b', 'exit-collision': '#f2c14e',
  'aero-overload': '#4cc9f0', 'thermal-envelope': '#ff7aa8', 'unstable-flight': '#8ab4f8', 'propellant-exhausted': '#b0b0b0', invalid: '#444c56', numerical: '#666',
};

function Frontier({ results }: { results: Array<{ tag: unknown; summary?: RunSummary; error?: string }> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const cells = useMemo(() => results.map((r) => {
    const t = r.tag as { R: number; V: number };
    const kind = r.error ? 'invalid' : r.summary?.failure ? r.summary.failure.kind : 'ok';
    const label = r.error ? 'config error' : r.summary?.failure ? FAILURE_LABEL[r.summary.failure.kind] : r.summary?.orbit?.validated ? `orbit ${F.num(r.summary.orbit.periapsisAltitude / 1000, 0)} km` : `${F.num((r.summary?.extrema.maxAltitude.value ?? 0) / 1000, 0)} km`;
    return { ...t, kind, label, err: r.error };
  }), [results]);
  const Rs = Array.from(new Set(cells.map((c) => c.R))).sort((a, b) => a - b);
  const Vs = Array.from(new Set(cells.map((c) => c.V))).sort((a, b) => a - b);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const w = cv.clientWidth, h = cv.clientHeight, dpr = devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const padL = 60, padB = 34, cw = (w - padL - 8) / Vs.length, ch = (h - padB - 8) / Rs.length;
    ctx.font = '10px ui-monospace, monospace';
    for (const c of cells) {
      const i = Vs.indexOf(c.V), j = Rs.indexOf(c.R);
      const x = padL + i * cw, y = 8 + (Rs.length - 1 - j) * ch;
      ctx.fillStyle = KIND_COLOR[c.kind] ?? '#888';
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x + 1, y + 1, cw - 2, ch - 2);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#0b0f14';
      ctx.fillText(c.label.slice(0, Math.floor(cw / 6)), x + 4, y + ch / 2 + 3);
    }
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-dim');
    Vs.forEach((v, i) => ctx.fillText(`${v}`, padL + i * cw + cw / 2 - 12, h - 18));
    Rs.forEach((r, j) => ctx.fillText(`${r} m`, 4, 8 + (Rs.length - 1 - j) * ch + ch / 2 + 3));
    ctx.fillText('tip speed (m/s) →', padL, h - 4);
  }, [cells, Rs, Vs]);
  const kinds = Array.from(new Set(cells.map((c) => c.kind)));
  return (
    <div style={{ marginTop: 6 }}>
      <canvas ref={ref} style={{ width: '100%', height: 220, display: 'block' }} role="img" aria-label="Constraint frontier map" />
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11 }}>
        {kinds.map((k) => (<span key={k}><i style={{ display: 'inline-block', width: 10, height: 10, background: KIND_COLOR[k] ?? '#888', marginRight: 4 }} />{k === 'ok' ? 'no failure (label: apogee / orbit)' : k === 'invalid' ? 'invalid configuration' : FAILURE_LABEL[k as keyof typeof FAILURE_LABEL]}</span>))}
      </div>
      <p className="faint" style={{ fontSize: 11 }}>Each cell is a full solver run (vertical axis: arm radius). Cells marked invalid failed preflight (e.g. unreachable speed); their reasons are listed below.</p>
      <ul style={{ fontSize: 11, margin: 0, paddingLeft: 16 }} className="faint">{cells.filter((c) => c.err).slice(0, 6).map((c) => <li key={`${c.R}-${c.V}`}>R {c.R} m, v {c.V} m/s: {c.err}</li>)}</ul>
    </div>
  );
}
