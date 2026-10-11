import { orbitalDesign } from './exp-orbit';
import { buildScenario } from '../src/sim/build';
import { Session } from '../src/sim/session';
export default function main(args: string[]): void {
  const c = orbitalDesign();
  c.vehicle.aeroFamilyId = 'blunted-cone'; c.vehicle.finsId = 'small-tail';
  c.flightPlan.guidance.ignition = { kind: 'altitude', valueM: 62000 }; c.flightPlan.jettison = { kind: 'altitude', valueM: 60000 };
  if (args[0] === 'assisted') c.fidelity = 'assisted';
  const s = buildScenario(c);
  const sess = new Session(s);
  sess.runToEnd();
  const ft = sess.flightTable;
  const T = ft.col('t'), alt = ft.col('alt'), thr = ft.col('thrust'), vI = ft.col('vInertial'), peri = ft.col('peri'), apo = ft.col('apo'), g = ft.col('gimbalDeg'), m = ft.col('mass');
  const x = ft.col('x'), y = ft.col('y'), z = ft.col('z'), vx = ft.col('vx'), vy = ft.col('vy'), vz = ft.col('vz');
  const qw = ft.col('qw'), qx = ft.col('qx'), qy = ft.col('qy'), qz = ft.col('qz');
  let last = -1e9;
  for (let i = 0; i < ft.length; i++) {
    if (T[i] - last < 6 || T[i] - T[0] > 260) continue;
    last = T[i];
    const r = Math.hypot(x[i], y[i], z[i]);
    const hd = (x[i] * vx[i] + y[i] * vy[i] + z[i] * vz[i]) / r;
    const vh = Math.sqrt(vI[i] ** 2 - hd ** 2);
    // body x axis
    const w = qw[i], a = qx[i], b = qy[i], cc = qz[i];
    const bx = [1 - 2 * (b * b + cc * cc), 2 * (a * b + w * cc), 2 * (a * cc - w * b)];
    const up = [x[i] / r, y[i] / r, z[i] / r];
    const pitch = Math.asin(bx[0] * up[0] + bx[1] * up[1] + bx[2] * up[2]) * 57.3;
    console.log(`t=${(T[i] - T[0]).toFixed(1)} alt=${(alt[i] / 1e3).toFixed(1)} hdot=${hd.toFixed(0)} vh=${vh.toFixed(0)} thr=${thr[i].toFixed(0)} m=${m[i].toFixed(0)} pitchBody=${pitch.toFixed(1)} gimbal=${g[i].toFixed(2)} peri=${(peri[i] / 1e3).toFixed(0)} apo=${(apo[i] / 1e3).toFixed(0)}`);
  }
}
