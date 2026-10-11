/** Game layer: stars and unlocks restrict goals and parts, never physics. */
import { describe, expect, it } from 'vitest';
import { MISSIONS, evaluateWithStars } from '../game/missions';
import { missionUnlocked, partUnlocked, PART_UNLOCK_AFTER } from '../game/progression';
import { designById } from '../data/designs';
import { buildScenario } from '../sim/build';
import { Session } from '../sim/session';
import { UPPER_STAGE_STACKS } from '../data/presets';

const PART_PATHS = (c: ReturnType<typeof designById>): string[] => [
  c.launcher.motorId, c.launcher.bearingId, c.launcher.balanceId, c.launcher.mountId, c.launcher.arm.materialId,
  c.vehicle.payloadId, c.vehicle.aeroFamilyId, c.vehicle.finsId, c.vehicle.protectionId, c.vehicle.stackId, c.vehicle.rcsId,
];

describe('progression', () => {
  it('missions unlock in order; Mission 1 is always open', () => {
    expect(missionUnlocked('m1-clean-release', {})).toBe(true);
    expect(missionUnlocked('m2-thirty-km', {})).toBe(false);
    expect(missionUnlocked('m2-thirty-km', { 'm1-clean-release': 1 })).toBe(true);
  });
  it('every reference design only uses parts unlocked before its mission', () => {
    for (const m of MISSIONS) {
      const completedBefore = Object.fromEntries(MISSIONS.filter((x) => x.index < m.index).map((x) => [x.id, 1]));
      const c = designById(m.referenceDesign);
      for (const part of PART_PATHS(c)) {
        expect(partUnlocked(part, completedBefore, false), `${m.id} needs ${part}`).toBe(true);
      }
    }
  });
  it('unlock table only names real presets', () => {
    const known = new Set(['drive-8mw', 'hydrodynamic-large', 'cc-standard', 'blunted-cone', 'drive-25mw', 'ballast-release', 'magnetic-active', 'drive-50mw', 'uhtc-heavy', 'hydrazine', 'smallsat-hardened', 'fiction-cnt', ...Object.keys(UPPER_STAGE_STACKS)]);
    for (const k of Object.keys(PART_UNLOCK_AFTER)) expect(known.has(k)).toBe(true);
  });
  it('sandbox unlocks everything', () => {
    for (const k of Object.keys(PART_UNLOCK_AFTER)) expect(partUnlocked(k, {}, true)).toBe(true);
  });
});

describe('stars', () => {
  it('reference designs earn at least one star, with the expected tiers', () => {
    const expected: Record<string, number> = { 'm1-clean-release': 2, 'm2-thirty-km': 1, 'm3-edge-of-space': 2, 'm4-leo': 1, 'm5-optimise': 2 };
    for (const m of MISSIONS) {
      const sc = buildScenario(designById(m.referenceDesign));
      const s = new Session(sc);
      s.runToEnd();
      const r = evaluateWithStars(m, s.summary(), sc);
      expect(r.stars, m.id).toBe(expected[m.id]);
      expect(r.starDetails?.length).toBe(3);
    }
  });
  it('a failed run earns no stars', () => {
    const m = MISSIONS[3];
    const c = designById('leo-reference');
    c.vehicle.payloadMassKg = 30;
    const sc = buildScenario(c);
    const s = new Session(sc);
    s.runToEnd();
    expect(evaluateWithStars(m, s.summary(), sc).stars).toBe(0);
  });
});
