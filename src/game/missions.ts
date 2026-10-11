/**
 * Missions use the same physical kernel as the sandbox. Difficulty changes
 * objectives, budgets and available assistance, never the laws of motion.
 * A mission passes only when the solver's run summary satisfies every
 * objective; animations play no part in the decision.
 */
import type { RunSummary } from '../sim/session';
import type { SimConfig } from '../sim/config';
import type { Scenario } from '../sim/build';

export interface ObjectiveResult {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface MissionResult {
  missionId: string;
  passed: boolean;
  objectives: ObjectiveResult[];
  score: number | null;
  scoreLabel: string;
  /** 0-3 stars (game layer; never affects physics). */
  stars?: number;
  starDetails?: Array<{ label: string; earned: boolean }>;
}

export interface StarTier {
  label: string;
  test: (summary: RunSummary, scenario: Scenario) => boolean;
}

export interface Mission {
  id: string;
  index: number;
  name: string;
  brief: string;
  /** Reference design that is stored and verified to pass. */
  referenceDesign: string;
  /** Constraints shown to the player before launch. */
  constraints: string[];
  /** Star tiers after the pass condition (star 1 = pass). */
  starTiers: [StarTier, StarTier];
  /** Goal altitude shown in the world view (m), if any. */
  goalAltitude?: number;
  evaluate(summary: RunSummary, scenario: Scenario): MissionResult;
}

const km = (m: number): string => `${(m / 1000).toFixed(1)} km`;

function noFailureBefore(summary: RunSummary, t: number | undefined): boolean {
  if (!summary.failure) return true;
  return t !== undefined && summary.failure.t > t;
}

export const MISSIONS: Mission[] = [
  {
    id: 'm1-clean-release',
    index: 1,
    name: 'Clean release',
    brief: 'Release an instrument package cleanly through the exit port and keep it within its load and thermal envelopes through apogee.',
    referenceDesign: 'instrument-hop',
    constraints: ['Phase-locked release', 'Instrument package must survive to apogee'],
    starTiers: [
      { label: 'Apogee ≥ 10 km', test: (s) => s.extrema.maxAltitude.value >= 10_000 },
      { label: 'Apogee ≥ 15 km', test: (s) => s.extrema.maxAltitude.value >= 15_000 },
    ],
    evaluate(sum) {
      const clean = sum.achievements.includes('clean-release');
      const apogeeT = sum.extrema.maxAltitude.t;
      const intact = clean && noFailureBefore(sum, apogeeT) && Number.isFinite(apogeeT);
      const objectives: ObjectiveResult[] = [
        { id: 'clean', label: 'Vehicle clears the exit tunnel', passed: clean, detail: clean ? `minimum clearance ${(sum.extrema.minClearance.value * 100).toFixed(1)} cm` : sum.failure?.message ?? 'not reached' },
        { id: 'intact', label: 'Instrument intact through apogee', passed: intact, detail: intact ? `apogee ${km(sum.extrema.maxAltitude.value)}` : sum.failure?.message ?? 'apogee not reached' },
      ];
      return { missionId: 'm1-clean-release', passed: objectives.every((o) => o.passed), objectives, score: intact ? sum.extrema.minClearance.value * 100 : null, scoreLabel: 'Exit clearance (cm)' };
    },
  },
  {
    id: 'm2-thirty-km',
    index: 2,
    name: 'Thirty kilometres on a budget',
    brief: 'Reach 30 km altitude using no more than 0.60 MWh of electrical energy for spin-up.',
    referenceDesign: 'thirty-km',
    constraints: ['Electrical energy ≤ 0.60 MWh', 'Payload ≥ 5 kg'],
    goalAltitude: 30_000,
    starTiers: [
      { label: 'Apogee ≥ 40 km', test: (s) => s.extrema.maxAltitude.value >= 40_000 },
      { label: 'Use ≤ 0.35 MWh', test: (s) => s.energy.electricalJ / 3.6e9 <= 0.35 },
    ],
    evaluate(sum, sc) {
      const t30 = sum.achievementTimes['alt-30km'];
      const reached = t30 !== undefined && noFailureBefore(sum, t30);
      const eMWh = sum.energy.electricalJ / 3.6e9;
      const energyOk = eMWh <= 0.6;
      const payloadOk = sc.vehicle.payloadMass >= 5;
      const objectives: ObjectiveResult[] = [
        { id: 'alt', label: 'Reach 30 km with the payload intact', passed: reached, detail: reached ? `apogee ${km(sum.extrema.maxAltitude.value)}` : sum.failure?.message ?? `apogee ${km(sum.extrema.maxAltitude.value)}` },
        { id: 'energy', label: 'Electrical energy ≤ 0.60 MWh', passed: energyOk, detail: `${eMWh.toFixed(3)} MWh` },
        { id: 'payload', label: 'Payload ≥ 5 kg', passed: payloadOk, detail: `${sc.vehicle.payloadMass} kg` },
      ];
      const passed = objectives.every((o) => o.passed);
      return { missionId: 'm2-thirty-km', passed, objectives, score: passed ? eMWh : null, scoreLabel: 'Energy used (MWh, lower is better)' };
    },
  },
  {
    id: 'm3-edge-of-space',
    index: 3,
    name: 'Edge of space',
    brief: 'Carry at least 40 kg above 100 km. Note: crossing 100 km is an altitude record, not an orbit.',
    referenceDesign: 'edge-of-space',
    constraints: ['Payload ≥ 40 kg', 'Payload intact at 100 km'],
    goalAltitude: 100_000,
    starTiers: [
      { label: 'Payload ≥ 60 kg', test: (_s, sc) => sc.vehicle.payloadMass >= 60 },
      { label: 'Payload ≥ 80 kg', test: (_s, sc) => sc.vehicle.payloadMass >= 80 },
    ],
    evaluate(sum, sc) {
      const t100 = sum.achievementTimes['alt-100km'];
      const reached = t100 !== undefined && noFailureBefore(sum, t100);
      const payloadOk = sc.vehicle.payloadMass >= 40;
      const objectives: ObjectiveResult[] = [
        { id: 'alt', label: 'Cross 100 km intact', passed: reached, detail: reached ? `apogee ${km(sum.extrema.maxAltitude.value)}` : sum.failure?.message ?? `apogee ${km(sum.extrema.maxAltitude.value)}` },
        { id: 'payload', label: 'Payload ≥ 40 kg', passed: payloadOk, detail: `${sc.vehicle.payloadMass} kg` },
        { id: 'not-orbit', label: 'Understand the result: not an orbit', passed: true, detail: sum.orbit ? 'orbit' : 'Earth-intersecting trajectory' },
      ];
      const passed = reached && payloadOk;
      return { missionId: 'm3-edge-of-space', passed, objectives, score: passed ? sc.vehicle.payloadMass : null, scoreLabel: 'Payload above 100 km (kg)' };
    },
  },
  {
    id: 'm4-leo',
    index: 4,
    name: 'Low Earth orbit',
    brief: 'Place at least 10 kg into a validated orbit with periapsis ≥ 200 km and apoapsis ≤ 1,000 km, using an upper stage.',
    referenceDesign: 'leo-reference',
    constraints: ['Payload ≥ 10 kg', 'Periapsis ≥ 200 km', 'Apoapsis ≤ 1,000 km', 'Validated by one orbit of forward propagation'],
    goalAltitude: 200_000,
    starTiers: [
      { label: 'Payload ≥ 15 kg', test: (_s, sc) => sc.vehicle.payloadMass >= 15 },
      { label: 'Payload ≥ 20 kg', test: (_s, sc) => sc.vehicle.payloadMass >= 20 },
    ],
    evaluate(sum, sc) {
      const o = sum.orbit;
      const bound = !!o && o.bound;
      const periOk = !!o && o.periapsisAltitude >= 200_000;
      const apoOk = !!o && o.apoapsisAltitude <= 1_000_000;
      const validated = !!o && o.validated && !sum.failure;
      const payloadOk = sc.vehicle.payloadMass >= 10;
      const objectives: ObjectiveResult[] = [
        { id: 'bound', label: 'Bound (elliptical) trajectory', passed: bound, detail: o ? o.kind : sum.failure?.message ?? 'no orbit insertion' },
        { id: 'peri', label: 'Periapsis ≥ 200 km', passed: periOk, detail: o ? km(o.periapsisAltitude) : '—' },
        { id: 'apo', label: 'Apoapsis ≤ 1,000 km', passed: apoOk, detail: o ? km(o.apoapsisAltitude) : '—' },
        { id: 'valid', label: 'Survives forward-propagation check', passed: validated, detail: validated ? 'validated' : sum.failure?.message ?? 'not validated' },
        { id: 'payload', label: 'Payload ≥ 10 kg', passed: payloadOk, detail: `${sc.vehicle.payloadMass} kg` },
      ];
      const passed = objectives.every((x) => x.passed);
      return { missionId: 'm4-leo', passed, objectives, score: passed ? sc.vehicle.payloadMass : null, scoreLabel: 'Payload to orbit (kg)' };
    },
  },
  {
    id: 'm5-optimise',
    index: 5,
    name: 'Optimise delivered mass per credit',
    brief: 'Deliver ≥ 15 kg to the Mission 4 orbit while keeping margins: arm stress margin ≥ 1.5, nose temperature ≤ 90 % of its envelope. Score: kg per 1,000 cr of per-launch cost.',
    referenceDesign: 'leo-optimised',
    constraints: ['Payload ≥ 15 kg', 'Arm stress margin ≥ 1.5', 'Peak nose temperature ≤ 90 % of envelope', 'Mission 4 orbit band'],
    goalAltitude: 200_000,
    starTiers: [
      { label: '≥ 3.6 kg per 1,000 cr', test: (_s, sc) => (sc.vehicle.payloadMass / sc.derived.costs.perLaunch) * 1000 >= 3.6 },
      { label: '≥ 4.0 kg per 1,000 cr', test: (_s, sc) => (sc.vehicle.payloadMass / sc.derived.costs.perLaunch) * 1000 >= 4.0 },
    ],
    evaluate(sum, sc) {
      const base = MISSIONS[3].evaluate(sum, sc);
      const stressOk = sc.derived.stressMargin >= 1.5;
      const tLim = sc.vehicle.thermal.noseMaterial.maxTemperatureK;
      const thermalOk = sum.extrema.maxT1.value <= 0.9 * tLim;
      const payloadOk = sc.vehicle.payloadMass >= 15;
      const objectives: ObjectiveResult[] = [
        ...base.objectives.filter((o) => o.id !== 'payload'),
        { id: 'payload', label: 'Payload ≥ 15 kg', passed: payloadOk, detail: `${sc.vehicle.payloadMass} kg` },
        { id: 'stress', label: 'Arm stress margin ≥ 1.5', passed: stressOk, detail: sc.derived.stressMargin.toFixed(2) },
        { id: 'thermal', label: 'Nose ≤ 90 % of thermal envelope', passed: thermalOk, detail: `${sum.extrema.maxT1.value.toFixed(0)} K of ${tLim} K` },
      ];
      const passed = objectives.every((o) => o.passed);
      const score = passed ? (sc.vehicle.payloadMass / sc.derived.costs.perLaunch) * 1000 : null;
      return { missionId: 'm5-optimise', passed, objectives, score, scoreLabel: 'kg per 1,000 cr' };
    },
  },
];

export const missionById = (id: string): Mission | undefined => MISSIONS.find((m) => m.id === id);

/** Evaluate a mission and award 0-3 stars: star 1 = pass, then the two tiers in order. */
export function evaluateWithStars(m: Mission, summary: RunSummary, scenario: Scenario): MissionResult {
  const r = m.evaluate(summary, scenario);
  const t1 = r.passed && m.starTiers[0].test(summary, scenario);
  const t2 = t1 && m.starTiers[1].test(summary, scenario);
  r.stars = r.passed ? 1 + (t1 ? 1 : 0) + (t2 ? 1 : 0) : 0;
  r.starDetails = [
    { label: 'Complete the mission', earned: r.passed },
    { label: m.starTiers[0].label, earned: t1 },
    { label: m.starTiers[1].label, earned: t2 },
  ];
  return r;
}

/**
 * Records are only comparable within the same model version, fidelity,
 * physics toggles and uncertainty setting: a vacuum run never beats an
 * atmosphere record.
 */
export function recordKey(c: SimConfig, missionId: string): string {
  return [missionId, c.modelVersion, c.fidelity, c.physics.atmosphere ? 'atm' : 'VACUUM', c.physics.earthRotation ? 'rot' : 'norot', c.uncertainty.enabled ? 'unc' : 'nom', c.launcher.release.mode].join('|');
}
