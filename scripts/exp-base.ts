import { baseConfig } from '../src/data/defaults';
import { buildScenario } from '../src/sim/build';
import { Session } from '../src/sim/session';

export default function main(): void {
  const c = baseConfig();
  const s = buildScenario(c);
  console.log('issues', s.issues);
  const d = s.derived;
  console.log({ wet: d.wetMass, tip: d.tipMass, rpm: d.rpm, g: d.aRadialG, stress: d.stressMax / 1e9, margin: d.stressMargin, armMass: d.armMass, I: d.rotorInertia, KE: d.rotorKE / 3.6e9, spin: d.spinupTimeEstimate, eq: d.equilibriumTipSpeed, pump: d.pump.time, beta: d.ballisticCoefficient, smSub: d.stabilityMarginSubsonicCal, smHyp: d.stabilityMarginHypersonicCal, tol: d.timingToleranceS, gasP: d.gasLossPowerAtTarget / 1e6 });
  if (!s.ok) return;
  const t0 = performance.now();
  const sess = new Session(s);
  sess.runToEnd();
  console.log('wall ms', (performance.now() - t0).toFixed(0));
  for (const e of sess.events) console.log(e.t.toFixed(4), e.severity, e.label);
  const sum = sess.summary();
  console.log('maxAlt', sum.extrema.maxAltitude, 'maxQ', sum.extrema.maxQ, 'maxHeat', sum.extrema.maxHeatFlux, 'T1', sum.extrema.maxT1, 'T4', sum.extrema.maxT4, 'alpha', sum.extrema.maxAlphaAboveQ, 'minClr', sum.extrema.minClearance);
  console.log('rows', sess.rotorTable.length, sess.flightTable.length);
}
