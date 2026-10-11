import { designById } from '../src/data/designs';
import { buildScenario } from '../src/sim/build';
import { Session } from '../src/sim/session';
export default function main(): void {
  const c = designById('instrument-hop');
  c.launcher.release.mode = 'manual-training';
  c.launcher.release.actuatorLatencyS = 0.001;
  const sc = buildScenario(c);
  const s = new Session(sc);
  s.advanceTo(sc.derived.pump.time + sc.derived.spinupTimeEstimate + 10);
  s.command('release');
  for (let k = 0; k < 8; k++) {
    s.advanceTo(s.t + 0.003);
    const y = (s as any).flightInt.y;
    const g = s.s.geometry;
    const cap = (s as any).capsuleEcef(s.t, y);
    const rel = [cap.nose[0]-g.hubEcef[0], cap.nose[1]-g.hubEcef[1], cap.nose[2]-g.hubEcef[2]];
    const ax = rel[0]*g.a[0]+rel[1]*g.a[1]+rel[2]*g.a[2];
    const rho = Math.hypot(rel[0]-ax*g.a[0], rel[1]-ax*g.a[1], rel[2]-ax*g.a[2]);
    console.log('t', s.t.toFixed(4), s.phase, 'clr', (s as any).clearanceAt(s.t, y).toFixed(3), 'rho', rho.toFixed(3), 'ax', ax.toFixed(3), 'Rc', g.chamberRadius);
  }
  const t0 = performance.now();
  let last = t0;
  while (!s.ended && performance.now() - t0 < 30000) { s.advanceTo(s.t + 0.01, 1000); if (performance.now() - last > 2000) { last = performance.now(); console.log('t', s.t, s.phase, (s as any).flightInt?.naccept, (s as any).flightInt?.h); } }
  console.log('ended', s.ended, s.terminal, s.failure?.message);
  for (const e of s.events.slice(-5)) console.log(e.t, e.label.slice(0, 120));
}
export function probe(): void {}
