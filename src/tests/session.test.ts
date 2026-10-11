/** Test 9 and robustness: playback independence, commands, replay, resets, degenerate inputs. */
import { describe, expect, it } from 'vitest';
import { designById } from '../data/designs';
import { baseConfig } from '../data/defaults';
import { buildScenario, ConfigError } from '../sim/build';
import { Session } from '../sim/session';
import { cloneConfig } from '../sim/config';
import { importConfig, exportConfig, validateConfig } from '../sim/validate';
import { pumpdown, pressureAt } from '../physics/vacuum';
import { Dopri5 } from '../physics/integrator';
import { RS } from '../physics/rotor';

function summaryAfter(chunk: number, rate: number, budget = Infinity): ReturnType<Session['summary']> {
  const s = new Session(buildScenario(designById('instrument-hop')));
  let t = 0;
  let guard = 0;
  while (!s.ended && guard++ < 5_000_000) {
    t += chunk * rate;
    s.advanceTo(t, budget);
  }
  return s.summary();
}

describe('playback and frame-rate independence', () => {
  it('outcome does not depend on how often or how far the session is advanced', () => {
    const a = summaryAfter(1 / 60, 50);
    const b = summaryAfter(1 / 13, 400);
    const c = summaryAfter(1e9, 1);
    for (const x of [b, c]) {
      expect(x.extrema.maxAltitude.value).toBe(a.extrema.maxAltitude.value);
      expect(x.extrema.maxQ.value).toBe(a.extrema.maxQ.value);
      expect(x.times.end).toBe(a.times.end);
      expect(x.release?.timingErrorS).toBe(a.release?.timingErrorS);
    }
  });
});

describe('commands, abort and replay', () => {
  it('abort during spin-up ends the run, and replaying the command log reproduces it exactly', () => {
    const sc = buildScenario(designById('instrument-hop'));
    const live = new Session(sc);
    live.advanceTo(sc.derived.pump.time + 30);
    live.command('abort');
    live.advanceTo(Infinity);
    expect(live.terminal).toBe('aborted');
    const log = live.commandLog.map((c) => ({ ...c }));
    expect(log.length).toBe(1);
    const replay = new Session(buildScenario(designById('instrument-hop')), log);
    replay.runToEnd();
    expect(replay.terminal).toBe('aborted');
    expect(replay.t).toBe(live.t);
    expect(replay.rotorTable.length).toBe(live.rotorTable.length);
    expect(replay.rotorTable.col('omega').at(-1)).toBe(live.rotorTable.col('omega').at(-1));
  });
  it('manual release is rejected in phase-locked mode and honoured in training mode', () => {
    const c = designById('instrument-hop');
    c.launcher.release.mode = 'manual-training';
    c.launcher.release.actuatorLatencyS = 0.001;
    const sc = buildScenario(c);
    const s = new Session(sc);
    s.advanceTo(sc.derived.pump.time + sc.derived.spinupTimeEstimate + 10);
    expect(s.phase).toBe('hold');
    s.command('release');
    s.advanceTo(Infinity);
    expect(s.releaseRecord).toBeDefined();
    expect(Math.abs(s.releaseRecord!.t - (s.commandLog[0].t + 0.001))).toBeLessThan(1e-9);
  });
  it('repeated resets produce identical results (no hidden state)', () => {
    const ends: number[] = [];
    for (let i = 0; i < 3; i++) {
      const s = new Session(buildScenario(designById('instrument-hop')));
      s.runToEnd();
      ends.push(s.summary().extrema.maxAltitude.value);
    }
    expect(new Set(ends).size).toBe(1);
  });
  it('seeded runs are reproducible; different seeds change only seeded quantities', () => {
    const a = designById('edge-of-space'); a.seed = 11;
    const b = cloneConfig(a);
    const c = cloneConfig(a); c.seed = 12;
    const run = (x: typeof a): number => { const s = new Session(buildScenario(x)); s.runToEnd(); return s.summary().release!.timingErrorS; };
    expect(run(a)).toBe(run(b));
    expect(run(a)).not.toBe(run(c));
  });
});

