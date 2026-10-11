/** Every modelled failure class has a deterministic failing reference case. */
import { describe, expect, it } from 'vitest';
import { FAILURE_CASES } from '../data/failures';
import { buildScenario } from '../sim/build';
import { Session } from '../sim/session';
import { MISSIONS } from '../game/missions';

describe('failure reference cases', () => {
  for (const f of FAILURE_CASES) {
    it(`${f.id} fails with ${f.expected}`, () => {
      const run = (): ReturnType<Session['summary']> => {
        const s = buildScenario(f.make());
        expect(s.ok).toBe(true);
        const sess = new Session(s);
        sess.runToEnd();
        return sess.summary();
      };
      const a = run();
      if (f.expected === 'mission:ground-contact') {
        expect(a.terminal).toBe('ground-contact');
        expect(a.failure).toBeUndefined();
        const s = buildScenario(f.make());
        expect(MISSIONS[3].evaluate(a, s).passed).toBe(false);
        expect(a.achievements).toContain('alt-100km');
        expect(a.achievements).not.toContain('orbit-insertion');
      } else {
        expect(a.failure?.kind).toBe(f.expected);
        expect(a.failure?.message.length).toBeGreaterThan(20);
        expect(Number.isFinite(a.failure?.t)).toBe(true);
        // Deterministic: same failure at the same time on a rerun.
        const b = run();
        expect(b.failure?.t).toBe(a.failure?.t);
        expect(b.failure?.value).toBe(a.failure?.value);
      }
    });
  }
  it('exit-collision message reports penetration and time from the run', () => {
    const s = buildScenario(FAILURE_CASES.find((f) => f.id === 'fail-exit-collision')!.make());
    const sess = new Session(s);
    sess.runToEnd();
    expect(sess.failure?.message).toMatch(/intersects the port by \d+\.\d cm at t = \d+\.\d+ ms after release/);
  });
});
