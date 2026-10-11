/** Run every reference design through the solver and print a one-line summary each. Usage: npm run designs [-- id ...] */
import { DESIGNS } from '../src/data/designs';
import { buildScenario, ConfigError } from '../src/sim/build';
import { Session } from '../src/sim/session';
export default function main(args: string[]): void {
  for (const d of DESIGNS) {
    if (args.length && !args.includes(d.id)) continue;
    const c = d.make();
    console.log('\n=====', d.id);
    let s;
    try { s = buildScenario(c); } catch (e) { console.log('BUILD ERROR', e instanceof ConfigError ? e.issues : e); continue; }
    for (const i of s.issues) console.log(' ', i.level, i.message);
    const D = s.derived;
    console.log(`  wet ${D.wetMass.toFixed(1)} kg, g ${D.aRadialG.toFixed(0)}, stress margin ${D.stressMargin.toFixed(2)}, spin ${D.spinupTimeEstimate.toFixed(0)} s (${(D.spinupEnergyEstimate / 3.6e9).toFixed(3)} MWh), pump ${D.pump.time.toFixed(0)} s, beta ${D.ballisticCoefficient.toFixed(0)}, SM ${D.stabilityMarginSubsonicCal.toFixed(2)}/${D.stabilityMarginHypersonicCal.toFixed(2)}, tol ${(D.timingToleranceS * 1e6).toFixed(0)} us, bearing ${(D.postReleaseBearingLoad / 1e6).toFixed(2)}/${(D.bearingLimit / 1e6).toFixed(1)} MN, cost ${D.costs.perLaunch.toFixed(0)}`);
    if (!s.ok) continue;
    const t0 = performance.now();
    const sess = new Session(s);
    sess.runToEnd();
    const sum = sess.summary();
    const X = sum.extrema;
    console.log(`  wall ${(performance.now() - t0).toFixed(0)} ms; end ${sum.terminal}; achievements ${sum.achievements.join(',')}; apogee ${(X.maxAltitude.value / 1000).toFixed(1)} km; maxQ ${(X.maxQ.value / 1e6).toFixed(2)} MPa; heat ${(X.maxHeatFlux.value / 1e6).toFixed(2)} MW/m2; T1 ${X.maxT1.value.toFixed(0)} T3 ${X.maxT3.value.toFixed(0)} T4 ${X.maxT4.value.toFixed(0)}; alpha ${(X.maxAlphaAboveQ.value * 57.3).toFixed(2)} deg; clr ${(X.minClearance.value * 100).toFixed(1)} cm; Eelec ${(sum.energy.electricalJ / 3.6e9).toFixed(3)} MWh`);
    if (sum.failure) console.log('  FAILURE:', sum.failure.message);
    if (sum.orbit) console.log(`  orbit ${(sum.orbit.periapsisAltitude / 1000).toFixed(1)} x ${(sum.orbit.apoapsisAltitude / 1000).toFixed(1)} km, validated ${sum.orbit.validated}, prop used ${sum.propellantUsed.toFixed(1)}`);
  }
}
