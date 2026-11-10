export interface CrewStatsRow { role: string; model: string; calls: number; cost: number; tokensPerCall: number }
export interface CrewStats { opusMain: { calls: number; cost: number }; total: number; rows: CrewStatsRow[] }
export function crewStats(lines: readonly string[], sinceMs?: number, untilMs?: number): CrewStats;

/** A metric whose source is missing is the string "unavailable", never 0. */
export type Unavailable = 'unavailable';
export interface WorkerMetrics {
  contractWorkers: number;
  sessionsMissing: number;
  toolCalls: number;
  reads: number;
  reReads: number;
  reReadsByProject: Record<string, number>;
  tellParent: number;
  tellPeer: number;
  contextPerCall: number | Unavailable;
  firstCallContextMedian: number | Unavailable;
}
export interface WakeMetrics {
  total: number;
  done: number;
  empty: number;
  errors: number;
  quotaErrors: number;
  interrupted: number;
  daily: { wakes: number; errors: number; skippedQuota: number; skippedIdle: number } | Unavailable;
}
export interface ManagerMetrics { tells: number; spawns: number; workerMessages: number }
export interface CrewMetrics {
  opusMain: CrewStats['opusMain'] | Unavailable;
  total: number | Unavailable;
  rows: CrewStatsRow[] | Unavailable;
  workers: WorkerMetrics | Unavailable;
  wakes: WakeMetrics | Unavailable;
  manager: ManagerMetrics | Unavailable;
}
export function crewMetrics(profileDir: string, sinceMs?: number, untilMs?: number, options?: { wakesFile?: string }): CrewMetrics;

export interface MetricComparison { current?: number | Unavailable; baseline?: number | Unavailable; delta?: number }
export function compareMetrics(current: unknown, baseline: unknown): Record<string, MetricComparison>;
