/**
 * Numerical validation report: recomputes the acceptance metrics with the
 * production kernel and writes docs/VALIDATION.md (and a JSON copy) so the
 * achieved errors are published, not just asserted.
 * Run: npm run validate
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { tipKinematics, vehicleTranslationalEnergy } from '../src/physics/rotor';
import { dynamicPressure } from '../src/physics/aero';
import { releaseDirectionError } from '../src/physics/launcher';
import { ussa76, emptySample } from '../src/physics/atmosphere';
import { circularSpeed } from '../src/physics/orbit';
import { MU_EARTH, R_EARTH } from '../src/physics/constants';
import { FS } from '../src/physics/flight';
import { cross, norm } from '../src/physics/vec3';
import { makeRig, constantAtmosphere, flatFamily } from '../src/tests/helpers';
import { baseConfig } from '../src/data/defaults';
import { designById, DESIGNS } from '../src/data/designs';
import { FAILURE_CASES } from '../src/data/failures';
import { MISSIONS } from '../src/game/missions';
import { buildScenario } from '../src/sim/build';
import { Session } from '../src/sim/session';
import { MODEL_VERSION } from '../src/sim/config';

export default function main(): void {
  const out: Record<string, unknown> = { modelVersion: MODEL_VERSION, generated: new Date().toISOString(), node: process.version };
  const md: string[] = ['# Validation results', '', `Model \`${MODEL_VERSION}\`, generated ${new Date().toISOString().slice(0, 16)}Z on Node ${process.version} by \`npm run validate\`. Values below are recomputed by the production kernel; \`npm test\` asserts the thresholds.`, ''];

  // 1. Reference case
  const k = tipKinematics(50, 2000);
  const ref = [
    ['Angular speed', `${k.omega} rad/s`, '40 rad/s'],
    ['Rotor speed', `${k.rpm.toFixed(4)} rpm`, '381.9719 rpm'],
    ['Centripetal acceleration', `${k.aRadial.toFixed(1)} m/s²`, '80,000 m/s²'],
    ['Centripetal g-load', `${k.gLoad.toFixed(2)} g`, '8,157.73 g'],
    ['200 kg translational energy', `${(vehicleTranslationalEnergy(200, 2000) / 1e6).toFixed(3)} MJ = ${(vehicleTranslationalEnergy(200, 2000) / 3.6e6).toFixed(3)} kWh`, '400 MJ = 111.111 kWh'],
    ['Dynamic pressure at 1.225 kg/m³', `${(dynamicPressure(1.225, 2000) / 1e6).toFixed(4)} MPa`, '2.45 MPa'],
    ['Direction error, 1 ms', `${releaseDirectionError(k.omega, 1e-3).toFixed(5)} rad = ${((releaseDirectionError(k.omega, 1e-3) * 180) / Math.PI).toFixed(5)}°`, '0.04 rad = 2.29183°'],
  ];
  md.push('## Synthetic reference case (R = 50 m, v = 2,000 m/s)', '', '| Quantity | Computed | Expected |', '|---|---|---|', ...ref.map((r) => `| ${r[0]} | ${r[1]} | ${r[2]} |`), '');
  out.reference = ref;

  // 2. Atmosphere spot checks
  const atm: Array<[number, number, number]> = [[0, 1.225, 101325], [11000, 0.364801, 22699.9], [50000, 1.02687e-3, 79.779], [86000, 6.958e-6, 0.37338], [100000, 5.604e-7, 3.2011e-2], [500000, 5.215e-13, 3.0236e-7]];
  md.push('## USSA76 spot checks', '', '| Altitude | Density (computed) | Reference | Rel. error |', '|---|---|---|---|');
  for (const [z, rho] of atm) {
    const s = ussa76(z, emptySample());
    md.push(`| ${z / 1000} km | ${s.density.toExponential(5)} | ${rho.toExponential(5)} | ${(Math.abs(s.density - rho) / rho).toExponential(1)} |`);
  }
  md.push('');

  // 3. Radial launch
  {
    const { integ, y0 } = makeRig({ gravity: true, atmosphere: null, fidelity: 'assisted' });
    y0.set([R_EARTH, 0, 0], 0);
    y0.set([2000, 0, 0], 3);
    integ.reset(0, y0);
    let maxAlt = 0;
    const tmp = new Float64Array(FS.N);
    while (integ.y[0] >= R_EARTH - 1 && integ.t < 1000) {
      const t0 = integ.t;
      integ.step();
      for (let i = 0; i <= 20; i++) {
        integ.dense(t0 + ((integ.t - t0) * i) / 20, tmp);
        maxAlt = Math.max(maxAlt, tmp[0] - R_EARTH);
      }
    }
    out.radialApogee = maxAlt;
    md.push('## Radial launch at 2,000 m/s (no air, no rotation)', '', `Apogee ${(maxAlt / 1000).toFixed(4)} km (analytic 210.386 km). Classified radial, Earth-intersecting: never an orbit.`, '');
  }

  // 4. Ten orbits
  {
    const c = baseConfig();
    const { integ, y0 } = makeRig({ config: c, gravity: true, atmosphere: null, rtol: c.integrator.rtol, hMax: c.integrator.hMaxCoastS });
    integ.opts.atol[0] = integ.opts.atol[1] = integ.opts.atol[2] = c.integrator.positionTolM;
    integ.opts.atol[3] = integ.opts.atol[4] = integ.opts.atol[5] = c.integrator.positionTolM * 1e-3;
    const r0 = R_EARTH + 200e3, v0 = circularSpeed(r0);
    y0.set([r0, 0, 0], 0);
    y0.set([0, v0 * Math.cos(0.5), v0 * Math.sin(0.5)], 3);
    integ.reset(0, y0);
    const T = 2 * Math.PI * Math.sqrt(r0 ** 3 / MU_EARTH);
    const E = (y: Float64Array): number => 0.5 * (y[3] ** 2 + y[4] ** 2 + y[5] ** 2) - MU_EARTH / Math.hypot(y[0], y[1], y[2]);
    const H = (y: Float64Array): number => norm(cross([y[0], y[1], y[2]], [y[3], y[4], y[5]]));
    const e0 = E(integ.y), h0 = H(integ.y);
    while (integ.t < 10 * T) integ.step(10 * T);
    const dE = Math.abs((E(integ.y) - e0) / e0), dH = Math.abs((H(integ.y) - h0) / h0);
    out.tenOrbit = { speed: v0, dE, dH, steps: integ.naccept };
    md.push('## Ten-orbit gravity-only drift (200 km circular, production tolerances)', '', `Circular speed ${v0.toFixed(3)} m/s (expected 7,788.488). Relative energy drift ${dE.toExponential(2)}, angular-momentum drift ${dH.toExponential(2)} (target < 1e-6), ${integ.naccept} steps.`, '');
  }

  // 5. Drag analytic
  {
    const c = baseConfig();
    c.vehicle.finsId = 'none';
    const rho = 0.5, cd = 0.3;
    const { integ, y0, model, scenario } = makeRig({ config: c, gravity: false, atmosphere: constantAtmosphere(rho), fidelity: 'assisted', family: flatFamily(cd) });
    y0.set([R_EARTH + 1e4, 0, 0], 0);
    y0.set([0, 1500, 0], 3);
    integ.reset(0, y0);
    const kk = (rho * cd * scenario.vehicle.refArea) / (2 * model.massProps(y0).mass);
    let worst = 0;
    while (integ.t < 30) {
      integ.step(30);
      const v = Math.hypot(integ.y[3], integ.y[4], integ.y[5]);
      const ex = 1500 / (1 + kk * 1500 * integ.t);
      worst = Math.max(worst, Math.abs(v - ex) / ex);
    }
    out.dragError = worst;
    md.push('## Constant-density drag decay', '', `Max relative speed error vs v0/(1 + k v0 t) over 30 s: ${worst.toExponential(2)}.`, '');
  }

  // 6. Missions & failures
  md.push('## Mission reference designs (solver runs)', '', '| Mission | Design | Passed | Key result | Wall time |', '|---|---|---|---|---|');
  const missions: unknown[] = [];
  for (const m of MISSIONS) {
    const sc = buildScenario(designById(m.referenceDesign));
    const t0 = performance.now();
    const s = new Session(sc);
    s.runToEnd();
    const wall = performance.now() - t0;
    const sum = s.summary();
    const r = m.evaluate(sum, sc);
    const key = sum.orbit ? `orbit ${(sum.orbit.periapsisAltitude / 1000).toFixed(1)} × ${(sum.orbit.apoapsisAltitude / 1000).toFixed(1)} km` : `apogee ${(sum.extrema.maxAltitude.value / 1000).toFixed(1)} km`;
    md.push(`| ${m.index}. ${m.name} | ${m.referenceDesign} | ${r.passed ? 'yes' : '**NO**'} | ${key} | ${wall.toFixed(0)} ms |`);
    missions.push({ id: m.id, passed: r.passed, key, wallMs: wall });
  }
  out.missions = missions;
  md.push('', '## Failure reference cases', '', '| Case | Expected | Observed | Message |', '|---|---|---|---|');
  for (const f of FAILURE_CASES) {
    const s = new Session(buildScenario(f.make()));
    s.runToEnd();
    const sum = s.summary();
    const obs = sum.failure?.kind ?? `terminal: ${sum.terminal}`;
    md.push(`| ${f.title} | ${f.expected} | ${obs} | ${(sum.failure?.message ?? '').replace(/\|/g, '/').slice(0, 160)} |`);
  }
  md.push('', '## Designs', '', ...DESIGNS.map((d) => `- **${d.name}** (\`${d.id}\`): ${d.summary}`), '');
  mkdirSync('docs', { recursive: true });
  writeFileSync('docs/VALIDATION.md', md.join('\n') + '\n');
  mkdirSync('public', { recursive: true });
  writeFileSync('public/validation-report.json', JSON.stringify(out, null, 2));
  console.log(md.join('\n'));
}
