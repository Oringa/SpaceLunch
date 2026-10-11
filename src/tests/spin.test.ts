// Display spin of the launcher view (rendering/spin.ts): the drawn rotor turns
// at a speed the eye can follow during the time-lapsed spin-up, never faster
// than the real rotor, never backwards, and locks onto the true phase for the
// slow-motion hold before release.
import { describe, expect, it } from 'vitest';
import { displayOmega, speedCue, SpinDisplay, SPIN_CAP, SPIN_CAP_REDUCED } from '../rendering/spin';

const TAU = 2 * Math.PI;
const wrapPi = (a: number): number => a - TAU * Math.round(a / TAU);

describe('display spin rate', () => {
  it('rises with the real rate, saturates, and is never faster than the real rotor', () => {
    let prev = -1;
    for (let w = 0; w <= 200; w += 0.5) {
      const d = displayOmega(w);
      expect(d).toBeGreaterThanOrEqual(prev);
      expect(d).toBeLessThanOrEqual(w + 1e-12);
      expect(d).toBeLessThanOrEqual(SPIN_CAP);
      expect(displayOmega(w, true)).toBeLessThanOrEqual(SPIN_CAP_REDUCED);
      prev = d;
    }
    // 637 rpm (the Mission 1 rotor) reads as a fast spin, not a crawl.
    expect(displayOmega((637 * TAU) / 60) / TAU).toBeGreaterThan(2);
    expect(speedCue(0)).toBe(0);
    expect(speedCue(1000)).toBeCloseTo(1, 6);
    expect(displayOmega(Number.NaN)).toBe(0);
  });
});

describe('spin-up to hold handoff', () => {
  for (const fps of [60, 20, 5]) {
    it(`never turns backwards and locks onto the true phase (${fps} fps)`, () => {
      const s = new SpinDisplay();
      const omegaT = (637 * TAU) / 60;
      const phi0 = 1.234;
      let simT = 0;
      let wall = 0;
      let phiTrue = phi0;
      let snapT = 0;
      let snapPhi = phi0;
      let snapOmega = 0;
      let nextSnapWall = 0;
      let prevAngle = s.angle;
      let first = true;
      const dtWall = 1 / fps;
      const holdStart = 4; // wall seconds of time-lapsed spin-up
      const holdRate = 0.1; // slow-motion hold, as the live playback uses
      let lagMax = 0;
      for (let k = 0; wall < holdStart + 3; k++) {
        wall += dtWall;
        const hold = wall >= holdStart;
        const rate = hold ? holdRate : 120; // time-lapse during spin-up
        const omega = hold ? omegaT : omegaT * Math.min(1, wall / holdStart);
        simT += rate * dtWall;
        phiTrue += omega * rate * dtWall;
        if (wall >= nextSnapWall) {
          // Snapshots arrive at ~30 Hz with the session's phase convention (mod 2 pi).
          snapT = simT;
          snapPhi = phiTrue % TAU;
          snapOmega = omega;
          nextSnapWall = wall + 1 / 30;
        }
        s.update({ wall, dtWall, snapT, phi: snapPhi, omega: snapOmega, truePhase: hold, reduced: false });
        if (!first) expect(s.angle - prevAngle).toBeGreaterThanOrEqual(-1e-9);
        if (!first && !hold) expect(s.angle - prevAngle).toBeLessThanOrEqual(0.75 + 1e-9);
        first = false;
        prevAngle = s.angle;
        if (wall > holdStart + 1.5) {
          // Locked: within one snapshot interval of the true phase (it trails by at most one snapshot).
          const err = wrapPi(phiTrue - s.angle);
          lagMax = Math.max(lagMax, Math.abs(err));
          expect(s.mode).toBe('true');
        }
      }
      const oneSnapshot = omegaT * holdRate * Math.max(1 / 30, dtWall) * 2;
      expect(lagMax).toBeLessThanOrEqual(oneSnapshot);
    });
  }
});