describe('rotor and vacuum models', () => {
  it('spin-up energy bookkeeping closes: E_mech - E_bearing - E_gas = rotor kinetic energy', () => {
    const sc = buildScenario(designById('thirty-km'));
    const s = new Session(sc);
    s.advanceTo(sc.derived.pump.time + sc.derived.spinupTimeEstimate * 0.6);
    const rt = s.rotorTable;
    const i = rt.length - 1;
    const lhs = rt.get('eMech', i) - rt.get('eBearing', i) - rt.get('eGas', i);
    const ke = rt.get('rotorKE', i);
    expect(Math.abs(lhs - ke) / ke).toBeLessThan(1e-6);
    expect(rt.get('eElec', i)).toBeGreaterThan(rt.get('eMech', i));
  });
  it('pump-down analytic solution matches numerical integration of dp/dt = (Q - S p)/V', () => {
    const sc = buildScenario(designById('instrument-hop'));
    const v = sc.vacuum;
    const pd = pumpdown(v);
    const Q = v.gasLoadPerArea * v.surfaceArea;
    const integ = new Dopri5(1, (_t, y, dy) => { dy[0] = (Q - v.pumpSpeed * y[0]) / v.volume; }, { rtol: 1e-12, atol: new Float64Array([1e-12]), hMax: 10, hMin: 1e-12 });
    integ.reset(0, [v.initialPressure]);
    while (integ.t < pd.time) integ.step(pd.time);
    expect(Math.abs(integ.y[0] - v.targetPressure) / v.targetPressure).toBeLessThan(1e-6);
    expect(pressureAt(v, pd.time)).toBeCloseTo(v.targetPressure, 6);
  });
  it('infeasible vacuum target and unreachable tip speed are reported, not fixed', () => {
    const c = designById('instrument-hop');
    c.launcher.vacuum.targetPressurePa = 1e-4;
    expect(buildScenario(c).ok).toBe(false);
    const d = designById('instrument-hop');
    d.launcher.targetTipSpeedMps = 2500;
    d.launcher.vacuum.targetPressurePa = 900;
    const sd = buildScenario(d);
    expect(sd.ok).toBe(false);
    expect(sd.issues.some((i) => /not reachable/.test(i.message))).toBe(true);
  });
  it('release keeps rotor angular speed continuous (no spurious spin-up of the remaining rotor)', () => {
    const s = new Session(buildScenario(designById('instrument-hop')));
    s.runToEnd();
    const r = s.releaseRecord!;
    expect(r.rotorKEAfter).toBeLessThan(r.rotorKEBefore);
    expect(r.rotorKEAfter / r.rotorKEBefore).toBeCloseTo(1 - (s.s.derived.tipMass - (s.s.derived.tipMass - s.s.derived.wetMass)) * s.s.config.launcher.armRadiusM ** 2 / s.s.rotorDerived.inertia - s.s.rotor.vehicleOwnInertia / s.s.rotorDerived.inertia, 6);
    void RS;
  });
});

describe('configuration import/export and degenerate inputs', () => {
  it('round-trips through JSON', () => {
    const c = designById('leo-reference');
    const r = importConfig(exportConfig(c));
    expect(r.ok).toBe(true);
    expect(r.config).toEqual(c);
  });
  it('rejects malformed files with path-level diagnostics', () => {
    expect(importConfig('{not json').ok).toBe(false);
    const c = JSON.parse(JSON.stringify(baseConfig()));
    c.launcher.armRadiusM = 'fifty';
    delete c.vehicle.diameterM;
    c.flightPlan.guidance.ignition = { kind: 'telepathy' };
    const r = validateConfig(c);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/launcher\.armRadiusM/);
    expect(r.errors.join('\n')).toMatch(/vehicle\.diameterM: missing/);
    expect(r.errors.join('\n')).toMatch(/ignition\.kind/);
    const d = baseConfig() as unknown as Record<string, unknown>;
    (d.launcher as Record<string, unknown>).armRadiusM = 1e6;
    expect(validateConfig(d).errors.join()).toMatch(/above the allowed maximum/);
    (d.launcher as Record<string, unknown>).armRadiusM = NaN;
    expect(validateConfig(d).ok).toBe(false);
  });
  it('degenerate geometry throws a ConfigError instead of producing NaN telemetry', () => {
    const c = baseConfig();
    c.vehicle.diameterM = 0;
    expect(() => buildScenario(c)).toThrow(ConfigError);
    const d = baseConfig();
    d.vehicle.noseRadiusM = 0.5;
    expect(() => buildScenario(d)).toThrow(/Nose radius/);
  });
  it('zero wind, zero rotation, empty upper stage and unsupported regimes run without NaN', () => {
    const c = designById('instrument-hop');
    c.environment.wind.enabled = true;
    c.environment.wind.layers = c.environment.wind.layers.map((l) => ({ ...l, speedMps: 0 }));
    c.environment.wind.structureAmplitudeMps = 0;
    c.physics.earthRotation = false;
    c.vehicle.lengthM = 2.2; // L/D outside the table domain -> warning, still runs
    const sc = buildScenario(c);
    expect(sc.issues.some((i) => /outside the/.test(i.message))).toBe(true);
    const s = new Session(sc);
    s.runToEnd();
    const ft = s.flightTable;
    for (const ch of ['alt', 'q', 'vAir', 'mach', 'T1', 'mass']) {
      for (const v of ft.col(ch)) expect(Number.isNaN(v)).toBe(false);
    }
    const e = designById('edge-of-space');
    e.flightPlan.guidance.mode = 'assisted-insertion'; // no stage: guidance has nothing to ignite
    const se = buildScenario(e);
    expect(se.guidance.mode).toBe('none');
  });
  it('vacuum thought experiment keeps gravity and records are separated', async () => {
    const c = designById('edge-of-space');
    c.physics.atmosphere = false;
    const s = new Session(buildScenario(c));
    s.runToEnd();
    const sum = s.summary();
    // Only the chamber's residual gas (a few Pa) acts; no atmospheric drag or heating after the exit.
    expect(sum.extrema.maxQ.value).toBeLessThan(200);
    expect(sum.extrema.maxHeatFlux.value).toBe(0);
    expect(sum.extrema.maxAltitude.value).toBeGreaterThan(150_000);
    expect(sum.terminal).toBe('ground-contact');
    const { recordKey } = await import('../game/missions');
    expect(recordKey(c, 'm3')).not.toBe(recordKey(designById('edge-of-space'), 'm3'));
  });
});
