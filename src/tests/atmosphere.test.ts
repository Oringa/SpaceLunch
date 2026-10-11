/** USSA76 reference values (Table I, geometric altitude) and structural properties [R6]. */
import { describe, expect, it } from 'vitest';
import { ussa76, emptySample, buildPerturbedAtmosphere, upperTemperature } from '../physics/atmosphere';

// [z (m), T (K), P (Pa), rho (kg/m^3)]
const TABLE: Array<[number, number, number, number]> = [
  [0, 288.15, 101325, 1.225],
  [1000, 281.651, 89874.6, 1.11164],
  [5000, 255.676, 54019.9, 0.736116],
  [10000, 223.252, 26499.9, 0.41351],
  [11000, 216.774, 22699.9, 0.364801],
  [20000, 216.65, 5529.29, 0.0889097],
  [30000, 226.509, 1197.03, 0.0184101],
  [50000, 270.65, 79.779, 1.02687e-3],
  [70000, 219.585, 5.22092, 8.28283e-5],
  [86000, 186.87, 0.37338, 6.958e-6],
  [100000, 195.08, 3.2011e-2, 5.604e-7],
  [200000, 854.56, 8.4736e-5, 2.541e-10],
  [500000, 999.24, 3.0236e-7, 5.215e-13],
  [1000000, 1000.0, 7.5138e-9, 3.561e-15],
];

describe('USSA76', () => {
  for (const [z, T, P, rho] of TABLE) {
    it(`matches reference at ${z / 1000} km`, () => {
      const s = ussa76(z, emptySample());
      const tolT = z <= 86000 ? 2e-4 : 2e-3;
      const tolP = z <= 86000 ? 1e-3 : 1e-3;
      expect(Math.abs(s.temperature - T) / T).toBeLessThan(tolT);
      expect(Math.abs(s.pressure - P) / P).toBeLessThan(tolP);
      expect(Math.abs(s.density - rho) / rho).toBeLessThan(z <= 86000 ? 1.5e-3 : 1e-3);
    });
  }
  it('is continuous across the 86 km layer boundary', () => {
    const a = ussa76(85999.9, emptySample());
    const b = ussa76(86000.1, emptySample());
    expect(Math.abs(a.density - b.density) / a.density).toBeLessThan(1e-3);
    expect(Math.abs(a.temperature - b.temperature)).toBeLessThan(0.2);
  });
  it('upper temperature segments match published anchors', () => {
    expect(upperTemperature(91000)).toBeCloseTo(186.87, 1);
    expect(upperTemperature(110000)).toBeCloseTo(240, 1);
    expect(upperTemperature(120000)).toBeCloseTo(360, 1);
  });
  it('density is positive, finite and monotonically decreasing from -5 to 3000 km', () => {
    let prev = Infinity;
    for (let z = -5000; z <= 3_000_000; z += 500) {
      const s = ussa76(z, emptySample());
      expect(Number.isFinite(s.density)).toBe(true);
      expect(s.density).toBeGreaterThan(0);
      expect(s.density).toBeLessThanOrEqual(prev * (1 + 1e-12));
      prev = s.density;
    }
  });
  it('does not switch off at 100 km', () => {
    expect(ussa76(100_001, emptySample()).density).toBeGreaterThan(5e-7);
    expect(ussa76(150_000, emptySample()).density).toBeGreaterThan(1e-9);
  });
  it('perturbed atmosphere is hydrostatically consistent and positive', () => {
    const m = buildPerturbedAtmosphere({ surfacePressureFraction: 0.01, surfaceTemperatureOffsetK: 5, decayAltitudeM: 15000, waves: [{ amplitudeK: 2, wavelengthM: 7000, phase: 1 }], thermosphereDensityFactor: 1.4 });
    const s0 = m.sample(0, emptySample());
    expect(s0.pressure).toBeCloseTo(101325 * 1.01, 0);
    // dP/dz = -rho g, check numerically at 12 km
    const z = 12000, dz = 10;
    const a = m.sample(z - dz, emptySample()), b = m.sample(z + dz, emptySample()), c = m.sample(z, emptySample());
    const g = 9.80665 * (6356766 / (6356766 + z)) ** 2;
    expect(Math.abs((b.pressure - a.pressure) / (2 * dz) + c.density * g) / (c.density * g)).toBeLessThan(5e-3);
    for (let zz = 0; zz < 400_000; zz += 1000) expect(m.sample(zz, emptySample()).density).toBeGreaterThan(0);
  });
});
