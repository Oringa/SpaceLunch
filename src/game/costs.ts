/**
 * Fictional game-credit cost model (1 cr is a notional unit, not a currency
 * conversion). Electricity is only one line of a launch's cost: hardware,
 * consumables, refurbishment and amortised capital are itemised separately.
 * Every price is a game value (classification: fictional game hardware).
 */
import type { Scenario } from '../sim/build';
import {
  BEARING_PRESETS, ENERGY_PRICE_PER_MWH, MEMBRANE_CREDITS, MOTOR_PRESETS, PROPELLANT_CREDITS_PER_KG,
  TPS_MATERIALS, PROTECTION_PRESETS, RCS_PRESETS,
} from '../data/presets';

export interface CostItem {
  name: string;
  credits: number;
  category: 'capital' | 'per-launch';
  note: string;
}

export interface CostBreakdown {
  items: CostItem[];
  perLaunch: number;
  capital: number;
}

export const AMORTISATION_LAUNCHES = 500;
const ARM_FABRICATION_FACTOR = 6;
const CHAMBER_CREDITS_PER_M3 = 0.35;
const PUMP_CREDITS_PER_M3S = 4;
const AEROSHELL_CREDITS_PER_KG = 0.6;

export function estimateCosts(s: Scenario): CostBreakdown {
  const c = s.config;
  const items: CostItem[] = [];
  const add = (name: string, credits: number, category: CostItem['category'], note: string): void => {
    if (Number.isFinite(credits) && credits > 0) items.push({ name, credits, category, note });
  };
  // Capital
  add('Rotor arms', s.rotorDerived.armMass * s.rotor.material.costPerKg * ARM_FABRICATION_FACTOR, 'capital', `${(s.rotorDerived.armMass / 1000).toFixed(1)} t of ${s.rotor.material.name}, x${ARM_FABRICATION_FACTOR} fabrication`);
  add('Drive', MOTOR_PRESETS[c.launcher.motorId].costCredits, 'capital', MOTOR_PRESETS[c.launcher.motorId].name);
  add('Bearings', BEARING_PRESETS[c.launcher.bearingId].costCredits, 'capital', BEARING_PRESETS[c.launcher.bearingId].name);
  add('Vacuum chamber', s.vacuum.volume * CHAMBER_CREDITS_PER_M3, 'capital', `${s.vacuum.volume.toFixed(0)} m³`);
  add('Vacuum pumps', c.launcher.vacuum.pumpSpeedM3s * PUMP_CREDITS_PER_M3S, 'capital', `${c.launcher.vacuum.pumpSpeedM3s} m³/s`);
  const capital = items.reduce((a, i) => a + i.credits, 0);
  // Per launch
  const eMWh = ((Number.isFinite(s.derived.spinupEnergyEstimate) ? s.derived.spinupEnergyEstimate : 0) + (Number.isFinite(s.derived.pump.energyJ) ? s.derived.pump.energyJ : 0)) / 3.6e9;
  add('Electricity', eMWh * ENERGY_PRICE_PER_MWH, 'per-launch', `${eMWh.toFixed(2)} MWh estimated (spin-up + pump-down); regenerative recovery not credited here`);
  const prop = s.stages.reduce((a, st) => a + st.propellantMass, 0) + RCS_PRESETS[c.vehicle.rcsId].propellantMass;
  add('Propellant', prop * PROPELLANT_CREDITS_PER_KG, 'per-launch', `${prop.toFixed(0)} kg`);
  for (const st of s.stages) add(st.name, st.costCredits, 'per-launch', 'Expended upper-stage hardware');
  const shellMass = s.vehicle.aeroshellItems.reduce((a, i) => a + i.mass, 0);
  const prot = PROTECTION_PRESETS[c.vehicle.protectionId];
  const tps = TPS_MATERIALS[prot.noseMaterial];
  add('Aeroshell + TPS', shellMass * AEROSHELL_CREDITS_PER_KG + s.vehicle.noseCapArea * prot.noseThickness * tps.density * tps.costPerKg * 50, 'per-launch', `${shellMass.toFixed(0)} kg expendable aeroshell`);
  add('Exit membrane', MEMBRANE_CREDITS, 'per-launch', 'Replaced every launch');
  add('Cradle refurbishment', s.release.mount.refurbCredits, 'per-launch', s.release.mount.name);
  add('Ballast/catch refurbishment', s.release.balance.refurbCredits, 'per-launch', s.release.balance.name);
  add('Capital amortisation', capital / AMORTISATION_LAUNCHES, 'per-launch', `Capital spread over ${AMORTISATION_LAUNCHES} launches`);
  const perLaunch = items.filter((i) => i.category === 'per-launch').reduce((a, i) => a + i.credits, 0);
  return { items, perLaunch, capital };
}
