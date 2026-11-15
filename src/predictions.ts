import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { result } from './tools.ts';

type Status = 'predicted' | 'done' | 'hit' | 'miss';
type Input = { day: string; text: string; status: Status; evidence?: string };
type Prediction = Input & { at: number };
const file = (dir: string) => join(dir, 'predictions.jsonl');
const key = (p: Input) => JSON.stringify([p.day, p.text]);
export function readPredictions(dir: string): Prediction[] {
  let raw: string;
  try { raw = readFileSync(file(dir), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as Prediction);
}
export function recordPrediction(dir: string, p: Input, at = Date.now()): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.day) || !p.text.trim() || p.text.length > 200 || (p.evidence?.length ?? 0) > 200 || !['predicted', 'done', 'hit', 'miss'].includes(p.status)) throw new Error('Invalid prediction');
  const prior = readPredictions(dir).filter(row => key(row) === key(p));
  if (p.status === 'predicted' ? prior.length > 0 : !prior.some(row => row.status === 'predicted') || prior.some(row => row.status === p.status || row.status === 'hit' || row.status === 'miss')) throw new Error('Invalid prediction transition');
  if (p.status === 'done' && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|commit)\/[\w.-]+$/.test(p.evidence ?? '')) throw new Error('done requires a GitHub PR or commit link');
  if (p.status === 'hit' && !p.evidence?.trim()) throw new Error('hit requires a short matching quote');
  appendFileSync(file(dir), JSON.stringify({ at, ...p }) + '\n', 'utf8');
}
export function donePredictions(dir: string, day: string): { text: string; link: string }[] {
  const [year, month, date] = day.split('-').map(Number);
  const midnight = new Date(year!, month! - 1, date!).getTime();
  const previous = new Date(year!, month! - 1, date! - 1).getTime();
  return readPredictions(dir).filter(p => p.day === day && p.status === 'done' && p.at >= previous && p.at < midnight).map(p => ({ text: p.text, link: p.evidence! }));
}
export function predictionWeek(dir: string, from: number, to: number): { hits: number; total: number } | undefined {
  const scored = readPredictions(dir).filter(p => p.at >= from && p.at < to && (p.status === 'hit' || p.status === 'miss'));
  return scored.length ? { hits: scored.filter(p => p.status === 'hit').length, total: scored.length } : undefined;
}
export function predictionsTool(current: () => { dir: string }) {
  return { name: 'predictions', label: 'Nightly predictions', description: 'Read or append predictions; day is the day predicted for. done needs a GitHub PR/commit URL; hit needs a short operator quote.',
    parameters: Type.Object({ day: Type.Optional(Type.String()), text: Type.Optional(Type.String()), status: Type.Optional(Type.Union([Type.Literal('predicted'), Type.Literal('done'), Type.Literal('hit'), Type.Literal('miss')])), evidence: Type.Optional(Type.String()) }, { additionalProperties: false }),
    async execute(_id: string, args: { day?: string; text?: string; status?: Status; evidence?: string }) {
      const { dir } = current();
      if (!args.status && !args.text && !args.evidence) return result(JSON.stringify(readPredictions(dir).filter(p => !args.day || p.day === args.day)));
      if (!args.day || !args.text || !args.status) throw new Error('day, text and status required');
      recordPrediction(dir, { day: args.day, text: args.text, status: args.status, ...(args.evidence ? { evidence: args.evidence } : {}) });
      return result('Recorded');
    },
  };
}
