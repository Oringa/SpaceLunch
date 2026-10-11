/** Play-mode map pieces: mini-map card, full-screen map overlay, results line. */
import { useEffect } from 'react';
import type { Controller } from '../controller';
import { useStore } from '../store';
import { GroundMap, useTrackEnds, useWorld } from './GroundMap';
import { endHeadline, endNear, type TrackEnd } from './landing';

function useCaption(ctl: Controller): { title: string; main: string; sub: string; tone: 'fc' | 'live' | 'done' | 'wait' } {
  const world = useWorld();
  const { forecast, actual, scene } = useTrackEnds(ctl, world);
  const pred = useStore(ctl.store, (s) => s.prediction);
  const configVersion = useStore(ctl.store, (s) => s.configVersion);
  if (scene.finished) {
    if (!actual) return { title: 'Ground track', main: 'No flight: the vehicle never left the machine', sub: '', tone: 'done' };
    return { title: 'Where it ended', main: endHeadline(actual, false), sub: endNear(actual), tone: 'done' };
  }
  if (scene.live) {
    const fc = forecast && forecast.kind !== 'running' ? `Forecast: ${lower(endHeadline(forecast, true))}` : '';
    if (!actual) return { title: 'Ground track', main: 'Waiting for release…', sub: fc, tone: 'live' };
    return { title: 'Ground track · live', main: endHeadline(actual, false), sub: fc || endNear(actual), tone: 'live' };
  }
  if (pred.status === 'running' || pred.configVersion !== configVersion) return { title: 'Landing forecast', main: 'Forecasting…', sub: '', tone: 'wait' };
  if (!forecast) return { title: 'Landing forecast', main: pred.status === 'done' ? 'No flight in the forecast: it fails before release' : 'Forecast unavailable', sub: '', tone: 'wait' };
  return { title: 'Landing forecast', main: endHeadline(forecast, true), sub: endNear(forecast), tone: 'fc' };
}

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** Small map card: top-right while designing, bottom-right while flying. */
export function MiniMap({ ctl, where }: { ctl: Controller; where: 'design' | 'flight' }) {
  const cap = useCaption(ctl);
  const open = (): void => ctl.store.set({ mapOpen: true });
  return (
    <div className={`minimap ${where}`}>
      <div className="minimap-head">
        <span>{cap.title}</span>
        <button className="minimap-expand" onClick={open} aria-label="Open the full map" title="Open the full map (M)">⤢</button>
      </div>
      <div className="minimap-map"><GroundMap ctl={ctl} compact onExpand={open} /></div>
      <div className={`minimap-cap ${cap.tone}`} aria-live="polite">
        <div>{cap.main}</div>
        {cap.sub && <small>{cap.sub}</small>}
      </div>
    </div>
  );
}

/** Full-screen interactive map. */
export function MapOverlay({ ctl }: { ctl: Controller }) {
  const open = useStore(ctl.store, (s) => s.mapOpen);
  const cap = useCaption(ctl);
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') ctl.store.set({ mapOpen: false });
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, ctl]);
  if (!open) return null;
  return (
    <div className="map-overlay" role="dialog" aria-modal="true" aria-label="World map">
      <div className="map-overlay-head">
        <div>
          <div className="map-overlay-title">{cap.title}</div>
          <div className={`map-overlay-main ${cap.tone}`}>{cap.main}</div>
          {cap.sub && <div className="map-overlay-sub">{cap.sub}</div>}
        </div>
        <div className="map-overlay-side">
          <span className="map-overlay-hint">Scroll to zoom · drag to pan · double-click to fit</span>
          <button className="btn" onClick={() => ctl.store.set({ mapOpen: false })} aria-label="Close map" autoFocus>Close ✕</button>
        </div>
      </div>
      <div className="map-overlay-map"><GroundMap ctl={ctl} /></div>
    </div>
  );
}

/** One line for the results card, with a button to the map. */
export function LandingLine({ ctl }: { ctl: Controller }) {
  const world = useWorld();
  const { actual } = useTrackEnds(ctl, world);
  if (!actual) return null;
  return (
    <div className="landing-line">
      <span className="landing-pin" aria-hidden>{icon(actual)}</span>
      <span>
        <b>{endHeadline(actual, false)}</b>
        {endNear(actual) && <small> · {endNear(actual)}</small>}
      </span>
      <button className="btn small" onClick={() => ctl.store.set({ mapOpen: true })}>See it on the map</button>
    </div>
  );
}

const icon = (e: TrackEnd): string => (e.kind === 'orbit' ? '🛰' : e.kind === 'lost' ? '✖' : e.surface?.kind === 'sea' || e.surface?.kind === 'lake' ? '🌊' : '📍');
