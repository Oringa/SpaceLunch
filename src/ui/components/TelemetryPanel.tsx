import { useState } from 'react';
import type { Controller } from '../controller';
import { useStore } from '../store';
import { Plot, type PlotSeries } from './Plot';
import { EventLog } from './Instruments';
import * as F from '../format';
import type { Extrema } from '../../sim/session';

interface ChannelDef {
  id: string;
  title: string;
  unit: string;
  scale: number;
  channels: Array<{ ch: string; label: string; color?: string }>;
  table: 'flight' | 'rotor';
  peak?: (x: Extrema) => string;
  log?: boolean;
}

export const CHANNELS: ChannelDef[] = [
  { id: 'alt', title: 'Altitude', unit: 'km', scale: 1e-3, channels: [{ ch: 'alt', label: 'altitude' }], table: 'flight', peak: (x) => `apogee ${F.km(x.maxAltitude.value)}` },
  { id: 'vAir', title: 'Air-relative speed', unit: 'm/s', scale: 1, channels: [{ ch: 'vAir', label: 'v_air' }], table: 'flight' },
  { id: 'accel', title: 'Proper acceleration', unit: 'g', scale: 1, channels: [{ ch: 'axialG', label: 'axial' }, { ch: 'lateralG', label: 'lateral', color: '#c58cff' }], table: 'flight', peak: (x) => `peak ${F.g(x.maxAxialG.value)} ax / ${F.g(x.maxLateralG.value)} lat` },
  { id: 'q', title: 'Dynamic pressure', unit: 'kPa', scale: 1e-3, channels: [{ ch: 'q', label: 'q' }], table: 'flight', peak: (x) => `max ${F.pressure(x.maxQ.value)}` },
  { id: 'heatFlux', title: 'Stagnation heat flux', unit: 'MW/m²', scale: 1e-6, channels: [{ ch: 'heatFlux', label: 'q_s' }], table: 'flight', peak: (x) => `max ${F.flux(x.maxHeatFlux.value)}` },
  { id: 'heatLoad', title: 'Stagnation heat load', unit: 'MJ/m²', scale: 1e-6, channels: [{ ch: 'heatLoad', label: 'Q' }], table: 'flight' },
  { id: 'temps', title: 'Temperatures (model nodes)', unit: 'K', scale: 1, channels: [{ ch: 'T1', label: 'nose surface' }, { ch: 'T3', label: 'body', color: '#6fd3c4' }, { ch: 'T4', label: 'payload bay', color: '#c58cff' }], table: 'flight', peak: (x) => `nose max ${F.kelvin(x.maxT1.value)}` },
  { id: 'prop', title: 'Propellant (active stage)', unit: 'kg', scale: 1, channels: [{ ch: 'prop', label: 'propellant' }], table: 'flight' },
  { id: 'alpha', title: 'Angle of attack', unit: '°', scale: 1, channels: [{ ch: 'alphaDeg', label: 'α' }], table: 'flight' },
  { id: 'orbit', title: 'Osculating periapsis / apoapsis', unit: 'km', scale: 1e-3, channels: [{ ch: 'peri', label: 'periapsis' }, { ch: 'apo', label: 'apoapsis', color: '#6fd3c4' }], table: 'flight' },
  { id: 'clearance', title: 'Exit-corridor clearance', unit: 'cm', scale: 100, channels: [{ ch: 'clearance', label: 'clearance' }], table: 'flight', peak: (x) => `min ${F.length(x.minClearance.value)}` },
  { id: 'tip', title: 'Rotor tip speed', unit: 'm/s', scale: 1, channels: [{ ch: 'tipSpeed', label: 'v_tip' }], table: 'rotor' },
  { id: 'power', title: 'Electrical power', unit: 'MW', scale: 1e-6, channels: [{ ch: 'powerElec', label: 'P' }], table: 'rotor', peak: (x) => `max ${F.power(x.maxElectricalPower.value)}` },
  { id: 'energy', title: 'Energy: electrical / rotor KE', unit: 'MWh', scale: 1 / 3.6e9, channels: [{ ch: 'eElec', label: 'electrical' }, { ch: 'rotorKE', label: 'rotor KE', color: '#6fd3c4' }, { ch: 'eGas', label: 'gas loss', color: '#ff6b6b' }], table: 'rotor' },
  { id: 'stress', title: 'Arm stress / threshold', unit: '%', scale: 100, channels: [{ ch: 'stressRatio', label: 'σ/σ_ult' }], table: 'rotor' },
  { id: 'pressure', title: 'Chamber pressure', unit: 'Pa (log)', scale: 1, channels: [{ ch: 'pressure', label: 'p' }], table: 'rotor', log: true },
];

const EV_COLOR: Record<string, string> = { failure: '#ff6b6b', warning: '#f2c14e', achievement: '#5fd38d', phase: '#8ab4f8', command: '#ffb454' };

