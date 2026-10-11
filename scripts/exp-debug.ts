import { baseConfig } from '../src/data/defaults';
import { buildScenario } from '../src/sim/build';
import { Session } from '../src/sim/session';
export default function main(): void {
  const s = buildScenario(baseConfig());
  const sess = new Session(s);
  sess.advanceTo(s.derived.pump.time + 1e-9);
  const integ = (sess as any).rotorInt;
  console.log('phase', sess.phase, 't', sess.t, 'h', integ.h, 'y', Array.from(integ.y), 'opts', integ.opts.hMax, integ.opts.rtol);
  try { integ.step(undefined); console.log('ok', integ.t, integ.h); } catch (e) { console.log('err', e); }
}
