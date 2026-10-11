/**
 * Game progression (Play mode only): missions unlock in order and hardware
 * presets unlock as missions are completed. This restricts which parts are
 * offered, never how they behave. Sandbox and Engineer mode offer everything.
 */
import { MISSIONS } from './missions';

/** Preset id -> mission that must be completed to unlock it. Absent = always available. */
export const PART_UNLOCK_AFTER: Record<string, string> = {
  // after Mission 1
  'drive-8mw': 'm1-clean-release',
  'hydrodynamic-large': 'm1-clean-release',
  'cc-standard': 'm1-clean-release',
  'blunted-cone': 'm1-clean-release',
  // after Mission 2
  'drive-25mw': 'm2-thirty-km',
  'ballast-release': 'm2-thirty-km',
  'kick-solid': 'm2-thirty-km',
  'magnetic-active': 'm2-thirty-km',
  // after Mission 3
  'drive-50mw': 'm3-edge-of-space',
  'uhtc-heavy': 'm3-edge-of-space',
  l1: 'm3-edge-of-space',
  'l1-l2': 'm3-edge-of-space',
  'l1lt-l2': 'm3-edge-of-space',
  hydrazine: 'm3-edge-of-space',
  'smallsat-hardened': 'm3-edge-of-space',
  // after Mission 4
  'fiction-cnt': 'm4-leo',
};

export type Completed = Record<string, number>;

export function partUnlocked(presetId: string, completed: Completed, sandbox: boolean): boolean {
  if (sandbox) return true;
  const after = PART_UNLOCK_AFTER[presetId];
  return !after || (completed[after] ?? 0) > 0;
}

export function unlockHint(presetId: string): string | null {
  const after = PART_UNLOCK_AFTER[presetId];
  if (!after) return null;
  const m = MISSIONS.find((x) => x.id === after);
  return m ? `Complete Mission ${m.index}` : null;
}

export function missionUnlocked(missionId: string, completed: Completed): boolean {
  const m = MISSIONS.find((x) => x.id === missionId);
  if (!m || m.index === 1) return true;
  const prev = MISSIONS.find((x) => x.index === m.index - 1)!;
  return (completed[prev.id] ?? 0) > 0;
}

export function totalStars(completed: Completed): number {
  return Object.values(completed).reduce((a, b) => a + b, 0);
}

/** Parts newly unlocked by completing a mission (for the results card). */
export function unlocksFor(missionId: string): string[] {
  return Object.entries(PART_UNLOCK_AFTER).filter(([, m]) => m === missionId).map(([p]) => p);
}
