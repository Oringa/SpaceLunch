import { useEffect } from 'react';
import type { Controller } from '../controller';
import { useStore } from '../store';
import { modelById, MODELS, EXCLUSIONS } from '../../data/models';
import { sourceByKey, SOURCES } from '../../data/sources';
import { SourceBadge } from './ParamControl';
import { SOURCE_CLASS_LABEL } from '../../physics/provenance';

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <h2>{title}</h2>
          <button className="btn small" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Inspector({ ctl }: { ctl: Controller }) {
  const id = useStore(ctl.store, (s) => s.inspector);
  if (!id) return null;
  const m = modelById(id);
  const close = (): void => ctl.store.set({ inspector: null });
  if (!m) return null;
  return (
    <Modal title={m.title} onClose={close}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <SourceBadge cls={m.classification} /> <span className="dim">{SOURCE_CLASS_LABEL[m.classification]}</span>
        <span className="faint mono" style={{ marginLeft: 'auto', fontSize: 11 }}>{m.code}</span>
      </div>
      <h3>Equations</h3>
      {m.equations.map((e) => <div className="eq" key={e}>{e}</div>)}
      <h3>Assumptions</h3>
      <ul>{m.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
      <h3>Applicability</h3>
      <p style={{ margin: 0 }}>{m.applicability}</p>
      {m.sources.length > 0 && (
        <>
          <h3>Sources</h3>
          <ul>
            {m.sources.map((k) => {
              const s = sourceByKey(k);
              return <li key={k}>[{k}] {s?.url ? <a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--cyan)' }}>{s.title}</a> : s?.title} <span className="faint">— {s?.note}</span></li>;
            })}
          </ul>
        </>
      )}
      <h3>Other models</h3>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {MODELS.map((x) => <button key={x.id} className="btn small" aria-pressed={x.id === id} onClick={() => ctl.store.set({ inspector: x.id })}>{x.title}</button>)}
      </div>
    </Modal>
  );
}

export function Help({ ctl }: { ctl: Controller }) {
  const open = useStore(ctl.store, (s) => s.helpOpen);
  if (!open) return null;
  const close = (): void => ctl.store.set({ helpOpen: false });
  return (
    <Modal title="CENTRIFUGE — how it works" onClose={close}>
      <p>
        A kinetic-launch engineering sandbox. A centrifuge spins a vehicle up inside a vacuum chamber and releases it at the
        integrated rotor phase through an exit tunnel; for orbit, an onboard upper stage must then add horizontal speed. Every reading,
        outcome and failure comes from a reduced-order double-precision simulation running in Web Workers.
      </p>
      <h3>Loop</h3>
      <p style={{ margin: 0 }}>Configure → predict (same solver) → launch → watch spin-up, release and flight → read the autopsy → change one cause → compare.</p>
      <h3>Keyboard</h3>
      <ul>
        <li><span className="kbd">L</span> launch · <span className="kbd">Space</span> play/pause · <span className="kbd">R</span> reset</li>
        <li><span className="kbd">1</span> launcher view · <span className="kbd">2</span> world view · <span className="kbd">3</span> orbit view</li>
        <li><span className="kbd">B</span>/<span className="kbd">F</span>/<span className="kbd">A</span> Build / Flight / Analysis · <span className="kbd">?</span> help · <span className="kbd">Esc</span> close</li>
      </ul>
      <h3>Information classes</h3>
      <div style={{ display: 'grid', gap: 4 }}>
        {(['physical-law', 'published-reference', 'engineering-approximation', 'fictional-game-hardware'] as const).map((c) => (
          <div key={c}><SourceBadge cls={c} /> {SOURCE_CLASS_LABEL[c]}</div>
        ))}
      </div>
      <h3>Fidelity modes</h3>
      <p style={{ margin: 0 }}>
        <b>Engineering</b> integrates translation in an Earth-centred inertial frame plus quaternion attitude and Euler's rigid-body
        equation with aerodynamic, thrust-vector and reaction-control moments. <b>Assisted</b> prescribes attitude (zero angle of
        attack, instant thrust pointing); its idealisation is labelled and its records are separate.
      </p>
      <h3>Honest scope</h3>
      <p style={{ margin: 0 }}>
        Inspired by kinetic-launch concepts; <b>not</b> a validated digital twin of SpinLaunch or any real system. Public scale references
        (a proposed 100 m chamber and up to 8,000 km/h release with onboard propulsion; a separate 33 m suborbital system) are used only for
        scale. Reaching 100 km and entering orbit are separate achievements: orbit requires a bound trajectory validated by forward
        propagation.
      </p>
      <h3>Not modelled in this release</h3>
      <ul>{EXCLUSIONS.map((e) => <li key={e}>{e}</li>)}</ul>
      <h3>Sources</h3>
      <ul>{SOURCES.map((s) => <li key={s.key}>[{s.key}] {s.url ? <a href={s.url} target="_blank" rel="noreferrer" style={{ color: 'var(--cyan)' }}>{s.title}</a> : s.title}</li>)}</ul>
      <p className="faint" style={{ fontSize: 11 }}>Costs are fictional game credits. Configurations, records and preferences are stored only in this browser.</p>
    </Modal>
  );
}
