/**
 * Provenance classification. Every model, coefficient table and hardware
 * preset carries one of these labels so the interface can tell the player
 * what kind of knowledge a number represents.
 */
export type SourceClass =
  /** A physical law or exact definition (e.g. Newtonian gravity, v = omega R). */
  | 'physical-law'
  /** Values transcribed from a published reference (cited). */
  | 'published-reference'
  /** A documented engineering approximation or correlation with limited validity. */
  | 'engineering-approximation'
  /** Invented game hardware or game rules: plausible, not real. */
  | 'fictional-game-hardware';

export const SOURCE_CLASS_LABEL: Record<SourceClass, string> = {
  'physical-law': 'Physical law',
  'published-reference': 'Published reference data',
  'engineering-approximation': 'Engineering approximation',
  'fictional-game-hardware': 'Fictional game hardware',
};

export const SOURCE_CLASS_SHORT: Record<SourceClass, string> = {
  'physical-law': 'LAW',
  'published-reference': 'REF',
  'engineering-approximation': 'APPROX',
  'fictional-game-hardware': 'GAME',
};

export interface Provenance {
  classification: SourceClass;
  /** Reference keys into SOURCES (e.g. 'R6'). */
  sources: string[];
  /** Free-text note on how the value was obtained and how uncertain it is. */
  note: string;
  /** Optional relative 1-sigma uncertainty used by robustness experiments. */
  relativeUncertainty?: number;
}

export function prov(
  classification: SourceClass,
  sources: string[],
  note: string,
  relativeUncertainty?: number,
): Provenance {
  return { classification, sources, note, relativeUncertainty };
}
