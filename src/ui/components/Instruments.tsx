import type { Controller } from '../controller';
import { useStore } from '../store';
import * as F from '../format';
import { G0 } from '../../physics/constants';
import { THERMAL_FLAG_LOW_SPEED, THERMAL_FLAG_RAREFIED } from '../../physics/thermal';
import { AERO_FLAG_HIGH_ALPHA, AERO_FLAG_RAREFIED, AERO_FLAG_FINENESS } from '../../physics/aero';
import type { Snapshot, SimEvent } from '../../sim/session';
import type { Scenario } from '../../sim/build';
import { MISSIONS } from '../../game/missions';

interface Limit {
  label: string;
  value: number;
  limit: number;
  unit: string;
  ratio: number;
}

/** Ratios of current value to the envelope that currently binds. */
export function limits(snap: Snapshot | null, sc: Scenario | null): Limit[] {
  if (!snap || !sc) return [];
  const env = sc.vehicle.envelopes;
  const out: Limit[] = [];
  const add = (label: string, value: number, limit: number, unit: string): void => {
    if (Number.isFinite(limit) && limit > 0 && Number.isFinite(value)) out.push({ label, value, limit, unit, ratio: value / limit });
  };
  if (snap.rotor.attached) {
    const mat = sc.rotor.material;
    add('Arm stress / failure threshold', snap.rotor.stressRatio * mat.ultimateStrength / 1e6, mat.ultimateStrength / 1e6, 'MPa');
    add('Payload lateral load / peak limit', snap.rotor.lateralLoadG, env.payloadLateralPeakG, 'g');
    add('Payload lateral load / sustained limit', snap.rotor.lateralLoadG, env.payloadLateralSustainedG, 'g');
    if (sc.stages.length) add('Stage lateral load / sustained limit', snap.rotor.lateralLoadG, env.stageLateralSustainedG, 'g');
  }
  const v = snap.vehicle;
  if (v) {
    if (v.aeroshell) {
      add('Dynamic pressure / envelope', v.qDyn, env.maxDynamicPressurePa, 'Pa');
      add('Nose temperature / envelope', v.temps[0], sc.vehicle.thermal.noseMaterial.maxTemperatureK, 'K');
      add('Body temperature / envelope', v.temps[2], sc.vehicle.thermal.bodyMaxTemperatureK, 'K');
    }
    add('Payload bay temperature / envelope', v.temps[3], sc.vehicle.thermal.internalMaxTemperatureK, 'K');
    add('Payload lateral / peak limit', v.payloadLateralG, env.payloadLateralPeakG, 'g');
    if (Number.isFinite(v.clearance)) out.push({ label: 'Exit clearance (m, lower is worse)', value: v.clearance, limit: sc.derived.apertureMargin, unit: 'm', ratio: 1 - v.clearance / Math.max(1e-6, sc.derived.apertureMargin) });
    if (v.qDyn > env.angleLimitAboveQPa) add('Angle of attack / envelope', v.alphaDeg, (env.maxAngleOfAttackRad * 180) / Math.PI, '°');
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

function Meter({ l }: { l: Limit }) {
  const pct = Math.max(0, Math.min(1, l.ratio));
  const cls = l.ratio >= 1 ? 'bad' : l.ratio >= 0.8 ? 'warn' : '';
  return (
    <div className="meter">
      <span className="dim">{l.label}</span>
      <span className="mono">{F.num(l.ratio * 100, 0)}%</span>
      <div className={`bar ${cls}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} aria-label={l.label}>
        <i style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}

const EV_SYM: Record<string, string> = { failure: '✖', warning: '▲', achievement: '★', phase: '◆', info: '·', command: '⌘' };

export function EventLog({ events, onPick, max = 200 }: { events: SimEvent[]; onPick?: (t: number) => void; max?: number }) {
  const list = events.slice(-max);
  return (
    <ul className="events" aria-label="Event log">
      {list.map((e, i) => (
        <li key={i} className={`ev-${e.severity}`} onClick={() => onPick?.(e.t)} title={e.label}>
          <span className="t">{F.clock(e.t).slice(3)}</span>
          <span aria-label={e.severity}>{EV_SYM[e.severity] ?? '·'}</span>
          <span>{e.label}</span>
        </li>
      ))}
    </ul>
  );
}

export function Instruments({ ctl }: { ctl: Controller }) {
  useStore(ctl.store, (s) => s.uiTick);
  const sc = useStore(ctl.store, (s) => s.scenario);
  const run = useStore(ctl.store, (s) => s.run);
  const events = useStore(ctl.store, (s) => s.events);
  const missionId = useStore(ctl.store, (s) => s.missionId);
  const snap = ctl.snapshot;
  const v = snap?.vehicle;
  const lims = limits(snap, sc);
  const top = lims[0];
  const mission = missionId ? MISSIONS.find((m) => m.id === missionId) : null;
  const fidelity = run.config?.fidelity ?? sc?.config.fidelity;

  if (!snap) {
    const d = sc?.derived;
    return (
      <div>
        <div className="inst">
          <h3>Ready</h3>
          <p className="dim" style={{ margin: 0 }}>
            Configure on the left, check the preflight list, then <b>Launch</b>. Instruments come alive during the run; the prediction below uses the same solver.
          </p>
        </div>
        {d && (
          <div className="inst">
            <h3>Design consequences</h3>
            <dl className="kv">
              <dt>Rotor speed at release</dt><dd>{F.num(d.rpm, 1)} rpm</dd>
              <dt>Centripetal load</dt><dd>{F.num(d.aRadialG, 0)} g</dd>
              <dt>Wet mass / tip mass</dt><dd>{F.mass(d.wetMass)} / {F.mass(d.tipMass)}</dd>
              <dt>Vehicle KE at release</dt><dd>{F.energy(d.vehicleKE)}</dd>
              <dt>Rotor KE at release</dt><dd>{F.energy(d.rotorKE)}</dd>
              <dt>Spin-up (estimate)</dt><dd>{F.duration(d.spinupTimeEstimate)}</dd>
              <dt>Electrical energy (est.)</dt><dd>{F.energy(d.spinupEnergyEstimate)}</dd>
              <dt>Ballistic coefficient</dt><dd>{F.num(d.ballisticCoefficient, 0)} kg/m²</dd>
              <dt>Ideal Δv (upper stage)</dt><dd>{d.idealDeltaV ? `${F.num(d.idealDeltaV, 0)} m/s` : '—'}</dd>
              <dt>Cost per launch</dt><dd>{F.credits(d.costs.perLaunch)}</dd>
            </dl>
          </div>
        )}
        {mission && <MissionBox ctl={ctl} />}
      </div>
    );
  }

  return (
    <div>
      <div className="inst">
        <h3>
          {F.PHASE_LABEL[snap.phase] ?? snap.phase}
          {run.playback.computeLimited && <span className="chip warn" style={{ padding: '0 5px' }}>▲ compute-limited</span>}
        </h3>
        {snap.rotor.attached ? (
          <div className="big-readout">
            <div><div className="v">{F.mps(snap.rotor.tipSpeed)}</div><div className="l">Tip speed</div></div>
            <div><div className="v">{F.num(snap.rotor.rpm, 1)}</div><div className="l">Rotor rpm</div></div>
            <div><div className="v">{F.num(snap.rotor.aRadialG, 0)} g</div><div className="l">Centripetal load</div></div>
            <div><div className="v">{F.pressure(snap.rotor.pressure)}</div><div className="l">Chamber pressure</div></div>
          </div>
        ) : v ? (
          <div className="big-readout">
            <div><div className="v">{F.km(v.altitude, 2)}</div><div className="l">Altitude</div></div>
            <div><div className="v">{F.speed(v.vAir)}</div><div className="l">Air-relative speed</div></div>
            <div><div className="v">{F.num(v.mach, 2)}</div><div className="l">Mach</div></div>
            <div><div className="v">{F.km(v.downrange, 1)}</div><div className="l">Downrange</div></div>
          </div>
        ) : null}
      </div>

      {snap.rotor.attached ? (
        <div className="inst">
          <h3>Drive & energy <button className="inspect" onClick={() => ctl.store.set({ inspector: 'rotor' })} aria-label="Inspect rotor model">ⓘ</button></h3>
          <dl className="kv">
            <dt>Electrical power</dt><dd>{F.power(snap.rotor.powerElec)}</dd>
            <dt>Motor torque</dt><dd>{F.num(snap.rotor.torque / 1e3, 1)} kN·m</dd>
            <dt>Electrical energy so far</dt><dd>{F.energy(snap.rotor.eElec)}</dd>
            <dt>Arm stress / threshold</dt><dd className={snap.rotor.stressRatio > 1 / (sc?.config.launcher.structure.safetyFactor ?? 1.5) ? 'limit' : ''}>{F.num(snap.rotor.stressRatio * 100, 1)}%</dd>
            <dt>Felt lateral load (worst phase)</dt><dd>{F.num(snap.rotor.lateralLoadG, 0)} g</dd>
          </dl>
        </div>
      ) : v ? (
        <>
          <div className="inst">
            <h3>Loads & aerodynamics <button className="inspect" onClick={() => ctl.store.set({ inspector: 'aero' })} aria-label="Inspect aerodynamics model">ⓘ</button></h3>
            <dl className="kv">
              <dt>Dynamic pressure</dt><dd>{F.pressure(v.qDyn)}</dd>
              <dt>Proper accel. axial / lateral</dt><dd>{F.g(v.axialG)} / {F.g(v.lateralG)}</dd>
              <dt>Payload lateral</dt><dd>{F.g(v.payloadLateralG)}</dd>
              <dt>Angle of attack</dt><dd className={v.aeroFlags & AERO_FLAG_HIGH_ALPHA ? 'limit' : ''}>{F.num(v.alphaDeg, 2)}°</dd>
              <dt>Static margin</dt><dd className={v.stabilityCal < 0 && v.qDyn > 0 ? 'bad' : ''}>{v.qDyn > 0 ? `${F.num(v.stabilityCal, 2)} cal` : '—'}</dd>
              <dt>Body rates</dt><dd>{F.num(Math.hypot(...v.omegaBody), 3)} rad/s</dd>
            </dl>
            {(v.aeroFlags & (AERO_FLAG_RAREFIED | AERO_FLAG_FINENESS)) !== 0 && <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>▲ {v.aeroFlags & AERO_FLAG_RAREFIED ? 'Rarefied flow: coefficients bridged to free-molecular (approximate). ' : ''}{v.aeroFlags & AERO_FLAG_FINENESS ? 'Fineness outside table domain. ' : ''}</div>}
            <div className="faint" style={{ fontSize: 11 }}>A freely falling vehicle feels ~0 g: proper acceleration excludes gravity.</div>
          </div>
          <div className="inst">
            <h3>Heating <button className="inspect" onClick={() => ctl.store.set({ inspector: 'thermal' })} aria-label="Inspect thermal model">ⓘ</button></h3>
            <dl className="kv">
              <dt>Stagnation heat flux</dt><dd>{F.flux(v.heatFlux)}</dd>
              <dt>Stagnation heat load</dt><dd>{F.num(v.heatLoad / 1e6, 2)} MJ/m²</dd>
              <dt>Nose surface</dt><dd>{v.aeroshell ? F.kelvin(v.temps[0]) : 'jettisoned'}</dd>
              <dt>Body skin</dt><dd>{v.aeroshell ? F.kelvin(v.temps[2]) : 'jettisoned'}</dd>
              <dt>Payload bay</dt><dd>{F.kelvin(v.temps[3])}</dd>
            </dl>
            {(v.heatFlags & (THERMAL_FLAG_LOW_SPEED | THERMAL_FLAG_RAREFIED)) !== 0 && v.heatFlux > 0 && <div className="faint" style={{ fontSize: 11 }}>▲ {v.heatFlags & THERMAL_FLAG_LOW_SPEED ? 'Below the hypersonic correlation domain: limited thermal fidelity. ' : ''}{v.heatFlags & THERMAL_FLAG_RAREFIED ? 'Rarefied: bounded by free-molecular flux.' : ''}</div>}
          </div>
          <div className="inst">
            <h3>Propulsion & orbit <button className="inspect" onClick={() => ctl.store.set({ inspector: 'orbit' })} aria-label="Inspect orbit model">ⓘ</button></h3>
            <dl className="kv">
              <dt>Mass</dt><dd>{F.mass(v.mass)}</dd>
              <dt>Thrust</dt><dd>{v.engineOn ? F.force(v.thrust) : 'off'}</dd>
              {sc && sc.stages.length > 0 && (<><dt>Stage {v.activeStage + 1} propellant</dt><dd>{F.mass(v.propellant)}</dd></>)}
              {sc && sc.vehicle.rcs.propellant > 0 && (<><dt>RCS propellant</dt><dd>{F.num(v.rcs, 2)} kg</dd></>)}
              <dt>Inertial speed</dt><dd>{F.speed(v.vInertial)}</dd>
              <dt>Periapsis</dt><dd className={v.orbit.periapsisAltitude < 0 ? 'bad' : ''}>{F.km(v.orbit.periapsisAltitude)}</dd>
              <dt>Apoapsis</dt><dd>{v.orbit.bound ? F.km(v.orbit.apoapsisAltitude) : '∞ (unbound)'}</dd>
              <dt>Inclination</dt><dd>{v.orbit.inclination === null ? '—' : F.deg(v.orbit.inclination, 2)}</dd>
            </dl>
            <div style={{ fontSize: 12, marginTop: 4 }} className={v.orbit.bound && !v.orbit.intersectsEarth ? 'ev-achievement' : 'dim'}>
              {orbitLabel(v)}
            </div>
          </div>
        </>
      ) : null}

      <div className="inst">
        <h3>Limiting constraint</h3>
        {top ? (
          <div className="limiting">
            <b>{top.ratio >= 1 ? '✖' : top.ratio >= 0.8 ? '▲' : '●'} {top.label}</b>
            <div className="mono">{F.num(top.value, 1)} of {F.num(top.limit, 1)} {top.unit}</div>
          </div>
        ) : <div className="dim">—</div>}
        <div style={{ marginTop: 6 }}>{lims.slice(0, 5).map((l) => <Meter key={l.label} l={l} />)}</div>
        {fidelity === 'assisted' && <div className="chip warn" style={{ marginTop: 6 }}>▲ Assisted attitude: orientation is prescribed (no moments). Records kept separate.</div>}
      </div>
      {mission && <MissionBox ctl={ctl} />}
      <div className="inst">
        <h3>Event log</h3>
        <EventLog events={events.slice(-14)} onPick={(t) => ctl.store.set({ cursorTime: t })} />
      </div>
    </div>
  );
}

export function orbitLabel(v: NonNullable<Snapshot['vehicle']>): string {
  const o = v.orbit;
  const above = v.altitude >= 100_000 ? 'Above 100 km; ' : '';
  if (!o.bound) return `${above}Escape (hyperbolic) trajectory`;
  if (o.intersectsEarth) return `${above}Earth-intersecting trajectory (not an orbit)`;
  return `Bound orbit ${F.num(o.periapsisAltitude / 1000, 0)} × ${F.num(o.apoapsisAltitude / 1000, 0)} km`;
}

function MissionBox({ ctl }: { ctl: Controller }) {
  const missionId = useStore(ctl.store, (s) => s.missionId);
  const res = useStore(ctl.store, (s) => s.run.missionResult);
  const m = MISSIONS.find((x) => x.id === missionId);
  if (!m) return null;
  return (
    <div className="inst">
      <h3>Mission {m.index}: {m.name}</h3>
      <div className="dim" style={{ fontSize: 12 }}>{m.brief}</div>
      <ul className="issue-list" style={{ marginTop: 6 }}>
        {(res?.objectives ?? m.constraints.map((c, i) => ({ id: String(i), label: c, passed: null as unknown as boolean, detail: '' }))).map((o) => (
          <li key={o.id}>
            <span className={o.passed === true ? 'sym-ok' : o.passed === false ? 'sym-error' : 'faint'}>{o.passed === true ? '✔' : o.passed === false ? '✖' : '○'}</span>
            <span>{o.label}{o.detail ? <span className="faint"> — {o.detail}</span> : null}</span>
          </li>
        ))}
      </ul>
      {res && <div style={{ marginTop: 4, fontWeight: 600 }} className={res.passed ? 'ev-achievement' : 'ev-failure'}>{res.passed ? `★ Mission passed${res.score !== null ? ` · ${res.scoreLabel}: ${F.num(res.score, 2)}` : ''}` : '✖ Mission not passed'}</div>}
    </div>
  );
}

void G0;
