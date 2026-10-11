/**
 * Typed messages between the interface and the simulation workers.
 * Every message carries runId/jobId and configVersion so stale results from
 * superseded configurations can be rejected. Telemetry travels as
 * transferable Float64Array column batches; nothing requires
 * SharedArrayBuffer or cross-origin isolation.
 */
import type { SimConfig } from '../sim/config';
import type { BuildIssue, DerivedSummary } from '../sim/build';
import type { CommandKind, RunSummary, SimEvent, Snapshot, TimedCommand, Phase } from '../sim/session';

export type PlaybackMode = { auto: true } | { auto: false; rate: number };

export type ToWorker =
  | { type: 'init'; runId: number; configVersion: number; config: SimConfig; commands?: TimedCommand[] }
  | { type: 'playback'; runId: number; playing: boolean; mode: PlaybackMode }
  | { type: 'command'; runId: number; kind: CommandKind }
  | { type: 'skip-to'; runId: number; phase: 'release' | 'end' }
  | { type: 'stop'; runId: number }
  | { type: 'predict'; jobId: number; configVersion: number; config: SimConfig }
  | { type: 'batch'; jobId: number; configVersion: number; label: string; configs: SimConfig[]; tags: unknown[] }
  | { type: 'cancel'; jobId: number };

export interface TelemetryBatch {
  table: 'rotor' | 'flight';
  from: number;
  channels: readonly string[];
  columns: Float64Array[];
}

export interface PlaybackState {
  playing: boolean;
  auto: boolean;
  /** Simulated seconds per wall second currently applied. */
  rate: number;
  /** True when the solver could not keep up and display time was held back. */
  computeLimited: boolean;
}

export type FromWorker =
  | { type: 'ready'; runId: number; configVersion: number; issues: BuildIssue[]; derived: DerivedSummary }
  | { type: 'rejected'; runId: number; configVersion: number; issues: BuildIssue[]; message: string }
  | { type: 'snapshot'; runId: number; configVersion: number; snapshot: Snapshot; playback: PlaybackState; frontier: number }
  | { type: 'telemetry'; runId: number; batch: TelemetryBatch }
  | { type: 'events'; runId: number; from: number; events: SimEvent[] }
  | { type: 'finished'; runId: number; configVersion: number; summary: RunSummary; commandLog: TimedCommand[] }
  | { type: 'progress'; jobId: number; configVersion: number; fraction: number; label: string; phase?: Phase }
  | { type: 'prediction'; jobId: number; configVersion: number; summary: RunSummary; events: SimEvent[]; flight: TelemetryBatch; rotor: TelemetryBatch; issues: BuildIssue[]; wallMs: number }
  | { type: 'prediction-failed'; jobId: number; configVersion: number; issues: BuildIssue[]; message: string }
  | { type: 'batch-result'; jobId: number; configVersion: number; label: string; results: Array<{ tag: unknown; summary?: RunSummary; error?: string }>; wallMs: number }
  | { type: 'cancelled'; jobId: number }
  | { type: 'error'; id: number; message: string };

/** Flight channels shipped with a prediction (subset keeps transfers small). */
export const PREDICTION_CHANNELS = [
  't', 'phase', 'x', 'y', 'z', 'alt', 'downrange', 'vAir', 'vInertial', 'mach', 'q', 'alphaDeg', 'axialG', 'lateralG', 'payloadLatG',
  'heatFlux', 'heatLoad', 'T1', 'T3', 'T4', 'mass', 'prop', 'thrust', 'peri', 'apo', 'clearance', 'lat', 'lon',
] as const;

/**
 * Tracks the newest job per channel and rejects anything older. Pure logic,
 * shared by the interface and tested headlessly.
 */
export class LatestJobTracker {
  private latestJob = 0;
  private latestVersion = 0;
  next(configVersion: number): number {
    this.latestJob += 1;
    this.latestVersion = configVersion;
    return this.latestJob;
  }
  get current(): { jobId: number; configVersion: number } {
    return { jobId: this.latestJob, configVersion: this.latestVersion };
  }
  /** True only for results of the newest job built from the newest config. */
  accept(msg: { jobId: number; configVersion: number }): boolean {
    return msg.jobId === this.latestJob && msg.configVersion === this.latestVersion;
  }
}
