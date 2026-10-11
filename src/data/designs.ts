/**
 * Reference designs. Each mission has a stored configuration that the solver
 * must pass (tests/missions.test.ts), and each failure class has a
 * deterministic failing configuration (tests/failures.test.ts). None of them
 * is accepted because an animation says so: they are checked by running the
 * same kernel the game uses.
 */
import { cloneConfig, type SimConfig } from '../sim/config';
import { baseConfig } from './defaults';

/** Small 33 m-class facility: quick to spin, gentle loads. Used for the first-load easy preset. */
export function instrumentHop(): SimConfig {
  const c = baseConfig();
  c.name = 'Instrument hop (easy preset)';
  const L = c.launcher;
  L.armRadiusM = 15;
  L.chamberRadiusM = 16.5;
  L.chamberDepthM = 3;
  L.targetTipSpeedMps = 1000;
  L.arm = { materialId: 'cfrp-ud', profile: 'constant-stress', rootAreaM2: 0.04, tipAreaM2: 0.005, sectionAspect: 4 };
  L.hubInertiaKgM2 = 2e3;
  L.motorId = 'drive-1mw';
  L.bearingId = 'hydrodynamic-small';
  L.balanceId = 'fixed-static';
  L.vacuum.pumpSpeedM3s = 60;
  L.vacuum.pumpPowerW = 120e3;
  L.exit.apertureRadiusM = 0.25;
  L.exit.tunnelLengthM = 6;
  L.exit.membraneArealDensityKgM2 = 0.1;
  const V = c.vehicle;
  V.payloadMassKg = 3;
  V.payloadId = 'instrument-hardened';
  V.lengthM = 1.3;
  V.diameterM = 0.12;
  V.noseRadiusM = 0.02;
  V.airframeArealMassKgM2 = 10;
  V.fairingMassKg = 1;
  V.mountingMassKg = 0.5;
  V.protectionId = 'ti-light';
  V.maxNormalForceN = 8e3;
  c.flightPlan.elevationDeg = 70;
  return c;
}

/** Mission 2: mid-size facility reaching 30 km within an energy allowance. */
export function thirtyKm(): SimConfig {
  const c = instrumentHop();
  c.name = 'Thirty-kilometre sounder';
  const L = c.launcher;
  L.armRadiusM = 25;
  L.chamberRadiusM = 27;
  L.chamberDepthM = 4;
  L.targetTipSpeedMps = 1500;
  L.arm = { materialId: 'cfrp-ud', profile: 'constant-stress', rootAreaM2: 0.12, tipAreaM2: 0.012, sectionAspect: 4 };
  L.hubInertiaKgM2 = 1e4;
  L.motorId = 'drive-8mw';
  L.bearingId = 'hydrodynamic-large';
  L.vacuum.pumpSpeedM3s = 150;
  L.vacuum.pumpPowerW = 250e3;
  L.exit.apertureRadiusM = 0.32;
  L.exit.tunnelLengthM = 8;
  const V = c.vehicle;
  V.payloadMassKg = 10;
  V.lengthM = 2.0;
  V.diameterM = 0.16;
  V.noseRadiusM = 0.025;
  V.airframeArealMassKgM2 = 12;
  V.fairingMassKg = 2;
  V.mountingMassKg = 1;
  V.protectionId = 'cc-standard';
  V.maxNormalForceN = 2e4;
  c.flightPlan.elevationDeg = 75;
  return c;
}

/** Mission 3: cross 100 km with a 40 kg payload. */
export function edgeOfSpace(): SimConfig {
  const c = baseConfig();
  c.name = 'Edge-of-space hop';
  c.vehicle.payloadMassKg = 60;
  c.vehicle.lengthM = 3.2;
  c.vehicle.diameterM = 0.26;
  c.flightPlan.elevationDeg = 80;
  c.launcher.targetTipSpeedMps = 2100;
  return c;
}

/** Mission 4: low Earth orbit with a two-stage liquid upper stage. */
export function leoReference(): SimConfig {
  const c = baseConfig();
  c.name = 'LEO reference';
  const L = c.launcher;
  L.targetTipSpeedMps = 2222;
  L.arm = { materialId: 'cfrp-ud', profile: 'constant-stress', rootAreaM2: 2.6, tipAreaM2: 0.13, sectionAspect: 4 };
  L.motorId = 'drive-50mw';
  L.bearingId = 'hydrodynamic-large';
  L.chamberRadiusM = 54;
  L.exit.apertureRadiusM = 0.75;
  const V = c.vehicle;
  V.payloadMassKg = 12;
  V.payloadId = 'smallsat-hardened';
  V.aeroFamilyId = 'blunted-cone';
  V.finsId = 'small-tail';
  V.lengthM = 5.6;
  V.diameterM = 0.6;
  V.noseRadiusM = 0.06;
  V.stackId = 'l1-l2';
  V.rcsId = 'hydrazine';
  V.maxNormalForceN = 4e5;
  const F = c.flightPlan;
  F.elevationDeg = 60;
  F.jettison = { kind: 'altitude', valueM: 60_000 };
  F.guidance.mode = 'assisted-insertion';
  F.guidance.ignition = { kind: 'altitude', valueM: 62_000 };
  F.guidance.targetAltitudeM = 260_000;
  F.guidance.cutoffPeriapsisM = 205_000;
  return c;
}

/** Mission 5 reference: more payload, same machine, margins kept. */
export function leoOptimised(): SimConfig {
  const c = leoReference();
  c.name = 'LEO optimised (18 kg)';
  c.vehicle.payloadMassKg = 18;
  return c;
}

export interface DesignEntry {
  id: string;
  name: string;
  summary: string;
  make: () => SimConfig;
}

export const DESIGNS: DesignEntry[] = [
  { id: 'instrument-hop', name: 'Instrument hop', summary: '15 m arm, 1 km/s, 3 kg instrument. Fast to spin up; the easy first launch.', make: instrumentHop },
  { id: 'thirty-km', name: 'Thirty-kilometre sounder', summary: '25 m arm, 1.5 km/s, 10 kg payload to the stratosphere.', make: thirtyKm },
  { id: 'edge-of-space', name: 'Edge-of-space hop', summary: '50 m arm, 2.1 km/s, near-vertical: above 100 km but Earth-intersecting.', make: edgeOfSpace },
  { id: 'leo-reference', name: 'LEO reference', summary: '50 m arm at 2.22 km/s (8,000 km/h scale) plus a two-stage liquid upper stage.', make: leoReference },
  { id: 'leo-optimised', name: 'LEO optimised', summary: 'Same machine; 18 kg payload with margins kept (Mission 5 reference).', make: leoOptimised },
];

export function designById(id: string): SimConfig {
  const d = DESIGNS.find((x) => x.id === id);
  if (!d) throw new Error(`Unknown design ${id}`);
  return cloneConfig(d.make());
}
