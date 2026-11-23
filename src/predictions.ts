import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { result } from './tools.ts';

/** Status of a recorded prediction lifecycle entry. */
export type PredictionStatus = 'predicted' | 'done' | 'hit' | 'miss';
/** Status of a speculative shadow-staged entry. */
export type StagedStatus = 'staged' | 'accepted' | 'dropped';
/** All statuses stored in predictions.jsonl. */
export type Status = PredictionStatus | StagedStatus;
/** Input for recording a nightly prediction transition. */
export type Input = { day: string; text: string; status: PredictionStatus; evidence?: string; repo?: string };
/** One recorded prediction row in predictions.jsonl. */
export type Prediction = Input & { at: number };
/** One speculative shadow staging/transition row in predictions.jsonl. */
export type StagedEntry = { at: number; id: string; day: string; text: string; repo: string; repoPath?: string; branch: string; brief: string; status: StagedStatus; evidence?: string };
/** Any row stored in predictions.jsonl. */
export type PredictionRow = Prediction | StagedEntry;

const STAGED_STATUSES = new Set<string>(['staged', 'accepted', 'dropped']);
const SAFE_BRANCH = /^[A-Za-z0-9._/-]+$/;
const file = (dir: string) => join(dir, 'predictions.jsonl');
const key = (p: { day: string; text: string }) => JSON.stringify([p.day, p.text]);
const localDate = (at: number) => new Date(at).toLocaleDateString('sv-SE');

/** Stable identifier for a prediction keyed by its day and text. */
export function predictionId(day: string, text: string): string {
  return `pred_${createHash('sha256').update(key({ day, text })).digest('hex').slice(0, 12)}`;
}

/** Type guard distinguishing staged shadow entries from plain prediction rows. */
export function isStagedRow(row: PredictionRow): row is StagedEntry {
  return STAGED_STATUSES.has(row.status);
}

function validBranch(branch: string): boolean {
  if (!branch || branch.length > 120 || !SAFE_BRANCH.test(branch)) return false;
  if (branch.startsWith('/') || branch.endsWith('/') || branch.startsWith('.') || branch.endsWith('.') || branch.startsWith('-') || branch.includes('..') || branch.includes('//')) return false;
  return !/^(?:main|master|head)$/i.test(branch);
}

/** Reads every recorded prediction and staged shadow row from predictions.jsonl. */
export function readPredictions(dir: string): PredictionRow[] {
  let raw: string;
  try { raw = readFileSync(file(dir), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as PredictionRow);
}

/** Appends a validated prediction lifecycle event to predictions.jsonl. */
export function recordPrediction(dir: string, p: Input, at = Date.now()): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.day) || !p.text.trim() || p.text.length > 200 || (p.evidence?.length ?? 0) > 200
    || (p.repo !== undefined && (!p.repo.trim() || p.repo.length > 120))
    || !['predicted', 'done', 'hit', 'miss'].includes(p.status)) throw new Error('Invalid prediction');
  const prior = readPredictions(dir).filter(row => key(row) === key(p));
  if (p.status === 'predicted' ? prior.length > 0 : !prior.some(row => row.status === 'predicted') || prior.some(row => row.status === p.status || row.status === 'hit' || row.status === 'miss')) throw new Error('Invalid prediction transition');
  if (p.status === 'done' && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|commit)\/[\w.-]+$/.test(p.evidence ?? '')) throw new Error('done requires a GitHub PR or commit link');
  if (p.status === 'hit' && !p.evidence?.trim()) throw new Error('hit requires a short matching quote');
  appendFileSync(file(dir), JSON.stringify({ at, ...p }) + '\n', 'utf8');
}

