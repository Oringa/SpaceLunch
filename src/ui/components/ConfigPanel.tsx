import { useMemo, useRef, useState } from 'react';
import type { Controller } from '../controller';
import { useStore } from '../store';
import { PARAMS, PRIMARY_PARAMS, type ParamDef } from '../../data/registry';
import { getPath } from '../../sim/config';
import { ParamControl } from './ParamControl';
import { consequenceFor } from '../consequences';
import { DESIGNS } from '../../data/designs';
import { FAILURE_CASES } from '../../data/failures';
import { MISSIONS } from '../../game/missions';
import { exportConfig, importConfig } from '../../sim/validate';
import type { BuildIssue } from '../../sim/build';
import * as F from '../format';

const MODEL_FOR: Record<string, string> = {
  'launcher.armRadiusM': 'rotor', 'launcher.targetTipSpeedMps': 'rotor', 'launcher.arm.materialId': 'arm-stress', 'launcher.arm.profile': 'arm-stress',
  'launcher.arm.rootAreaM2': 'arm-stress', 'launcher.arm.tipAreaM2': 'arm-stress', 'launcher.motorId': 'rotor', 'launcher.bearingId': 'losses',
  'launcher.vacuum.targetPressurePa': 'vacuum', 'launcher.vacuum.pumpSpeedM3s': 'vacuum', 'launcher.chamberRadiusM': 'vacuum', 'launcher.mountId': 'release',
  'launcher.exit.apertureRadiusM': 'release', 'launcher.exit.tunnelLengthM': 'release', 'launcher.release.timingOffsetS': 'release', 'flightPlan.elevationDeg': 'release',
  'vehicle.aeroFamilyId': 'aero', 'vehicle.finsId': 'aero', 'vehicle.noseRadiusM': 'thermal', 'vehicle.protectionId': 'thermal', 'vehicle.stackId': 'propulsion',
  'flightPlan.guidance.mode': 'guidance', 'vehicle.payloadMassKg': 'rotor', 'integrator.rtol': 'integrator', 'physics.atmosphere': 'atmosphere',
};

const GROUPS: Array<{ group: ParamDef['group']; title: string }> = [
  { group: 'launcher', title: 'Launcher & ground system' },
  { group: 'vehicle', title: 'Vehicle & payload' },
  { group: 'flight', title: 'Flight plan' },
  { group: 'environment', title: 'Environment' },
  { group: 'mode', title: 'Physics & run' },
  { group: 'numerics', title: 'Numerics' },
];

function issuesFor(path: string, issues: BuildIssue[]): BuildIssue[] {
  return issues.filter((i) => i.path && (i.path === path || path.startsWith(i.path + '.') || i.path.startsWith(path)));
}

