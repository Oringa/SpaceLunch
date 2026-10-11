// Play mode never refuses a launch for geometry: the vehicle and the machine
// are rebuilt around the player's choices (game/autofit), while the physics
// and its failure checks stay untouched.
import { describe, expect, it } from 'vitest';
import { fitToDesign } from '../game/autofit';
import { designById, DESIGNS } from '../data/designs';
import { buildScenario, vehicleCornerRadius, vehicleEnvelopeRadius } from '../sim/build';
import { cloneConfig, setPath, type SimConfig } from '../sim/config';
import { internalStackLength, minimumVehicleLength } from '../physics/vehicle';
import { AERO_FAMILIES } from '../physics/aero';
import { PAYLOAD_PRESETS, STAGE_PRESETS, UPPER_STAGE_STACKS } from '../data/presets';
import { streamRng } from '../physics/random';

const edit = (base: SimConfig, c: SimConfig, path: string, v: unknown): SimConfig => {
  const n = cloneConfig(c);
  setPath(n, path, v);
  return fitToDesign(base, n);
};

describe('vehicle sizing helpers agree with buildVehicle', () => {
  it('the minimum length holds the stack; a shorter shell does not', () => {
    const c = designById('leo-reference');
    const V = c.vehicle;
    const fam = AERO_FAMILIES[V.aeroFamilyId];
    const stages = UPPER_STAGE_STACKS[V.stackId].stages.map((id) => STAGE_PRESETS[id]);
    const stack = internalStackLength(V.diameterM, V.payloadMassKg, PAYLOAD_PRESETS[V.payloadId].bulkDensity, stages);
    const Lmin = minimumVehicleLength(fam, V.diameterM, stack);
    const at = (L: number): SimConfig => {
      const x = cloneConfig(c);
      x.vehicle.lengthM = L;
      x.launcher.chamberRadiusM = vehicleCornerRadius(x.launcher.armRadiusM, x.vehicle) + 2;
      return x;
    };
    expect(() => buildScenario(at(Lmin * 1.001))).not.toThrow();
    expect(() => buildScenario(at(Lmin * 0.97))).toThrow(/does not fit/);
  });
});

describe('play-mode auto-fit', () => {
  const base = designById('instrument-hop');

  it('a longer arm gets a chamber with the same clearance', () => {
    const c = edit(base, base, 'launcher.armRadiusM', 100);
    const gap0 = base.launcher.chamberRadiusM - vehicleCornerRadius(base.launcher.armRadiusM, base.vehicle);
    expect(c.launcher.chamberRadiusM - vehicleCornerRadius(100, c.vehicle)).toBeCloseTo(Math.max(0.5, gap0), 1);
    expect(buildScenario(c).ok).toBe(true);
  });

  it('a heavier payload or added stages grow the vehicle, and it shrinks back', () => {
    const heavy = edit(base, base, 'vehicle.payloadMassKg', 300);
    expect(heavy.vehicle.lengthM).toBeGreaterThan(base.vehicle.lengthM);
    expect(heavy.vehicle.lengthM / heavy.vehicle.diameterM).toBeLessThanOrEqual(14.01);
    expect(heavy.launcher.exit.apertureRadiusM).toBeGreaterThan(vehicleEnvelopeRadius(heavy.vehicle));
    expect(buildScenario(heavy).ok).toBe(true);
    const back = edit(base, heavy, 'vehicle.payloadMassKg', base.vehicle.payloadMassKg);
    expect(back.vehicle.lengthM).toBeCloseTo(base.vehicle.lengthM, 2);
    expect(back.vehicle.diameterM).toBeCloseTo(base.vehicle.diameterM, 3);
    const staged = edit(base, base, 'vehicle.stackId', 'l1-l2');
    expect(buildScenario(staged).ok).toBe(true);
  });

  it('random dock settings on every reference design always build (launch is never refused)', () => {
    const rng = streamRng(7, 'playfit');
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng.next() * xs.length)];
    const motors = ['drive-1mw', 'drive-2mw', 'drive-8mw', 'drive-25mw', 'drive-50mw'];
    const shapes = ['slender-ogive', 'blunted-cone', 'hemisphere-cylinder'];
    const shields = ['none', 'ti-light', 'cc-standard', 'uhtc-heavy'];
    const stacks = ['none', 'kick-solid', 'l1', 'l1-l2', 'l1lt-l2'];
    const modes = ['none', 'assisted-insertion', 'prograde', 'pitch-program'];
    let n = 0;
    for (const d of DESIGNS) {
      const b = d.make();
      for (let k = 0; k < 12; k++) {
        let c = cloneConfig(b);
        c = edit(b, c, 'launcher.armRadiusM', 10 + rng.next() * 140);
        c = edit(b, c, 'launcher.targetTipSpeedMps', 200 + rng.next() * 3800);
        c = edit(b, c, 'launcher.motorId', pick(motors));
        c = edit(b, c, 'flightPlan.elevationDeg', 5 + rng.next() * 85);
        c = edit(b, c, 'vehicle.payloadMassKg', 0.5 + rng.next() * 299.5);
        c = edit(b, c, 'vehicle.aeroFamilyId', pick(shapes));
        c = edit(b, c, 'vehicle.protectionId', pick(shields));
        c = edit(b, c, 'vehicle.stackId', pick(stacks));
        c = edit(b, c, 'flightPlan.guidance.mode', pick(modes));
        const s = buildScenario(c);
        const errors = s.issues.filter((i) => i.level === 'error').map((i) => i.message);
        expect(errors, `${d.id} #${k}`).toEqual([]);
        n++;
      }
    }
    expect(n).toBe(DESIGNS.length * 12);
  });
});
