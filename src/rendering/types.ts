/**
 * Contract between the interface and the renderer. The renderer only READS
 * these sources once per animation frame; it can never change physical
 * outcomes.
 */
import type { Snapshot } from '../sim/session';
import type { Scenario } from '../sim/build';
import type { TelemetryTable } from '../sim/telemetry';

export type ViewKind = 'launcher' | 'world' | 'orbit';

export interface Overlays {
  forces: boolean;
  atmosphere: boolean;
  predicted: boolean;
  ghosts: boolean;
  labels: boolean;
}

export interface RenderSource {
  /** Latest authoritative snapshot at display time (null before a run starts). */
  snapshot(): Snapshot | null;
  /** Current scenario (geometry, vehicle, rotor); null when the configuration is invalid. */
  scenario(): Scenario | null;
  /** Live flight telemetry recorded so far (channels: t, x, y, z (ECI m), alt, ...). */
  flown(): TelemetryTable | null;
  /** Latest prediction flight telemetry (same channel names subset incl. t, x, y, z, alt). */
  predicted(): TelemetryTable | null;
  ghosts(): Array<{ table: TelemetryTable; color: string; label: string }>;
  view(): ViewKind;
  overlays(): Overlays;
  /** Shared time cursor (simulation seconds) or null. */
  cursorTime(): number | null;
  reducedMotion(): boolean;
  /** Mission orbit band, if the selected mission has one (altitudes in m). */
  orbitBand(): { periapsisMin: number; apoapsisMax: number } | null;
  /** CSS-pixel regions covered by overlay UI; cameras frame the subject in the rest. */
  insets?(): { top: number; bottom: number; left: number; right: number };
  /** 'play' = game presentation (fewer technical captions). */
  variant?(): 'engineer' | 'play';
  /** Mission goal altitude (m) drawn in the world view, or null. */
  goalAltitude?(): number | null;
}

export interface Renderer {
  start(): void;
  stop(): void;
  dispose(): void;
  resize(): void;
  /** Re-centre the camera for the current view. */
  resetCamera(): void;
  readonly kind: 'webgl2' | 'canvas2d';
}
