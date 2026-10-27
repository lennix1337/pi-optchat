import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry } from './memory.ts';
import { record } from './cache.ts';
import { atomicWrite } from './store.ts';
import { observations, type ObservedCheck, type ObservedPR } from './catchup-evidence.ts';

export interface CatchupSpan { id: string; from: number; to: number; start: string; end: string; provenance: 'interactive' | 'explicit-range' }
interface Cursor { cursor: number; at: string }
interface Saved { version: 1; last?: Cursor; spans: CatchupSpan[]; omitted: number }
const index = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const at = Date.parse(value);
  return Number.isFinite(at) && new Date(at).toISOString() === value;
}
const cursor = (v: unknown): v is Cursor => record(v) && index(v.cursor) && validTimestamp(v.at);
const validSpan = (v: unknown): v is CatchupSpan => record(v) && index(v.from) && index(v.to) && v.to >= v.from && v.id === `${v.from}-${v.to}` && validTimestamp(v.start) && validTimestamp(v.end) && ['interactive', 'explicit-range'].includes(String(v.provenance));
const HISTORY = 32;

/** Only input-provenance hooks advance this cursor. Opening a report never acknowledges or changes it. */
export class CatchupWindows {
  private readonly file: string;
  private saved: Saved;
  constructor(dir: string) {
    this.file = join(dir, 'catchup.json');
    let saved: unknown = { version: 1, spans: [], omitted: 0 };
    try { if (existsSync(this.file)) saved = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch { throw new Error('Invalid catch-up journal. Inspect catchup.json; no boundary was changed.'); }
    if (!record(saved) || saved.version !== 1 || saved.last !== undefined && !cursor(saved.last)
      || !Array.isArray(saved.spans) || saved.spans.length > HISTORY || !saved.spans.every(validSpan) || !index(saved.omitted))
      throw new Error('Invalid catch-up journal. Inspect catchup.json; no boundary was changed.');
    this.saved = saved as unknown as Saved;
  }
  get omitted() { return this.saved.omitted; }
  latest() { return this.saved.spans.at(-1); }
  history() { return this.saved.spans.toReversed(); }
  live(to: number, at: string): CatchupSpan | undefined {
    const last = this.saved.last;
    if (!last) return undefined;
    if (!index(to) || to < last.cursor) throw new Error('Catch-up cursor exceeds the transcript: memory may have been replaced. Inspect catchup.json before resuming tracking.');
    return { id: `${last.cursor}-${to}`, from: last.cursor, to, start: last.at, end: at, provenance: 'interactive' };
  }
  arrive(to: number, at: string) {
    if (!index(to) || !validTimestamp(at)) throw new Error('Invalid catch-up input cursor/date.');
    const span = this.live(to, at), spans = [...this.saved.spans, ...span ? [span] : []];
    const next: Saved = { version: 1, last: { cursor: to, at }, spans: spans.slice(-HISTORY), omitted: this.saved.omitted + Math.max(0, spans.length - HISTORY) };
    atomicWrite(this.file, JSON.stringify(next));
    this.saved = next;
    return span;
  }
}

function range(entries: readonly Entry[], span: CatchupSpan) {
  if (!validSpan(span) || span.to > entries.length) throw new Error('Catch-up range is outside the original transcript. No complete report is available for this interval.');
  return entries.slice(span.from, span.to);
}
export interface CatchupReport {
  span: CatchupSpan; covered: number; tools: number; results: number;
  wakes: { source: number; at: string; reply?: number }[];
  replies: { source: number; at: string; text: string }[];
  prs: ObservedPR[]; checks: ObservedCheck[];
}

/** Linear scan over original messages already in memory; no disk scan, model, network, or semantic success inference. */
export function buildCatchup(entries: readonly Entry[], span: CatchupSpan): CatchupReport {
  const rows = range(entries, span), prs = new Map<string, ObservedPR>(), checks = new Map<string, ObservedCheck>();
  const report: CatchupReport = { span, covered: rows.length, tools: 0, results: 0, wakes: [], replies: [], prs: [], checks: [] };
  let latestReply: Entry | undefined;
  const finish = () => { if (latestReply) report.replies.push({ source: latestReply.i, at: latestReply.date, text: preview(latestReply.text, 240) }); latestReply = undefined; };
  for (const entry of rows) {
    if (entry.kind === 'tool') report.tools++;
    if (entry.kind === 'echo') {
      report.results++;
      const observed = observations(entry.text, entry.i, entry.date);
      for (const pr of observed.prs) prs.set(pr.url, pr);
      for (const check of observed.checks) checks.set(`${check.root}\0${check.name}`, check);
    }
    if (entry.kind === 'work' && entry.text.startsWith('[OptChat heartbeat]')) {
      finish(); report.wakes.push({ source: entry.i, at: entry.date });
    }
    if (entry.kind === 'talk') {
      latestReply = entry;
      const wake = report.wakes.at(-1);
      if (wake) wake.reply = entry.i;
    }
  }
  finish(); report.prs = [...prs.values()]; report.checks = [...checks.values()];
  return report;
}

/** Exact event pages, with bounded previews and explicit zoom retrieval for every original. */
export function catchupPage(entries: readonly Entry[], span: CatchupSpan, offset = 0, limit = 20) {
  const rows = range(entries, span);
  if (!index(offset) || offset > rows.length) throw new Error(`Invalid offset: use 0..${rows.length}.`);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid limit: use 1..50.');
  const items = rows.slice(offset, offset + limit).map(entry => ({ i: entry.i, kind: entry.kind, at: entry.date,
    preview: entry.kind === 'tool' || entry.kind === 'echo' ? `${entry.text.split(/[\s:]/, 1)[0]} · open original for arguments/output`
      : entry.kind === 'user' ? 'Operator message · open original' : preview(entry.text, 240), zoom: `zoom(${entry.i}, 1)` }));
  const nextOffset = offset + items.length < rows.length ? offset + items.length : null;
  return { span, total: rows.length, offset, returned: items.length, nextOffset, items };
}

/** Strip terminal controls and flatten previews. Originals remain available, unchanged, through zoom. */
export const preview = (text: string, max = 180) => {
  const safe = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
};
const ref = (source: number) => `zoom(${source}, 1)`;

/** A small decision-first summary. Every cut names its extent and exact follow-up. */
export function renderCatchup(report: CatchupReport) {
  const { span, prs, checks, wakes, replies } = report;
  const open = prs.filter(pr => pr.state === 'OPEN'), failed = checks.filter(check => check.status !== 'passed');
  const allEvents = `/catchup range ${span.from} ${span.to} 0`;
  const lines = [
    `Since your last message · ${span.id}`,
    `${span.start} → ${span.end} (UTC) · ${span.provenance === 'interactive' ? 'recorded operator boundary' : 'explicit historical range; human provenance not recorded'}`,
    `${wakes.length} wakes · ${report.tools} tool calls · ${report.results} results · ${report.covered} original messages`, '',
    'Your attention — observations, not permission',
    ...open.slice(0, 12).map(pr => `- Review: ${pr.url} · checks ${pr.checks} · ${ref(pr.source)}`),
    ...open.length > 12 ? [`${open.length - 12} more open PRs; /catchup json for the complete observation list.`] : [],
    ...failed.slice(0, 12).map(check => `- ${check.root} / ${check.name}: ${check.status} · ${ref(check.source)}`),
    ...failed.length > 12 ? [`${failed.length - 12} more non-passing checks; /catchup json for all observations.`] : [],
    ...!open.length && !failed.length ? ['- No structured pending item found in this interval. This is NOT proof that nothing needs approval.'] : [],
    'PR/check states are last observed in this interval, not live remote verification. No action is authorized by this report.', '',
    'Work reported by the assistant — not independently verified',
    ...replies.slice(-24).map(reply => `- ${preview(reply.text, 240)} · ${ref(reply.source)}`),
    ...replies.length > 24 ? [`${replies.length - 24} older reports not shown; ${allEvents} for every source.`] : [],
    ...!replies.length ? ['- No completed text report recorded.'] : [], '',
    'Wake timeline — every recorded wake in this interval',
    ...wakes.slice(0, 24).map(wake => `- ${wake.at} · ${ref(wake.source)} · ${wake.reply === undefined ? 'no reply recorded' : `report ${ref(wake.reply)}`}`),
    ...wakes.length > 24 ? [`${wakes.length - 24} more wakes; ${allEvents} for all events.`] : [],
    ...!report.covered ? ['No activity recorded in this interval.'] : [],
    '', 'Scope: this OptChat profile only. Nested Code Mode calls are not individually counted. Unstructured/unfinished/background work may have no extracted outcome.',
    `All events: ${allEvents} · Older intervals: /catchup history · Current work: /catchup live`,
  ];
  return lines.join('\n');
}
