import type { Controller, Tab } from '../controller';
import { useStore } from '../store';
import * as F from '../format';
import { MISSIONS } from '../../game/missions';

const RATES = [0.001, 0.01, 0.1, 1, 10, 100, 1000];

export function Header({ ctl, onDrawer }: { ctl: Controller; onDrawer: (which: 'left' | 'right') => void }) {
  useStore(ctl.store, (s) => s.uiTick);
  const tab = useStore(ctl.store, (s) => s.tab);
  const run = useStore(ctl.store, (s) => s.run);
  const missionId = useStore(ctl.store, (s) => s.missionId);
  const snap = ctl.snapshot;
  const live = run.status === 'live' || run.status === 'starting';
  const relT = snap?.vehicle && run.summary?.release ? run.summary.release.t : undefined;
  const pb = run.playback;
  const setTab = (t: Tab): void => ctl.store.set({ tab: t });
  return (
    <header className="header">
      <button className="btn icon drawer-toggle" onClick={() => onDrawer('left')} aria-label="Open configuration">☰</button>
      <div className="brand"><b>CENTRIFUGE</b><span>kinetic-launch engineering</span></div>
      <select
        aria-label="Mission"
        value={missionId ?? ''}
        onChange={(e) => {
          const id = e.target.value || null;
          ctl.store.set({ missionId: id, mode: id ? 'missions' : 'sandbox' });
          const m = MISSIONS.find((x) => x.id === id);
          if (m && run.status !== 'live') ctl.loadDesign(m.referenceDesign);
        }}
        style={{ background: 'var(--panel-2)', border: '1px solid var(--line-strong)', borderRadius: 6, padding: '4px 6px', maxWidth: 230 }}
        disabled={live}
      >
        <option value="">Sandbox</option>
        {MISSIONS.map((m) => <option key={m.id} value={m.id}>Mission {m.index}: {m.name}</option>)}
      </select>
      <div className="tabs" role="tablist" aria-label="Workspace">
        {(['build', 'flight', 'analysis'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t === 'build' ? 'Build' : t === 'flight' ? 'Flight' : 'Analysis'}</button>
        ))}
      </div>
      <div className="spacer" />
      {run.status !== 'idle' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn icon" onClick={() => ctl.setPlayback(!pb.playing, pb.auto ? { auto: true } : { auto: false, rate: pb.rate })} aria-label={pb.playing ? 'Pause (Space)' : 'Play (Space)'} title={pb.playing ? 'Pause (Space)' : 'Play (Space)'} disabled={run.status === 'rejected'}>{pb.playing ? '❚❚' : '▶'}</button>
          <div className="seg" role="group" aria-label="Playback rate">
            <button aria-pressed={pb.auto} onClick={() => ctl.setPlayback(true, { auto: true })} title="Automatic time compression: fast through pump-down, spin-up and long coasts; slow through release. Physics is unchanged.">Auto {pb.auto ? F.rate(pb.rate) : ''}</button>
            <select aria-label="Fixed playback rate" value={pb.auto ? '' : String(pb.rate)} onChange={(e) => e.target.value && ctl.setPlayback(true, { auto: false, rate: Number(e.target.value) })} style={{ background: 'var(--panel-2)', border: 0, padding: '0 4px' }}>
              <option value="">fixed…</option>
              {RATES.map((r) => <option key={r} value={r}>{F.rate(r)}</option>)}
            </select>
          </div>
          <button className="btn small" onClick={() => ctl.skipTo('release')} disabled={!live || !!snap?.vehicle} title="Fast-forward to just before release (integrates all intervening physics)">⏭ release</button>
          <button className="btn small" onClick={() => ctl.skipTo('end')} disabled={!live} title="Integrate to the end of the run">⏭ end</button>
          <button className="btn small danger" onClick={() => ctl.command('abort')} disabled={!live} title="Abort: stop the drive (or terminate the flight)">Abort</button>
          {ctl.store.get().run.config?.launcher.release.mode === 'manual-training' && !snap?.vehicle && (
            <button className="btn small" onClick={() => ctl.command('release')} disabled={!live} title="Manual release (training). Latency is not compensated.">Release!</button>
          )}
          <button className="btn small" onClick={() => ctl.reset()} title="Reset to build (R)">Reset</button>
        </div>
      )}
      <div className="clock" aria-live="off">
        <span className="t" title="Physical (simulated) time since pump-down start">{F.clock(snap?.t ?? 0)}</span>
        <span className="p">
          {snap ? F.PHASE_LABEL[snap.phase] : 'Build'}
          {relT !== undefined && snap ? ` · T+${F.duration(snap.t - relT)}` : ''}
        </span>
      </div>
      <button className="btn small" onClick={() => ctl.setUiMode('play')} title="Game view: missions, stars, simple controls (E)">▶ Play mode</button>
      <button className="btn icon" onClick={() => ctl.store.set({ helpOpen: true })} aria-label="Help (?)" title="Help, model scope and sources (?)">?</button>
      <button className="btn icon drawer-toggle" onClick={() => onDrawer('right')} aria-label="Open instruments">⌁</button>
    </header>
  );
}
