/** UI/worker integration logic, exercised headlessly with a fake clock and scheduler. */
import { describe, expect, it } from 'vitest';
import { WorkerHost, autoRate } from '../workers/engine';
import { LatestJobTracker, type FromWorker } from '../workers/protocol';
import { designById } from '../data/designs';
import { buildScenario } from '../sim/build';
import { Session } from '../sim/session';

function rig() {
  let now = 0;
  const queue: Array<{ at: number; fn: () => void }> = [];
  const out: FromWorker[] = [];
  const host = new WorkerHost((m) => out.push(m), () => now, (fn, ms) => queue.push({ at: now + ms, fn }));
  const runFor = (ms: number, stepMs = 16): void => {
    const end = now + ms;
    while (now < end) {
      now += stepMs;
      for (let i = 0; i < 1000; i++) {
        const k = queue.findIndex((q) => q.at <= now);
        if (k < 0) break;
        const [q] = queue.splice(k, 1);
        q.fn();
      }
    }
  };
  const drain = (maxIter = 100000): void => {
    for (let i = 0; i < maxIter && queue.length; i++) {
      const q = queue.shift()!;
      now = Math.max(now, q.at);
      q.fn();
    }
  };
  return { host, out, runFor, drain, get now() { return now; } };
}

describe('stale-result rejection', () => {
  it('accepts only the newest job built from the newest configuration', () => {
    const t = new LatestJobTracker();
    const a = t.next(1);
    const b = t.next(2);
    expect(t.accept({ jobId: a, configVersion: 1 })).toBe(false);
    expect(t.accept({ jobId: b, configVersion: 1 })).toBe(false);
    expect(t.accept({ jobId: b, configVersion: 2 })).toBe(true);
  });
  it('trackers sharing a worker draw job ids from one sequence (no cross-cancellation)', () => {
    const seq = { n: 0 };
    const p = new LatestJobTracker(seq);
    const b = new LatestJobTracker(seq);
    const ids = [p.next(1), b.next(1), p.next(2), b.next(2)];
    expect(new Set(ids).size).toBe(4);
  });
});

describe('prediction jobs', () => {
  it('delivers a prediction tagged with jobId and configVersion, telemetry as Float64Array columns', () => {
    const r = rig();
    r.host.handle({ type: 'predict', jobId: 7, configVersion: 3, config: designById('instrument-hop') });
    r.drain();
    const p = r.out.find((m) => m.type === 'prediction');
    expect(p).toBeDefined();
    if (p?.type !== 'prediction') return;
    expect(p.jobId).toBe(7);
    expect(p.configVersion).toBe(3);
    expect(p.flight.columns[0]).toBeInstanceOf(Float64Array);
    expect(p.summary.achievements).toContain('clean-release');
  });
  it('cancels an obsolete job before it completes', () => {
    const r = rig();
    r.host.handle({ type: 'predict', jobId: 1, configVersion: 1, config: designById('leo-reference') });
    r.host.handle({ type: 'cancel', jobId: 1 });
    r.drain();
    expect(r.out.some((m) => m.type === 'cancelled' && m.jobId === 1)).toBe(true);
    expect(r.out.some((m) => m.type === 'prediction')).toBe(false);
  });
  it('reports invalid configurations without throwing', () => {
    const r = rig();
    const c = designById('instrument-hop');
    c.vehicle.diameterM = 0;
    r.host.handle({ type: 'predict', jobId: 2, configVersion: 1, config: c });
    expect(r.out.some((m) => m.type === 'prediction-failed')).toBe(true);
  });
  it('batch jobs report progress and per-config results', () => {
    const r = rig();
    const a = designById('instrument-hop');
    const b = designById('instrument-hop');
    b.launcher.mountId = 'rigid';
    r.host.handle({ type: 'batch', jobId: 9, configVersion: 1, label: 'pair', configs: [a, b], tags: ['a', 'b'] });
    r.drain();
    const res = r.out.find((m) => m.type === 'batch-result');
    expect(res?.type).toBe('batch-result');
    if (res?.type !== 'batch-result') return;
    expect(res.results.map((x) => x.tag)).toEqual(['a', 'b']);
    expect(res.results[1].summary?.failure?.kind).toBe('exit-collision');
    expect(r.out.some((m) => m.type === 'progress' && m.jobId === 9)).toBe(true);
  });
});

