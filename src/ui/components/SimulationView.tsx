import { useEffect, useRef, useState } from 'react';
import type { Controller } from '../controller';
import { useStore } from '../store';
import { createRenderer } from '../../rendering';
import type { Renderer, RenderSource } from '../../rendering/types';
import type { ViewKind } from '../controller';
import { GroundMap } from '../map/GroundMap';
import * as F from '../format';
import { missionById } from '../../game/missions';

function makeSource(ctl: Controller, variant: 'engineer' | 'play'): RenderSource {
  return {
    variant: () => variant,
    insets: () => {
      if (variant !== 'play') return { top: 40, bottom: 0, left: 0, right: 0 };
      const st = ctl.store.get();
      const live = st.run.status === 'live' || st.run.status === 'starting';
      if (live) return { top: 90, bottom: 80, left: 180, right: 0 };
      if (st.showHome) return { top: 0, bottom: 0, left: 0, right: 0 };
      return { top: 60, bottom: 300, left: 0, right: 0 };
    },
    goalAltitude: () => {
      const m = ctl.store.get().missionId;
      return m ? missionById(m)?.goalAltitude ?? null : null;
    },
    snapshot: () => ctl.snapshot,
    scenario: () => {
      const st = ctl.store.get();
      return st.scenario;
    },
    flown: () => (ctl.store.get().run.status === 'idle' ? null : ctl.flightTable),
    predicted: () => (ctl.store.get().overlays.predicted ? ctl.store.get().prediction.flight ?? null : null),
    ghosts: () => (ctl.store.get().overlays.ghosts ? ctl.store.get().ghosts.map((g) => ({ table: g.flight, color: g.color, label: g.label })) : []),
    // The map is drawn by the UI layer; the 3D renderer is paused behind it.
    view: () => { const v = ctl.store.get().view; return v === 'map' ? 'world' : v; },
    overlays: () => ctl.store.get().overlays,
    cursorTime: () => ctl.store.get().cursorTime,
    reducedMotion: () => ctl.store.get().reducedMotion,
    orbitBand: () => {
      const m = ctl.store.get().missionId;
      return m === 'm4-leo' || m === 'm5-optimise' ? { periapsisMin: 200_000, apoapsisMax: 1_000_000 } : null;
    },
  };
}

const VIEWS: Array<{ id: ViewKind; label: string; key: string; hint: string }> = [
  { id: 'launcher', label: 'Launcher', key: '1', hint: 'Centrifuge cutaway: arm, vehicle, exit port' },
  { id: 'world', label: 'World', key: '2', hint: 'The launch seen from afar over the curved Earth' },
  { id: 'orbit', label: 'Orbit', key: '3', hint: 'Inertial view: osculating trajectory, apsides, target band' },
  { id: 'map', label: 'Map', key: '4', hint: 'Ground track on a world map: landing point, range, nearby places' },
];

