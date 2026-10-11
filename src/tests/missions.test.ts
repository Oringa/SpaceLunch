/** Every mission has a stored reference configuration that passes in the solver. */
import { describe, expect, it } from 'vitest';
import { MISSIONS } from '../game/missions';
import { designById } from '../data/designs';
import { buildScenario } from '../sim/build';
import { Session } from '../sim/session';

describe('mission reference configurations', () => {
  for (const m of MISSIONS) {
    it(`${m.index}. ${m.name} passes with '${m.referenceDesign}'`, () => {
      const s = buildScenario(designById(m.referenceDesign));
      expect(s.ok).toBe(true);
      expect(s.issues.filter((i) => i.level === 'error')).toEqual([]);
      const sess = new Session(s);
      sess.runToEnd();
      const sum = sess.summary();
      const r = m.evaluate(sum, s);
      if (!r.passed) console.error(m.id, r.objectives, sum.failure);
      expect(r.passed).toBe(true);
      expect(Number.isFinite(sum.extrema.maxAltitude.value)).toBe(true);
    });
  }
  it('the easy first-load preset has no warnings', () => {
    const s = buildScenario(designById('instrument-hop'));
    expect(s.issues).toEqual([]);
  });
});
