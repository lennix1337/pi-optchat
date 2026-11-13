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