describe('live run', () => {
  it('plays with time compression, publishes ~30 Hz snapshots, and ends with the same result as a headless run', () => {
    const r = rig();
    r.host.handle({ type: 'init', runId: 1, configVersion: 1, config: designById('instrument-hop') });
    expect(r.out[0].type).toBe('ready');
    r.host.handle({ type: 'playback', runId: 1, playing: true, mode: { auto: false, rate: 50 } });
    r.runFor(4000);
    const snaps = r.out.filter((m) => m.type === 'snapshot');
    expect(snaps.length).toBeGreaterThan(60);
    // Stale runId messages are ignored by the host.
    r.host.handle({ type: 'command', runId: 99, kind: 'abort' });
    r.host.handle({ type: 'skip-to', runId: 1, phase: 'end' });
    r.runFor(2000);
    const fin = r.out.find((m) => m.type === 'finished');
    expect(fin?.type).toBe('finished');
    if (fin?.type !== 'finished') return;
    const ref = new Session(buildScenario(designById('instrument-hop')));
    ref.runToEnd();
    expect(fin.summary.extrema.maxAltitude.value).toBe(ref.summary().extrema.maxAltitude.value);
    expect(fin.summary.terminal).toBe('ground-contact');
    const tele = r.out.filter((m) => m.type === 'telemetry');
    expect(tele.length).toBeGreaterThan(1);
  });
  it('never reveals events or phases ahead of the displayed time', () => {
    const r = rig();
    r.host.handle({ type: 'init', runId: 4, configVersion: 1, config: designById('instrument-hop') });
    r.host.handle({ type: 'skip-to', runId: 4, phase: 'release' });
    r.host.handle({ type: 'playback', runId: 4, playing: true, mode: { auto: true } });
    for (let k = 0; k < 40; k++) {
      r.runFor(100);
      let lastSnapT = -Infinity;
      for (const m of r.out) {
        if (m.type === 'snapshot') {
          lastSnapT = m.snapshot.t;
          if (m.snapshot.phase === 'corridor' || m.snapshot.phase === 'flight') expect(m.snapshot.vehicle).toBeDefined();
        }
        if (m.type === 'events') for (const e of m.events) expect(e.t).toBeLessThanOrEqual(Math.max(lastSnapT, m.events[0].t) + 1);
      }
    }
    const snaps = r.out.filter((m) => m.type === 'snapshot');
    const firstFlight = snaps.find((m) => m.type === 'snapshot' && m.snapshot.vehicle);
    const lastHold = [...snaps].reverse().find((m) => m.type === 'snapshot' && m.snapshot.phase === 'hold');
    if (firstFlight?.type === 'snapshot' && lastHold?.type === 'snapshot') expect(lastHold.snapshot.t).toBeLessThan(firstFlight.snapshot.t);
    const relEvents = r.out.filter((m) => m.type === 'events').flatMap((m) => (m.type === 'events' ? m.events : [])).filter((e) => e.kind === 'release');
    const firstVehicleSnap = snaps.find((m) => m.type === 'snapshot' && m.snapshot.vehicle);
    if (relEvents.length && firstVehicleSnap?.type === 'snapshot') {
      const idxEvent = r.out.findIndex((m) => m.type === 'events' && m.events.some((e) => e.kind === 'release'));
      const idxSnap = r.out.indexOf(firstVehicleSnap);
      // The release event is not delivered before the display reaches release.
      const snapBefore = [...r.out.slice(0, idxEvent)].reverse().find((m) => m.type === 'snapshot');
      if (snapBefore?.type === 'snapshot') expect(snapBefore.snapshot.t).toBeGreaterThanOrEqual(relEvents[0].t - 0.05);
      expect(idxSnap).toBeGreaterThan(0);
    }
  });
  it('pause holds display time; abort is applied and logged with its simulation timestamp', () => {
    const r = rig();
    r.host.handle({ type: 'init', runId: 2, configVersion: 1, config: designById('thirty-km') });
    r.host.handle({ type: 'playback', runId: 2, playing: true, mode: { auto: true } });
    r.runFor(1500);
    r.host.handle({ type: 'playback', runId: 2, playing: false, mode: { auto: true } });
    const last = [...r.out].reverse().find((m) => m.type === 'snapshot');
    r.runFor(1000);
    const last2 = [...r.out].reverse().find((m) => m.type === 'snapshot');
    expect(last?.type === 'snapshot' && last2?.type === 'snapshot' && last.snapshot.t === last2.snapshot.t).toBe(true);
    r.host.handle({ type: 'command', runId: 2, kind: 'abort' });
    r.host.handle({ type: 'playback', runId: 2, playing: true, mode: { auto: true } });
    r.runFor(1000);
    const fin = r.out.find((m) => m.type === 'finished');
    expect(fin?.type === 'finished' && fin.summary.terminal).toBe('aborted');
    expect(fin?.type === 'finished' && fin.commandLog.length).toBe(1);
  });
  it('re-init replaces the run; invalid configs are rejected with issues', () => {
    const r = rig();
    const c = designById('instrument-hop');
    c.launcher.vacuum.targetPressurePa = 1e-5;
    r.host.handle({ type: 'init', runId: 3, configVersion: 5, config: c });
    const rej = r.out.find((m) => m.type === 'rejected');
    expect(rej?.type === 'rejected' && rej.issues.some((i) => i.level === 'error')).toBe(true);
  });
  it('auto playback rate is presentation-only and phase-dependent', () => {
    const s = new Session(buildScenario(designById('instrument-hop')));
    const a = autoRate(s);
    s.advanceTo(s.s.derived.pump.time + 1);
    const b = autoRate(s);
    expect(a).toBeGreaterThan(10);
    expect(b).toBeGreaterThan(1);
  });
});

