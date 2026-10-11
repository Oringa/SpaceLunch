import { baseConfig } from '../data/defaults';
import { buildScenario, type Scenario } from '../sim/build';
import { FlightModel, FS, type FlightDiscrete, type Fidelity } from '../physics/flight';
import { MassModel } from '../physics/vehicle';
import { standardAtmosphere, type AtmosphereModel, type AtmosphereSample } from '../physics/atmosphere';
import { Dopri5 } from '../physics/integrator';
import type { AeroFamily } from '../physics/aero';
import type { SimConfig } from '../sim/config';

export function constantAtmosphere(rho: number): AtmosphereModel {
  return {
    perturbed: false,
    description: 'constant test atmosphere',
    sample(_z: number, out: AtmosphereSample): AtmosphereSample {
      out.density = rho;
      out.temperature = 288.15;
      out.pressure = 101325;
      out.speedOfSound = 340.3;
      out.meanFreePath = 6.6e-8;
      return out;
    },
  };
}

export function flatFamily(cd: number): AeroFamily {
  const n = 3;
  return {
    id: 'flat-test', name: 'Constant-Cd test family', description: 'test', provenance: { classification: 'engineering-approximation', sources: [], note: 'test' },
    nose: 'ogive', noseLengthCalibers: 3, maxNoseRadiusFraction: 0.5,
    mach: [0, 10, 30], cd0: new Array(n).fill(cd), cnAlpha: new Array(n).fill(2), xcpFrac: new Array(n).fill(0.6),
    cdBackward: cd, crossflowMach: [0, 30], crossflowCd: [1.2, 1.2], eta: 0.7, planformFactor: 0.9, planformCentroidFrac: 0.55,
    bodyHeatingFraction: 0.03, applicability: { machMax: 30, finenessMin: 1, finenessMax: 30, reliableAlphaDeg: 90 },
  };
}

export interface FlightRig {
  scenario: Scenario;
  model: FlightModel;
  integ: Dopri5;
  y0: Float64Array;
}

export function makeRig(opts: {
  config?: SimConfig;
  fidelity?: Fidelity;
  gravity?: boolean;
  atmosphere?: AtmosphereModel | null;
  rotating?: boolean;
  family?: AeroFamily;
  discrete?: Partial<FlightDiscrete>;
  rtol?: number;
  hMax?: number;
}): FlightRig {
  const c = opts.config ?? baseConfig();
  c.fidelity = opts.fidelity ?? 'engineering';
  const s = buildScenario(c);
  if (opts.family) s.vehicle.family = opts.family;
  const mm = new MassModel(s.vehicle);
  const discrete: FlightDiscrete = {
    environment: 'atmosphere', aeroshellAttached: true, activeStage: s.stages.length ? 0 : -1, engineOn: false, throttle: 1,
    attitudeMode: 'passive', ignitionTime: 0, ...opts.discrete,
  };
  const model = new FlightModel(
    {
      gravity: opts.gravity ?? true,
      atmosphere: opts.atmosphere ?? standardAtmosphere,
      wind: { enabled: false, layers: [], structure: [] },
      atmosphereEnabled: opts.atmosphere !== null,
      earthRotation: opts.rotating ?? false,
      chamberDensity: 0, chamberTemperature: 293, chamberPressure: 0, terrainAltitude: 0,
    },
    s.vehicle, mm, s.guidance, c.fidelity, discrete,
  );
  const atol = new Float64Array(FS.N).fill(1e-3);
  atol[0] = atol[1] = atol[2] = 1e-6;
  atol[3] = atol[4] = atol[5] = 1e-9;
  for (let i = 6; i <= 12; i++) atol[i] = 1e-12;
  atol[FS.HEATLOAD] = 1e9; atol[FS.AEROWORK] = 1e12; atol[FS.THRUSTDV] = 1e9;
  const integ = new Dopri5(FS.N, model.deriv, { rtol: opts.rtol ?? 1e-11, atol, hMax: opts.hMax ?? 10, hMin: 1e-14 });
  const y0 = new Float64Array(FS.N);
  y0[FS.QW] = 1;
  y0[FS.T1] = y0[FS.T2] = y0[FS.T3] = y0[FS.T4] = 290;
  y0[FS.MPROP] = s.stages.length ? s.stages[0].propellantMass : 0;
  return { scenario: s, model, integ, y0 };
}