/** Registers a staged shadow entry in predictions.jsonl for an existing unstaged prediction. */
export function stagePrediction(dir: string, input: { day: string; text: string; repo: string; repoPath?: string; branch: string; brief: string }, at = Date.now()): StagedEntry {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day) || !input.text.trim() || !input.repo.trim() || input.repo.length > 120
    || !input.brief.trim() || input.brief.length > 2000 || (input.repoPath !== undefined && !input.repoPath.trim())) throw new Error('Invalid staged prediction');
  if (!validBranch(input.branch)) throw new Error(`Invalid shadow branch: ${input.branch}`);
  const prior = readPredictions(dir).filter(row => key(row) === key(input));
  if (!prior.some(row => row.status === 'predicted') || prior.some(row => row.status !== 'predicted')) throw new Error('Invalid prediction transition');
  const entry: StagedEntry = {
    at,
    id: predictionId(input.day, input.text),
    day: input.day,
    text: input.text,
    repo: input.repo.trim(),
    ...(input.repoPath ? { repoPath: input.repoPath.trim() } : {}),
    branch: input.branch,
    brief: input.brief.trim(),
    status: 'staged',
  };
  appendFileSync(file(dir), JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

/** Transitions an active staged entry to accepted or dropped in predictions.jsonl. */
export function transitionStaged(dir: string, id: string, status: 'accepted' | 'dropped', evidence?: string, at = Date.now()): StagedEntry {
  if (status !== 'accepted' && status !== 'dropped') throw new Error('Invalid staged transition');
  const rows = readPredictions(dir).filter((row): row is StagedEntry => isStagedRow(row) && row.id === id);
  const base = rows.find(row => row.status === 'staged');
  if (!base || rows.some(row => row.status === 'accepted' || row.status === 'dropped')) throw new Error('Invalid staged transition');
  const next: StagedEntry = {
    ...base,
    at,
    status,
    ...(evidence?.trim() ? { evidence: evidence.trim().slice(0, 200) } : {}),
  };
  appendFileSync(file(dir), JSON.stringify(next) + '\n', 'utf8');
  return next;
}

/** Returns the latest state of every staged entry in predictions.jsonl, optionally filtered by status or day. */
export function readStaged(dir: string, filter: { status?: StagedStatus; day?: string } = {}): StagedEntry[] {
  const latest = new Map<string, StagedEntry>();
  for (const row of readPredictions(dir)) {
    if (isStagedRow(row)) latest.set(row.id, row);
  }
  return [...latest.values()].filter(entry => (!filter.status || entry.status === filter.status) && (!filter.day || entry.day === filter.day));
}

/** Staged rows originally created on the given local calendar date (YYYY-MM-DD), for daily cap checks. */
export function stagedOnDay(dir: string, localDay: string): StagedEntry[] {
  return readPredictions(dir).filter((row): row is StagedEntry => isStagedRow(row) && row.status === 'staged' && localDate(row.at) === localDay);
}

export function donePredictions(dir: string, day: string): { text: string; link: string }[] {
  const [year, month, date] = day.split('-').map(Number);
  const midnight = new Date(year!, month! - 1, date!).getTime();
  const previous = new Date(year!, month! - 1, date! - 1).getTime();
  return readPredictions(dir).filter((p): p is Prediction => !isStagedRow(p) && p.day === day && p.status === 'done' && p.at >= previous && p.at < midnight).map(p => ({ text: p.text, link: p.evidence! }));
}

export function predictionWeek(dir: string, from: number, to: number): { hits: number; total: number } | undefined {
  const scored = readPredictions(dir).filter((p): p is Prediction => !isStagedRow(p) && p.at >= from && p.at < to && (p.status === 'hit' || p.status === 'miss'));
  return scored.length ? { hits: scored.filter(p => p.status === 'hit').length, total: scored.length } : undefined;
}

export function predictionsTool(current: () => { dir: string }) {
  return { name: 'predictions', label: 'Nightly predictions', description: 'Read or append predictions; day is the day predicted for. done needs a GitHub PR/commit URL; hit needs a short operator quote.',
    parameters: Type.Object({ day: Type.Optional(Type.String()), text: Type.Optional(Type.String()), status: Type.Optional(Type.Union([Type.Literal('predicted'), Type.Literal('done'), Type.Literal('hit'), Type.Literal('miss')])), evidence: Type.Optional(Type.String()), repo: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id: string, args: { day?: string; text?: string; status?: PredictionStatus; evidence?: string; repo?: string }) {
      const { dir } = current();
      if (!args.status && !args.text && !args.evidence && !args.repo) return result(JSON.stringify(readPredictions(dir).filter(p => !args.day || p.day === args.day)));
      if (!args.day || !args.text || !args.status) throw new Error('day, text and status required');
      recordPrediction(dir, { day: args.day, text: args.text, status: args.status, ...(args.evidence ? { evidence: args.evidence } : {}), ...(args.repo ? { repo: args.repo } : {}) });
      return result('Recorded');
    },
  };
}