export function TelemetryPanel({ ctl }: { ctl: Controller }) {
  useStore(ctl.store, (s) => s.uiTick);
  const open = useStore(ctl.store, (s) => s.bottomOpen);
  const sel = useStore(ctl.store, (s) => s.plotChannels);
  const plotAuto = useStore(ctl.store, (s) => s.plotAuto);
  const cursor = useStore(ctl.store, (s) => s.cursorTime);
  const pred = useStore(ctl.store, (s) => s.prediction);
  const ghosts = useStore(ctl.store, (s) => s.ghosts);
  const overlays = useStore(ctl.store, (s) => s.overlays);
  const events = useStore(ctl.store, (s) => s.events);
  const run = useStore(ctl.store, (s) => s.run);
  const [xMode, setXMode] = useState<'release' | 'start'>('release');
  const live = run.status !== 'idle';
  const liveFlight = live && ctl.flightTable.length > 0 ? ctl.flightTable : null;
  const liveRotor = live && ctl.rotorTable.length > 0 ? ctl.rotorTable : null;
  const relT = (live ? run.summary?.release?.t ?? (liveFlight ? liveFlight.get('t', 0) : undefined) : undefined) ?? pred.summary?.release?.t ?? 0;
  const extrema = run.summary?.extrema ?? (live ? undefined : pred.summary?.extrema);
  const evList = live ? events : pred.events ?? [];

  const toggle = (id: string): void => {
    const cur = ctl.store.get().plotChannels;
    ctl.store.set({ plotChannels: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id], plotAuto: false });
  };
  const download = (which: 'flight' | 'rotor' | 'prediction'): void => {
    const csv = ctl.exportTelemetryCSV(which);
    if (!csv) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `centrifuge-${which}-telemetry.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="bottom" style={open ? { height: 'var(--bottom-h)' } : undefined}>
      <div className="bottom-head">
        <button className="btn small icon" onClick={() => ctl.store.set({ bottomOpen: !open })} aria-expanded={open} aria-label="Toggle telemetry panel">{open ? '▾' : '▴'}</button>
        <b style={{ fontSize: 12 }}>Telemetry</b>
        <span className="faint" style={{ fontSize: 11 }}>{live ? 'live run' : pred.status === 'done' ? 'prediction' : ''}{cursor !== null ? ` · cursor T${cursor - relT >= 0 ? '+' : ''}${F.num(cursor - relT, 3)} s` : ''}</span>
        <div className="spacer" />
        {open && (
          <>
            <label className="toggle" style={{ fontSize: 11.5 }} title="Plots follow the phase: rotor channels before release, flight channels after">
              <input type="checkbox" checked={plotAuto} onChange={(e) => ctl.store.set({ plotAuto: e.target.checked })} /> auto channels
            </label>
            <div className="seg" role="group" aria-label="Time axis">
              <button aria-pressed={xMode === 'release'} onClick={() => setXMode('release')}>t − release</button>
              <button aria-pressed={xMode === 'start'} onClick={() => setXMode('start')}>t − start</button>
            </div>
            <button className="btn small" onClick={() => download(live ? 'flight' : 'prediction')} title="Export flight telemetry as CSV">CSV flight</button>
            <button className="btn small" onClick={() => download('rotor')} disabled={!liveRotor} title="Export rotor telemetry as CSV">CSV rotor</button>
          </>
        )}
      </div>
      {open && (
        <div className="bottom-body">
          <div style={{ display: 'grid', gridTemplateRows: 'auto 1fr', minHeight: 0 }}>
            <div className="channel-picker" style={{ padding: '4px 6px' }}>
              {CHANNELS.map((c) => (
                <label key={c.id}><input type="checkbox" checked={sel.includes(c.id)} onChange={() => toggle(c.id)} />{c.title}</label>
              ))}
            </div>
            <div className="plots">
              {CHANNELS.filter((c) => sel.includes(c.id)).map((c) => {
                const series: PlotSeries[] = [];
                const t0 = c.table === 'rotor' || xMode === 'start' ? 0 : relT;
                if (c.table === 'flight') {
                  if (overlays.ghosts) for (const g of ghosts) for (const s of c.channels) series.push({ table: g.flight, channel: s.ch, color: g.color, label: g.label, width: 1 });
                  if (overlays.predicted && pred.flight) for (const s of c.channels) series.push({ table: pred.flight, channel: s.ch, color: '#4cc9f0', dashed: true, label: 'prediction', width: 1.2 });
                  for (const s of c.channels) series.push({ table: liveFlight, channel: s.ch, color: s.color ?? '#ffb454', label: s.label, width: 1.8 });
                } else {
                  if (!live && pred.rotor) for (const s of c.channels) series.push({ table: pred.rotor, channel: s.ch, color: s.color ?? '#4cc9f0', dashed: true, label: 'prediction' });
                  for (const s of c.channels) series.push({ table: liveRotor, channel: s.ch, color: s.color ?? '#ffb454', label: s.label });
                }
                return (
                  <Plot
                    key={c.id}
                    title={`${c.title}${c.channels.length > 1 ? ` (${c.channels.map((x) => x.label).join(', ')})` : ''}`}
                    unit={c.unit}
                    scale={c.scale}
                    series={series}
                    t0={t0}
                    xLabel={c.table === 'rotor' || xMode === 'start' ? 's from start' : 's after release'}
                    cursor={cursor}
                    onCursor={(t) => ctl.store.set({ cursorTime: t })}
                    events={evList.filter((e) => EV_COLOR[e.severity]).map((e) => ({ t: e.t, color: EV_COLOR[e.severity] }))}
                    peak={c.peak && extrema ? c.peak(extrema) : undefined}
                    log={c.log}
                  />
                );
              })}
            </div>
          </div>
          <div className="log-pane">
            <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>Events {live ? '(live)' : '(predicted)'} — click to place the cursor</div>
            <EventLog events={evList} onPick={(t) => ctl.store.set({ cursorTime: t })} />
          </div>
        </div>
      )}
    </div>
  );
}