export function SimulationView({ ctl, variant = 'engineer' }: { ctl: Controller; variant?: 'engineer' | 'play' }) {
  useStore(ctl.store, (s) => s.uiTick);
  const view = useStore(ctl.store, (s) => s.view);
  const overlays = useStore(ctl.store, (s) => s.overlays);
  const run = useStore(ctl.store, (s) => s.run);
  const missionId = useStore(ctl.store, (s) => s.missionId);
  const mapOpen = useStore(ctl.store, (s) => s.mapOpen);
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<Renderer | null>(null);
  const [kind, setKind] = useState<string>('');
  useEffect(() => {
    if (!host.current) return;
    const r = createRenderer(host.current, makeSource(ctl, variant));
    renderer.current = r;
    setKind(r.kind);
    r.start();
    return () => {
      r.dispose();
      renderer.current = null;
    };
  }, [ctl, variant]);
  useEffect(() => {
    if (view !== 'map') renderer.current?.resetCamera();
  }, [view]);
  // Pause the 3D renderer while the map covers it.
  const covered = (variant === 'engineer' && view === 'map') || (variant === 'play' && mapOpen);
  useEffect(() => {
    if (covered) renderer.current?.stop();
    else renderer.current?.start();
  }, [covered]);
  const snap = ctl.snapshot;
  const rel = run.summary?.release?.t;
  const relT = snap?.vehicle ? (rel ?? (ctl.flightTable.length ? ctl.flightTable.get('t', 0) : undefined)) : undefined;
  const inRelease = snap && (snap.phase === 'hold' || snap.phase === 'corridor' || (snap.phase === 'flight' && relT !== undefined && snap.t - relT < 1.5));
  const fidelity = (run.config ?? ctl.store.get().config).fidelity;
  const mission = missionId ? missionById(missionId) : null;
  return (
    <div className="main">
      <div className="renderer-host" ref={host} aria-label={`Simulation view: ${view}`} role="img" style={covered ? { visibility: 'hidden' } : undefined} />
      {variant === 'engineer' && view === 'map' && <div className="map-view"><GroundMap ctl={ctl} /></div>}
      {variant === 'engineer' && <><div className="view-toolbar">
        <div className="seg" role="group" aria-label="View">
          {VIEWS.map((v) => (
            <button key={v.id} aria-pressed={view === v.id} onClick={() => ctl.store.set({ view: v.id })} title={`${v.hint} (${v.key})`}>{v.label}</button>
          ))}
        </div>
        {view !== 'map' && <button className="btn small" onClick={() => renderer.current?.resetCamera()} title="Re-centre camera">⌖ camera</button>}
        <div className="seg" role="group" aria-label="Overlays">
          {([['forces', 'vectors'], ['atmosphere', 'atmosphere'], ['predicted', 'prediction'], ['ghosts', 'ghosts'], ['labels', 'labels']] as const).map(([k, l]) => (
            <button key={k} aria-pressed={overlays[k]} onClick={() => ctl.store.set({ overlays: { ...overlays, [k]: !overlays[k] } })}>{l}</button>
          ))}
        </div>
        <span className="spacer" />
        {kind === 'canvas2d' && <span className="chip warn">▲ WebGL2 unavailable — 2D diagnostic view</span>}
        {mission && <span className="chip">Mission {mission.index}</span>}
        <span className={`chip${fidelity === 'assisted' ? ' warn' : ''}`} title={fidelity === 'engineering' ? 'Quaternion attitude + rigid-body dynamics with aero, TVC and RCS moments' : 'Prescribed attitude: idealised, records separate'}>
          {fidelity === 'engineering' ? 'Engineering (6-DOF)' : '▲ Assisted attitude (3-DOF)'}
        </span>
      </div>
      {snap?.failure && (
        <div className="chip bad" style={{ position: 'absolute', top: 48, left: 10, right: 10, zIndex: 6 }} role="alert">
          ✖ {snap.failure.message}
        </div>
      )}
      {inRelease && snap && view !== 'map' && (
        <div className="release-inset chip" aria-live="off">
          <div className="faint" style={{ fontSize: 11 }}>RELEASE · physical clock (playback slowed; physics unchanged)</div>
          <div className="ms">{relT !== undefined ? `T${snap.t - relT >= 0 ? '+' : '−'}${F.num(Math.abs(snap.t - relT) * 1000, 2)} ms` : 'awaiting release'}</div>
          <div className="faint" style={{ fontSize: 11 }}>
            {snap.vehicle ? `${F.mps(snap.vehicle.vAir)} · clearance ${Number.isFinite(snap.vehicle.clearance) ? F.length(snap.vehicle.clearance) : 'clear of tunnel'}` : `${F.num(snap.rotor.rpm, 1)} rpm · phase-locked`}
          </div>
        </div>
      )}
      {view !== 'map' && <div className="view-legend chip">
        <span><i style={{ background: '#ffb454' }} />flown (this run)</span>
        <span><i style={{ background: 'repeating-linear-gradient(90deg,#4cc9f0 0 5px,transparent 5px 9px)' }} />predicted (same solver)</span>
        <span className="faint">playback {F.rate(run.playback.rate)}{run.playback.auto ? ' auto' : ''}</span>
      </div>}</>}
    </div>
  );
}
