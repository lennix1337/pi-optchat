export interface WorkerCacheOptions { file: string; since?: string; until?: string; provider?: string; model?: string; json: boolean; runs: boolean }
export interface WorkerRun {
  runId: string; model?: string; provider?: string; date: string; calls: number;
  firstWrite: number; firstRead: number; firstInput: number; totalWrite: number; totalWrite1h: number; totalRead: number; cost: number; writeCost: number;
}
export interface Stat { median: number | undefined; p90: number | undefined; sum: number }
export interface WorkerCacheSummary {
  runs: number; calls: number; firstCallWarm: number; totalWrite1h: number;
  firstWrite: Stat; firstRead: Stat; totalWrite: Stat; cost: Stat; writeCost: Stat;
}
export const DEFAULT_FILE: string;
export function parseArgs(argv: readonly string[]): WorkerCacheOptions;
export function quantile(values: readonly number[], q: number): number | undefined;
export function runFolder(options?: Partial<WorkerCacheOptions>): { add(row: unknown): void; runs(): WorkerRun[] };
export function foldRuns(rows: readonly unknown[], options?: Partial<WorkerCacheOptions>): WorkerRun[];
export function summarize(runs: readonly WorkerRun[]): WorkerCacheSummary;
export function render(summary: WorkerCacheSummary, options: Partial<WorkerCacheOptions>): string;
