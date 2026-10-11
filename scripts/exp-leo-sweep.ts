import { leoReference } from '../src/data/designs';
import { buildScenario } from '../src/sim/build';
import { Session } from '../src/sim/session';
export default function main(args: string[]): void {
  const tgt = Number(args[0] ?? 300) * 1000, cut = Number(args[1] ?? 205) * 1000;
  for (const pay of [5, 10, 12, 15, 20, 25]) {
    const c = leoReference();
    c.vehicle.payloadMassKg = pay;
    c.flightPlan.guidance.targetAltitudeM = tgt;
    c.flightPlan.guidance.cutoffPeriapsisM = cut;
    if (args[2]) c.fidelity = args[2] as any;
    const s = buildScenario(c);
    const sess = new Session(s);
    sess.runToEnd();
    const sum = sess.summary();
    const o = sum.orbit;
    console.log(`pay ${pay}: ${sum.terminal} ${o ? `${(o.periapsisAltitude / 1e3).toFixed(1)}x${(o.apoapsisAltitude / 1e3).toFixed(1)} val=${o.validated}` : sum.failure?.message.slice(0, 110)} propUsed=${sum.propellantUsed.toFixed(1)} / ${s.stages.reduce((a, b) => a + b.propellantMass, 0)}`);
  }
}
