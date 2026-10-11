import { useEffect, useMemo, useState } from 'react';
import { Controller } from './ui/controller';
import { useStore } from './ui/store';
import { Header } from './ui/components/Header';
import { ConfigPanel } from './ui/components/ConfigPanel';
import { Instruments } from './ui/components/Instruments';
import { SimulationView } from './ui/components/SimulationView';
import { TelemetryPanel } from './ui/components/TelemetryPanel';
import { Analysis } from './ui/components/Analysis';
import { Inspector, Help } from './ui/components/Modals';
import { PlayShell } from './ui/play/Play';

export function App() {
  const ctl = useMemo(() => new Controller('instrument-hop'), []);
  useEffect(() => {
    ctl.start();
    return () => ctl.dispose();
  }, [ctl]);
  const tab = useStore(ctl.store, (s) => s.tab);
  const uiMode = useStore(ctl.store, (s) => s.uiMode);
  const bottomOpen = useStore(ctl.store, (s) => s.bottomOpen);
  const [drawer, setDrawer] = useState<'left' | 'right' | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tgt = e.target as HTMLElement;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'SELECT' || tgt.tagName === 'TEXTAREA')) return;
      const st = ctl.store.get();
      switch (e.key) {
        case ' ':
          if (st.run.status !== 'idle') {
            e.preventDefault();
            const pb = st.run.playback;
            ctl.setPlayback(!pb.playing, pb.auto ? { auto: true } : { auto: false, rate: pb.rate });
          }
          break;
        case 'l':
        case 'L':
          if (st.run.status !== 'live' && st.run.status !== 'starting' && st.scenario?.ok && !(st.uiMode === 'play' && st.showHome)) ctl.launch();
          break;
        case 'r':
        case 'R':
          ctl.reset();
          break;
        case '1': ctl.store.set({ view: 'launcher', autoCamera: false }); break;
        case '2': ctl.store.set({ view: 'world', autoCamera: false }); break;
        case '3': ctl.store.set({ view: 'orbit', autoCamera: false }); break;
        case '4':
        case 'm':
        case 'M':
          if (st.uiMode === 'play') ctl.store.set({ mapOpen: !st.mapOpen });
          else ctl.store.set({ view: st.view === 'map' && e.key !== '4' ? 'world' : 'map' });
          break;
        case 'e': case 'E': ctl.setUiMode(st.uiMode === 'play' ? 'engineer' : 'play'); break;
        case 'b': case 'B': ctl.store.set({ tab: 'build' }); break;
        case 'f': case 'F': ctl.store.set({ tab: 'flight' }); break;
        case 'a': case 'A': ctl.store.set({ tab: 'analysis' }); break;
        case '?': ctl.store.set({ helpOpen: true }); break;
        case 'Escape': setDrawer(null); if (st.mapOpen) ctl.store.set({ mapOpen: false }); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctl]);

  if (uiMode === 'play') return <PlayShell ctl={ctl} />;
  return (
    <div className={`app${bottomOpen ? '' : ' bottom-closed'}`}>
      <Header ctl={ctl} onDrawer={(w) => setDrawer(drawer === w ? null : w)} />
      <aside className={`left${drawer === 'left' ? ' open' : ''}`} aria-label="Configuration">
        <ConfigPanel ctl={ctl} />
      </aside>
      <div style={{ gridArea: 'main', position: 'relative', minWidth: 0, minHeight: 0 }}>
        <SimulationView ctl={ctl} />
        {tab === 'analysis' && <Analysis ctl={ctl} />}
      </div>
      <aside className={`right${drawer === 'right' ? ' open' : ''}`} aria-label="Live instruments">
        <Instruments ctl={ctl} />
      </aside>
      <TelemetryPanel ctl={ctl} />
      <Inspector ctl={ctl} />
      <Help ctl={ctl} />
    </div>
  );
}
