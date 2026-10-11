import { designById } from '../src/data/designs';
import { buildScenario } from '../src/sim/build';
import { Session } from '../src/sim/session';
export default function main(args: string[]): void {
  const k = Number(args[0] ?? 2);
  const id = args[1] ?? 'edge-of-space';
  const c = designById(id);
  const f = [10, 1, 0.1][k], capF = [4, 1, 0.25][k];
  const I = c.integrator;
  I.rtol *= f; I.positionTolM *= f; I.hMaxCorridorS *= capF; I.hMaxAtmosphereS *= capF; I.hMaxBurnS *= capF; I.hMaxCoastS *= capF; I.hMaxRotorS *= capF;
  const t0 = performance.now();
  const s = new Session(buildScenario(c));
  let last = performance.now();
  while (!s.ended) { s.advanceTo(s.t + 5, 2000); if (performance.now() - last > 3000) { console.log('t', s.t.toFixed(2), s.phase, 'steps', (s as any).flightInt?.naccept, (s as any).flightInt?.nreject, 'h', (s as any).flightInt?.h); last = performance.now(); } if (performance.now() - t0 > 60000) { console.log('TIMEOUT', s.t, s.phase); break; } }
  console.log('wall', (performance.now() - t0).toFixed(0), 'ms', s.summary().terminal, 'steps', (s as any).flightInt?.naccept, (s as any).flightInt?.nreject);
}
