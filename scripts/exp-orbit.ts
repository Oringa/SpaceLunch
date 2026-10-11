import { baseConfig } from '../src/data/defaults';
import { buildScenario } from '../src/sim/build';
import { Session } from '../src/sim/session';
import type { SimConfig } from '../src/sim/config';

export function orbitalDesign(): SimConfig {
  const c = baseConfig();
  c.name = 'LEO reference';
  c.launcher.targetTipSpeedMps = 2222;
  c.launcher.arm = { materialId: 'cfrp-ud', profile: 'constant-stress', rootAreaM2: 2.6, tipAreaM2: 0.13, sectionAspect: 4 };
  c.launcher.motorId = 'drive-50mw';
  c.launcher.bearingId = 'hydrodynamic-large';
  c.launcher.chamberRadiusM = 54;
  c.launcher.exit.apertureRadiusM = 0.75;
  c.vehicle.payloadMassKg = 20;
  c.vehicle.payloadId = 'smallsat-hardened';
  c.vehicle.lengthM = 5.6;
  c.vehicle.diameterM = 0.6;
  c.vehicle.noseRadiusM = 0.06;
  c.vehicle.stackId = 'l1-l2';
  c.vehicle.rcsId = 'hydrazine';
  c.vehicle.maxNormalForceN = 4e5;
  c.flightPlan.elevationDeg = 60;
  c.flightPlan.jettison = { kind: 'altitude', valueM: 90_000 };
  c.flightPlan.guidance.mode = 'assisted-insertion';
  c.flightPlan.guidance.ignition = { kind: 'vertical-speed-below', valueMps: 500 };
  c.flightPlan.guidance.targetAltitudeM = 240_000;
  c.flightPlan.guidance.cutoffPeriapsisM = 210_000;
  return c;
}

export default function main(args: string[]): void {
  const c = orbitalDesign();
  for (const a of args) { const [k, v] = a.split('='); const parts = k.split('.'); let o: any = c; for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]]; o[parts[parts.length - 1]] = isNaN(Number(v)) ? v : Number(v); }
  const s = buildScenario(c);
  console.log('issues', s.issues.map((i) => i.level + ': ' + i.message));
  const d = s.derived;
  console.log({ wet: d.wetMass.toFixed(1), tip: d.tipMass.toFixed(0), stressGPa: (d.stressMax / 1e9).toFixed(2), margin: d.stressMargin.toFixed(2), armMass: d.armMass.toFixed(0), spin: d.spinupTimeEstimate.toFixed(0), pump: d.pump.time.toFixed(0), beta: d.ballisticCoefficient.toFixed(0), smSub: d.stabilityMarginSubsonicCal.toFixed(2), smHyp: d.stabilityMarginHypersonicCal.toFixed(2), dv: d.idealDeltaV.toFixed(0), stageDv: d.stageDeltaV.map((x) => x.toFixed(0)), tol: (d.timingToleranceS * 1e6).toFixed(0) + 'us', bearing: (d.postReleaseBearingLoad / 1e6).toFixed(1), costs: d.costs.perLaunch.toFixed(0) });
  if (!s.ok) return;
  const t0 = performance.now();
  const sess = new Session(s);
  sess.runToEnd();
  console.log('wall ms', (performance.now() - t0).toFixed(0));
  for (const e of sess.events) console.log(e.t.toFixed(3), e.severity, e.label);
  const sum = sess.summary();
  const X = sum.extrema;
  console.log('maxAlt', (X.maxAltitude.value / 1000).toFixed(1), 'maxQ', (X.maxQ.value / 1e6).toFixed(2), 'MPa heat', (X.maxHeatFlux.value / 1e6).toFixed(2), 'T1', X.maxT1.value.toFixed(0), 'T3', X.maxT3.value.toFixed(0), 'T4', X.maxT4.value.toFixed(0), 'alphaQ', (X.maxAlphaAboveQ.value * 57.3).toFixed(2), 'minClr', X.minClearance.value.toFixed(3), 'N', X.maxNormalForce.value.toFixed(0), 'latG', X.maxLateralG.value.toFixed(1));
  if (sum.failure) console.log('FAILURE', sum.failure.message, sum.failure.contributing);
  console.log('rows', sess.rotorTable.length, sess.flightTable.length, 'dv', sum.thrustDeltaV.toFixed(0));
}
