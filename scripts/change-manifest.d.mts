export type MetricDirection = 'lower' | 'higher';
export type ManifestVerdict = 'KEEP' | 'REVERT';
export type ManifestEntryStatus = ManifestVerdict | 'PENDING';

export interface MetricSampleValue {
  value: number;
  lowerIsBetter?: boolean;
  unit?: string;
}

export interface ManifestEntry {
  id: string;
  at: string;
  change: string;
  metric: string;
  before: number;
  direction: MetricDirection;
  unit?: string;
  branch?: string;
  commit?: string;
  pr?: number;
  url?: string;
  after?: number;
  delta?: number;
  verdict?: ManifestVerdict;
  measuredAt?: string;
}

export interface ChangeManifest {
  version: 1;
  entries: ManifestEntry[];
}

export interface RecordChangeInput {
  change: string;
  metric: string;
  before: number;
  direction?: MetricDirection;
  unit?: string;
  branch?: string;
  commit?: string;
  pr?: number;
  url?: string;
  at?: string;
}

export interface VerdictDecision {
  verdict: ManifestVerdict;
  delta: number;
  worse: boolean;
}

export interface EvaluatedEntry {
  id: string;
  status: ManifestEntryStatus;
  evaluated: boolean;
  entry: ManifestEntry;
  suggestion?: string;
}

export interface EvaluateManifestOptions {
  afterValues?: Map<string, number> | Record<string, number>;
  afterValue?: number;
  metricsData?: unknown;
  id?: string;
  metric?: string;
  tolerancePct?: number;
  all?: boolean;
  dryRun?: boolean;
  now?: string;
}

export interface EvaluateManifestResult {
  path: string;
  entries: EvaluatedEntry[];
  summary: { total: number; keep: number; revert: number; pending: number };
}

export const DEFAULT_MANIFEST_FILENAME: string;
export function defaultManifestPath(optchatHome?: string): string;
export function readMetricValue(data: unknown, metric: string): MetricSampleValue | undefined;
export function readMetricFromFile(filePath: string, metric: string): MetricSampleValue;
export function readManifest(filePath: string): ChangeManifest;
export function writeManifest(filePath: string, manifest: ChangeManifest): void;
export function recordChange(filePath: string, input: RecordChangeInput): { entry: ManifestEntry; path: string };
export function decideVerdict(input: { before: number; after: number; direction?: MetricDirection; tolerancePct?: number }): VerdictDecision;
export function evaluateManifest(filePath: string, options?: EvaluateManifestOptions): EvaluateManifestResult;
export function formatVerdicts(results: readonly EvaluatedEntry[]): string;