export function ConfigPanel({ ctl }: { ctl: Controller }) {
  const config = useStore(ctl.store, (s) => s.config);
  const scenario = useStore(ctl.store, (s) => s.scenario);
  const issues = useStore(ctl.store, (s) => s.buildIssues);
  const runStatus = useStore(ctl.store, (s) => s.run.status);
  const designId = useStore(ctl.store, (s) => s.designId);
  const missionId = useStore(ctl.store, (s) => s.missionId);
  const prediction = useStore(ctl.store, (s) => s.prediction);
  const [expert, setExpert] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const locked = runStatus === 'live' || runStatus === 'starting';

  const sections = useMemo(() => {
    const out: Array<{ group: string; title: string; sections: Array<{ name: string; params: ParamDef[] }> }> = [];
    for (const g of GROUPS) {
      const ps = PARAMS.filter((p) => p.group === g.group && p.tier !== 'primary' && (expert || p.tier !== 'expert'));
      const bySec = new Map<string, ParamDef[]>();
      for (const p of ps) bySec.set(p.section, [...(bySec.get(p.section) ?? []), p]);
      if (bySec.size) out.push({ group: g.group, title: g.title, sections: [...bySec].map(([name, params]) => ({ name, params })) });
    }
    return out;
  }, [expert]);

  const control = (def: ParamDef) => (
    <ParamControl
      key={def.path}
      def={def}
      value={getPath(config, def.path)}
      onChange={(v) => ctl.setParam(def.path, v)}
      locked={locked}
      issues={issuesFor(def.path, issues)}
      consequence={def.tier === 'primary' || ['launcher.chamberRadiusM', 'launcher.arm.rootAreaM2', 'launcher.motorId', 'launcher.balanceId', 'launcher.mountId', 'launcher.exit.apertureRadiusM', 'flightPlan.azimuthDeg', 'vehicle.lengthM', 'vehicle.noseRadiusM', 'launcher.vacuum.targetPressurePa'].includes(def.path) ? consequenceFor(def.path, scenario) : undefined}
      onInspect={MODEL_FOR[def.path] ? () => ctl.store.set({ inspector: MODEL_FOR[def.path] }) : undefined}
    />
  );

  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  const generalIssues = issues.filter((i) => !i.path || !PARAMS.some((p) => issuesFor(p.path, [i]).length));
  const mission = missionId ? MISSIONS.find((m) => m.id === missionId) : null;

  const doExport = (): void => {
    const blob = new Blob([exportConfig(config)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${config.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'centrifuge'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const doImport = async (f: File): Promise<void> => {
    const r = importConfig(await f.text());
    if (r.ok && r.config) {
      ctl.setConfig(r.config, 'imported');
      setImportMsg(`Imported "${r.config.name}"${r.warnings.length ? ` with ${r.warnings.length} warning(s): ${r.warnings.join(' ')}` : ''}.`);
    } else setImportMsg(`Import rejected: ${r.errors.slice(0, 6).join(' · ')}${r.errors.length > 6 ? ` (+${r.errors.length - 6} more)` : ''}`);
  };

  return (
    <div>
      <div className="group-title">Design</div>
      <div style={{ padding: '0 12px 8px', display: 'grid', gap: 6 }}>
        <select
          aria-label="Load a reference design"
          value={DESIGNS.some((d) => d.id === designId) || FAILURE_CASES.some((d) => d.id === designId) ? designId : ''}
          disabled={locked}
          onChange={(e) => {
            const id = e.target.value;
            const fc = FAILURE_CASES.find((x) => x.id === id);
            if (fc) ctl.setConfig(fc.make(), id);
            else if (id) ctl.loadDesign(id);
          }}
          style={{ width: '100%', background: 'var(--panel-2)', border: '1px solid var(--line-strong)', borderRadius: 4, padding: '5px 6px' }}
        >
          <option value="">— custom: {config.name} —</option>
          <optgroup label="Tested reference designs">
            {DESIGNS.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </optgroup>
          <optgroup label="Learn from a failure">
            {FAILURE_CASES.map((d) => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
          </optgroup>
        </select>
        {mission && <div className="chip">Mission {mission.index}: {mission.name}</div>}
        {FAILURE_CASES.find((x) => x.id === designId) && <div className="chip warn">▲ {FAILURE_CASES.find((x) => x.id === designId)!.lesson}</div>}
      </div>

      <div className="group-title">Primary controls</div>
      <div style={{ padding: '0 12px 10px', display: 'grid', gap: 10 }}>{PRIMARY_PARAMS.map(control)}</div>

      <Preflight ctl={ctl} errors={errors} warnings={warnings} general={generalIssues} locked={locked} predictionStatus={prediction.status} />

      {sections.map((g) => (
        <div key={g.group}>
          <div className="group-title">{g.title}</div>
          {g.sections.map((sec) => (
            <details className="section" key={sec.name}>
              <summary>
                {sec.name}
                {sec.params.some((p) => issuesFor(p.path, errors).length) && <span style={{ color: 'var(--bad)' }} aria-label="has errors">✖</span>}
              </summary>
              <div className="body">
                {sec.params.map(control)}
                {sec.name === 'Guidance' && <GuidanceExtras ctl={ctl} locked={locked} />}
              </div>
            </details>
          ))}
        </div>
      ))}
      <div style={{ padding: '10px 12px', display: 'grid', gap: 6 }}>
        <label className="toggle">
          <input type="checkbox" checked={expert} onChange={(e) => setExpert(e.target.checked)} /> Show expert parameters (sandbox overrides)
        </label>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button className="btn small" onClick={doExport}>Export JSON</button>
          <button className="btn small" onClick={() => fileRef.current?.click()} disabled={locked}>Import JSON…</button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
        </div>
        {importMsg && <div className="faint" role="status">{importMsg}</div>}
        <div className="faint" style={{ fontSize: 11 }}>
          Configuration autosaves in this browser. Build parameters are locked during a run.
        </div>
      </div>
    </div>
  );
}

function GuidanceExtras({ ctl, locked }: { ctl: Controller; locked: boolean }) {
  const config = useStore(ctl.store, (s) => s.config);
  const g = config.flightPlan.guidance;
  const ign = g.ignition;
  const jet = config.flightPlan.jettison;
  const setIgn = (kind: string, value: number): void => {
    const v = kind === 'altitude' ? { kind: 'altitude' as const, valueM: value } : kind === 'time-after-release' ? { kind: 'time-after-release' as const, valueS: value } : { kind: 'vertical-speed-below' as const, valueMps: value };
    ctl.setParam('flightPlan.guidance.ignition', v);
  };
  const ignVal = ign.kind === 'altitude' ? ign.valueM / 1000 : ign.kind === 'time-after-release' ? ign.valueS : ign.valueMps;
  return (
    <>
      <div className="param">
        <div className="row1"><span className="name">Ignition condition</span></div>
        <div className="row2">
          <select value={ign.kind} disabled={locked} onChange={(e) => setIgn(e.target.value, e.target.value === 'altitude' ? 60000 : e.target.value === 'time-after-release' ? 30 : 400)} aria-label="Ignition condition">
            <option value="altitude">Altitude above</option>
            <option value="time-after-release">Time after release</option>
            <option value="vertical-speed-below">Vertical speed below</option>
          </select>
          <span className="numbox">
            <input aria-label="Ignition value" defaultValue={ignVal} key={`${ign.kind}-${ignVal}`} disabled={locked} onBlur={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) setIgn(ign.kind, ign.kind === 'altitude' ? n * 1000 : n);
            }} />
            <span className="unit">{ign.kind === 'altitude' ? 'km' : ign.kind === 'time-after-release' ? 's' : 'm/s'}</span>
          </span>
        </div>
      </div>
      <div className="param">
        <div className="row1"><span className="name">Aeroshell jettison</span></div>
        <div className="row2">
          <select value={jet.kind} disabled={locked} aria-label="Jettison condition" onChange={(e) => ctl.setParam('flightPlan.jettison', e.target.value === 'never' ? { kind: 'never' } : { kind: 'altitude', valueM: 60000 })}>
            <option value="altitude">At altitude</option>
            <option value="never">Never (staging forces it)</option>
          </select>
          {jet.kind === 'altitude' && (
            <span className="numbox">
              <input aria-label="Jettison altitude" defaultValue={jet.valueM / 1000} key={jet.valueM} disabled={locked} onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) ctl.setParam('flightPlan.jettison', { kind: 'altitude', valueM: n * 1000 });
              }} />
              <span className="unit">km</span>
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function Preflight({ ctl, errors, warnings, general, locked, predictionStatus }: { ctl: Controller; errors: BuildIssue[]; warnings: BuildIssue[]; general: BuildIssue[]; locked: boolean; predictionStatus: string }) {
  const scenario = useStore(ctl.store, (s) => s.scenario);
  const pred = useStore(ctl.store, (s) => s.prediction);
  const d = scenario?.derived;
  const checks: Array<{ ok: boolean | null; text: string }> = d
    ? [
        { ok: d.pump.feasible, text: `Vacuum: ${F.pressure(scenario!.config.launcher.vacuum.targetPressurePa)} in ${F.duration(d.pump.time)}` },
        { ok: d.equilibriumTipSpeed >= scenario!.config.launcher.targetTipSpeedMps, text: `Drive reaches ${F.mps(scenario!.config.launcher.targetTipSpeedMps)} (max ${F.mps(d.equilibriumTipSpeed)}) in ≈ ${F.duration(d.spinupTimeEstimate)}` },
        { ok: d.stressMargin >= 1 ? (d.stressMargin >= scenario!.config.launcher.structure.safetyFactor ? true : null) : false, text: `Arm stress margin ${F.num(d.stressMargin, 2)} (SF ${scenario!.config.launcher.structure.safetyFactor} required)` },
        { ok: d.postReleaseBearingLoad <= d.bearingLimit, text: `Post-release bearing load ${F.force(d.postReleaseBearingLoad)} / ${F.force(d.bearingLimit)}` },
        { ok: d.apertureMargin > 0, text: `Exit margin ${F.length(d.apertureMargin)}, timing tolerance ≈ ±${F.duration(d.timingToleranceS)}` },
        { ok: d.stabilityMarginHypersonicCal > 0 ? true : null, text: `Static margin ${F.num(d.stabilityMarginSubsonicCal, 2)} / ${F.num(d.stabilityMarginHypersonicCal, 2)} cal` },
      ]
    : [];
  const ps = pred.summary;
  return (
    <div className="preflight" aria-label="Preflight checks">
      <div className="group-title" style={{ padding: '4px 0' }}>Preflight</div>
      <ul className="issue-list">
        {checks.map((c, i) => (
          <li key={i}>
            <span className={c.ok === true ? 'sym-ok' : c.ok === false ? 'sym-error' : 'sym-warning'} aria-label={c.ok === true ? 'pass' : c.ok === false ? 'fail' : 'warning'}>
              {c.ok === true ? '✔' : c.ok === false ? '✖' : '▲'}
            </span>
            <span>{c.text}</span>
          </li>
        ))}
        {[...errors.filter((e) => general.includes(e)), ...warnings.filter((w) => general.includes(w))].map((i, k) => (
          <li key={`g${k}`}>
            <span className={i.level === 'error' ? 'sym-error' : 'sym-warning'}>{i.level === 'error' ? '✖' : '▲'}</span>
            <span>{i.message}</span>
          </li>
        ))}
      </ul>
      <div className="card" style={{ marginTop: 6, padding: '6px 8px' }} aria-live="polite">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
          <b style={{ fontSize: 12 }}>Prediction (same solver)</b>
          <span className="faint" style={{ fontSize: 11 }}>{predictionStatus === 'running' ? `computing… ${pred.phase ?? ''}` : pred.wallMs ? `${F.num(pred.wallMs, 0)} ms` : ''}</span>
        </div>
        {predictionStatus === 'done' && ps && (
          <div style={{ fontSize: 12 }}>
            {ps.failure ? <span style={{ color: 'var(--bad)' }}>✖ {ps.failure.message}</span> : ps.orbit?.validated ? <span style={{ color: 'var(--ok)' }}>✔ Orbit {F.km(ps.orbit.periapsisAltitude, 0)} × {F.km(ps.orbit.apoapsisAltitude, 0)}</span> : <span>Apogee {F.km(ps.extrema.maxAltitude.value)} · {ps.terminal === 'ground-contact' ? 'returns to ground' : ps.terminal}</span>}
            <div className="faint">max q {F.pressure(ps.extrema.maxQ.value)} · peak flux {F.flux(ps.extrema.maxHeatFlux.value)} · nose {F.kelvin(ps.extrema.maxT1.value)}</div>
          </div>
        )}
        {predictionStatus === 'failed' && <div style={{ color: 'var(--bad)', fontSize: 12 }}>✖ {pred.message}</div>}
      </div>
      <button className="btn primary big" style={{ marginTop: 8 }} disabled={errors.length > 0 || locked || !scenario?.ok} onClick={() => ctl.launch()} title="Launch (L)">
        {locked ? 'Run in progress…' : errors.length ? `Fix ${errors.length} error${errors.length > 1 ? 's' : ''} to launch` : '▶ Launch'}
      </button>
    </div>
  );
}