describe('main-thread fallback when module workers are blocked', () => {
  const waitFor = async (pred: () => boolean, ms = 60_000): Promise<void> => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  it('a worker that cannot be constructed falls back and replays buffered messages', async () => {
    const { ResilientWorker } = await import('../workers/resilient');
    const w = new ResilientWorker(() => {
      throw new DOMException('blocked by policy', 'SecurityError');
    });
    const out: FromWorker[] = [];
    w.onmessage = (e) => out.push(e.data);
    // Sent before the fallback has loaded: must be buffered, not lost.
    w.postMessage({ type: 'predict', jobId: 11, configVersion: 2, config: designById('instrument-hop') });
    await waitFor(() => out.some((m) => m.type === 'prediction'));
    const p = out.find((m) => m.type === 'prediction');
    expect(w.mode).toBe('inline');
    expect(p && p.type === 'prediction' && p.jobId === 11 && p.configVersion === 2).toBe(true);
    expect(p && p.type === 'prediction' && p.summary.terminal).toBe('ground-contact');
    w.terminate();
  });

  it('the inline host runs a live run to the end like the worker', async () => {
    const { InlineWorker } = await import('../workers/inline');
    const w = new InlineWorker();
    const out: FromWorker[] = [];
    w.onmessage = (e) => out.push(e.data);
    w.postMessage({ type: 'init', runId: 5, configVersion: 1, config: designById('instrument-hop') });
    w.postMessage({ type: 'skip-to', runId: 5, phase: 'end' });
    await waitFor(() => out.some((m) => m.type === 'finished'));
    const f = out.find((m) => m.type === 'finished');
    expect(f && f.type === 'finished' && f.summary.terminal).toBe('ground-contact');
    expect(out.some((m) => m.type === 'telemetry')).toBe(true);
    w.terminate();
  });
});
