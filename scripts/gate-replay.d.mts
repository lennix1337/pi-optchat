import type { Contract, Decision, Effect, Repo } from '../src/autonomy.ts';

export type ReplayOutcome = 'approved' | 'denied' | 'unanswered';
export type ReplayLabel = 'needed' | 'needless-still-asks' | 'fixed';

export interface ExtractedGateAsk {
  id: string;
  timestamp: string;
  cwd: string;
  tool: string;
  input: Record<string, unknown>;
  command: string;
  actions: string[];
  rule?: string;
  outcome: ReplayOutcome;
  sourceFile?: string;
}

export interface ReplayDetail {
  wouldAsk: boolean;
  touchesContract: boolean;
  effects: Effect[];
  decision?: Decision;
  selfEditReason?: string;
}

export interface ReplayedAsk extends ExtractedGateAsk {
  replay: ReplayDetail;
  label: ReplayLabel;
}

export interface ReplaySummary {
  total: number;
  byLabel: Record<ReplayLabel, number>;
  byOutcome: Record<ReplayOutcome, number>;
  byAction: Record<string, { total: number; needed: number; 'needless-still-asks': number; fixed: number }>;
  byWeek: Record<string, { total: number; needed: number; 'needless-still-asks': number; fixed: number }>;
  topNeedless: Array<{ pattern: string; count: number; action: string; rule: string; example: string }>;
}

export function parseAskMeta(text: string): { actions: string[]; rule?: string };
export function extractGateAsks(sessionsDir: string): ExtractedGateAsk[];
export function labelReplayItem(
  item: Pick<ExtractedGateAsk, 'tool' | 'input' | 'command'>,
  replay: Pick<ReplayDetail, 'wouldAsk' | 'touchesContract' | 'effects'>,
): ReplayLabel;
export function redactSecrets(text: string): string;
export function replayAsks(
  asks: ExtractedGateAsk[],
  options: { contract: Contract; contractDir?: string; repo?: Repo },
): ReplayedAsk[];
export function summarizeReplay(replayed: ReplayedAsk[]): ReplaySummary;

export interface RuleReplayEntry {
  caught: number;
  detected: number;
  falseFlags: number;
}

export interface RuleReplayBaseline {
  version: 1;
  updatedAt: string;
  windowDays: number;
  rules: Record<string, RuleReplayEntry>;
}

export interface RuleReplayRegression {
  id: string;
  kind: 'caught-dropped' | 'detected-dropped' | 'false-flags-rose';
  baseline: number;
  current: number;
}

export interface RuleReplayImprovement {
  id: string;
  kind: 'caught-rose' | 'detected-rose' | 'false-flags-dropped';
  baseline: number;
  current: number;
}

export interface RuleReplayComparison {
  passed: boolean;
  hasBaseline: boolean;
  sessionsMissing: boolean;
  windowDays: number;
  rules: Record<string, RuleReplayEntry>;
  regressions: RuleReplayRegression[];
  improvements: RuleReplayImprovement[];
}

export interface RunRuleReplayOptions {
  sessionsDir?: string;
  goodSample?: string;
  baselinePath?: string;
  windowDays?: number;
  now?: number;
  update?: boolean;
  scan?: (dir: string, since: number, until: number) => Array<{ id: string; count: number; afterGuard?: number; caught?: number; detected?: number }>;
}

export interface RunRuleReplayResult {
  passed: boolean;
  updated: boolean;
  baselinePath: string;
  sessionsMissing: boolean;
  goodMissing: boolean;
  comparison: RuleReplayComparison;
}

export const DEFAULT_WINDOW_DAYS: number;
export const DEFAULT_GOOD_SAMPLE: string;
export function defaultBaselinePath(root?: string): string;
export function buildRuleSnapshot(
  sessionRows: ReadonlyArray<{ id: string; count: number; caught?: number; detected?: number }>,
  goodRows: ReadonlyArray<{ id: string; count: number; caught?: number; detected?: number }>,
): Record<string, RuleReplayEntry>;
export function readRuleBaseline(baselinePath: string): RuleReplayBaseline | undefined;
export function writeRuleBaseline(
  baselinePath: string,
  rulesMap: Record<string, RuleReplayEntry>,
  options?: { windowDays?: number; now?: number },
): RuleReplayBaseline;
export function compareRuleReplay(
  current: Record<string, RuleReplayEntry>,
  baseline: RuleReplayBaseline | undefined,
  options?: { sessionsMissing?: boolean; windowDays?: number },
): RuleReplayComparison;
export function runRuleReplay(options?: RunRuleReplayOptions): RunRuleReplayResult;
export function formatRuleReplay(result: RunRuleReplayResult): string;
