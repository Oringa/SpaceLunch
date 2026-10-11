/**
 * Validated JSON import/export of configurations. Imports are checked
 * structurally against the baseline schema (every field present, of the
 * right type, finite) and numerically against the parameter registry
 * ranges, then semantically by building the scenario. Nothing is silently
 * repaired: problems are reported by path.
 */
import { baseConfig } from '../data/defaults';
import { PARAM_BY_PATH } from '../data/registry';
import { MODEL_VERSION, SCHEMA_VERSION, type SimConfig } from './config';

export interface ValidationResult {
  ok: boolean;
  config?: SimConfig;
  errors: string[];
  warnings: string[];
}

export const EXPORT_KIND = 'centrifuge-config';

export function exportConfig(c: SimConfig): string {
  return JSON.stringify({ kind: EXPORT_KIND, schemaVersion: SCHEMA_VERSION, modelVersion: MODEL_VERSION, config: c }, null, 2);
}

function checkShape(ref: unknown, val: unknown, path: string, errors: string[], warnings: string[]): void {
  if (Array.isArray(ref)) {
    if (!Array.isArray(val)) {
      errors.push(`${path}: expected an array.`);
      return;
    }
    // Array element shape: compare to the first reference element when available.
    if (ref.length > 0) for (let i = 0; i < val.length; i++) checkShape(ref[0], val[i], `${path}[${i}]`, errors, warnings);
    return;
  }
  if (ref !== null && typeof ref === 'object') {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) {
      errors.push(`${path || 'config'}: expected an object.`);
      return;
    }
    const r = ref as Record<string, unknown>;
    const v = val as Record<string, unknown>;
    // Discriminated unions (jettison / ignition) are validated by kind below.
    if ('kind' in r && 'kind' in v) {
      checkUnion(path, v, errors);
      return;
    }
    for (const k of Object.keys(r)) {
      if (!(k in v)) {
        if (k === 'missionId') continue;
        errors.push(`${path ? path + '.' : ''}${k}: missing.`);
        continue;
      }
      checkShape(r[k], v[k], path ? `${path}.${k}` : k, errors, warnings);
    }
    for (const k of Object.keys(v)) if (!(k in r) && k !== 'missionId') warnings.push(`${path ? path + '.' : ''}${k}: unknown field ignored.`);
    return;
  }
  if (typeof ref === 'number') {
    if (typeof val !== 'number' || !Number.isFinite(val)) errors.push(`${path}: expected a finite number.`);
    return;
  }
  if (typeof ref === 'string') {
    if (typeof val !== 'string') errors.push(`${path}: expected a string.`);
    return;
  }
  if (typeof ref === 'boolean') {
    if (typeof val !== 'boolean') errors.push(`${path}: expected true/false.`);
  }
}

function checkUnion(path: string, v: Record<string, unknown>, errors: string[]): void {
  const kind = v.kind;
  const num = (k: string): void => {
    if (typeof v[k] !== 'number' || !Number.isFinite(v[k] as number)) errors.push(`${path}.${k}: expected a finite number.`);
  };
  if (path.endsWith('jettison')) {
    if (kind === 'altitude') num('valueM');
    else if (kind !== 'never') errors.push(`${path}.kind: must be 'altitude' or 'never'.`);
  } else if (path.endsWith('ignition')) {
    if (kind === 'altitude') num('valueM');
    else if (kind === 'time-after-release') num('valueS');
    else if (kind === 'vertical-speed-below') num('valueMps');
    else errors.push(`${path}.kind: unknown ignition condition '${String(kind)}'.`);
  }
}

function getPath(o: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o);
}

export function validateConfig(candidate: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  checkShape(baseConfig(), candidate, '', errors, warnings);
  if (errors.length) return { ok: false, errors, warnings };
  const c = candidate as SimConfig;
  if (c.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion ${c.schemaVersion} is not supported (expected ${SCHEMA_VERSION}).`);
  if (c.modelVersion !== MODEL_VERSION) warnings.push(`Saved with model ${c.modelVersion}; running with ${MODEL_VERSION}. Results and records are not comparable across model versions.`);
  for (const [path, def] of Object.entries(PARAM_BY_PATH)) {
    const v = getPath(c, path);
    if (def.kind === 'number' && typeof v === 'number') {
      if (def.min !== undefined && v < def.min) errors.push(`${path}: ${v} is below the allowed minimum ${def.min} ${def.unit.si}.`);
      if (def.max !== undefined && v > def.max) errors.push(`${path}: ${v} is above the allowed maximum ${def.max} ${def.unit.si}.`);
    }
    if (def.kind === 'select' && def.options && typeof v === 'string' && !def.options.some((o) => o.value === v)) {
      errors.push(`${path}: unknown option '${v}'.`);
    }
  }
  return { ok: errors.length === 0, config: errors.length ? undefined : c, errors, warnings };
}

export function importConfig(text: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${(e as Error).message}`], warnings: [] };
  }
  if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).kind === EXPORT_KIND) {
    parsed = (parsed as Record<string, unknown>).config;
  }
  return validateConfig(parsed);
}
