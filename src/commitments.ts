import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { brasiliaTime } from './heartbeat.ts';
import { atomicWrite } from './store.ts';
import { stringEnum } from './string-enum.ts';
import { result } from './tools.ts';
import { clean } from './work-tracker.ts';

/**
 * What OptChat promised and what waits on the operator, with age, deadline and next step, so nothing rots silently.
 * Stored per profile in commitments.json. Open items reach every turn (and so every wake) as a short block, the 07:00
 * summary lists the ones waiting on the operator or stuck, and a running turn is nudged when it goes 10 min without
 * telling the operator anything or 30 min without recorded progress.
 */
export const COMMITMENTS_FILE = 'commitments.json';
export const STATUSES = ['open', 'waiting_operator', 'blocked', 'done', 'dropped'] as const;
export type CommitmentStatus = typeof STATUSES[number];
export type CommitmentOwner = 'optchat' | 'operator';
export interface Commitment {
  id: string;
  text: string;
  owner: CommitmentOwner;
  /** Memory message id the commitment came from. */
  source: string;
  createdAt: string;
  updatedAt: string;
  /** Last recorded progress (creation counts). */
  progressAt: string;
  status: CommitmentStatus;
  due?: string;
  next?: string;
  evidence?: string;
  supersedes?: string;
  notes: { at: string; text: string }[];
}
interface Document { version: 1; items: Commitment[] }

const MAX_ITEMS = 200;
const MAX_NOTES = 5;
const MAX_TEXT = 400;
const CLOSED_KEEP_MS = 14 * 86_400_000;
export const STALE_MS = 24 * 3_600_000;
const CONTEXT_MAX = 2_000;
export const closed = (s: CommitmentStatus) => s === 'done' || s === 'dropped';
const clip = (s: string, max = MAX_TEXT) => clean(s, max);

export function readCommitments(dir: string): Commitment[] {
  const file = join(dir, COMMITMENTS_FILE);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Document;
  if (parsed?.version !== 1 || !Array.isArray(parsed.items)) throw new Error(`Unreadable commitments file ${file}`);
  return parsed.items;
}

function write(dir: string, items: Commitment[], now: number) {
  const kept = items.filter(c => !closed(c.status) || now - Date.parse(c.updatedAt) < CLOSED_KEEP_MS);
  if (kept.filter(c => !closed(c.status)).length > MAX_ITEMS) throw new Error(`More than ${MAX_ITEMS} open commitments: close some first.`);
  atomicWrite(join(dir, COMMITMENTS_FILE), `${JSON.stringify({ version: 1, items: kept.slice(-MAX_ITEMS * 2) } satisfies Document, null, 1)}\n`);
}

const iso = (at: number) => new Date(at).toISOString();
function dueAt(input: { due?: string; dueInMinutes?: number }, now: number): string | undefined {
  if (input.dueInMinutes !== undefined) {
    if (!(input.dueInMinutes > 0)) throw new Error('dueInMinutes must be positive');
    return iso(now + input.dueInMinutes * 60_000);
  }
  if (input.due === undefined) return undefined;
  const at = Date.parse(input.due);
  if (!Number.isFinite(at)) throw new Error('due must be an ISO timestamp (e.g. 2026-10-30T22:00:00-03:00)');
  return iso(at);
}

export type AddInput = { text: string; source: string; owner?: CommitmentOwner; next?: string; due?: string; dueInMinutes?: number; supersedes?: string };
export function addCommitment(dir: string, input: AddInput, now = Date.now()): Commitment {
  const items = readCommitments(dir);
  const at = iso(now);
  if (input.supersedes) {
    const old = items.find(c => c.id === input.supersedes);
    if (!old) throw new Error(`No commitment ${input.supersedes} to supersede`);
    if (closed(old.status)) throw new Error(`${old.id} is already ${old.status}`);
  }
  const item: Commitment = {
    id: `c_${randomBytes(3).toString('hex')}`, text: clip(input.text), owner: input.owner ?? 'optchat', source: input.source,
    createdAt: at, updatedAt: at, progressAt: at, status: input.owner === 'operator' ? 'waiting_operator' : 'open', notes: [],
    ...(input.next ? { next: clip(input.next) } : {}),
    ...(dueAt(input, now) ? { due: dueAt(input, now) } : {}),
    ...(input.supersedes ? { supersedes: input.supersedes } : {}),
  };
  const next = items.map(c => c.id === input.supersedes
    ? { ...c, status: 'dropped' as const, updatedAt: at, notes: [...c.notes, { at, text: `superseded by ${item.id}` }].slice(-MAX_NOTES) } : c);
  write(dir, [...next, item], now);
  return item;
}

export type UpdateInput = { id: string; status?: CommitmentStatus; next?: string; progress?: string; evidence?: string; due?: string; dueInMinutes?: number };
export function updateCommitment(dir: string, input: UpdateInput, now = Date.now()): Commitment {
  const items = readCommitments(dir);
  const old = items.find(c => c.id === input.id);
  if (!old) throw new Error(`No commitment ${input.id}`);
  if (input.status === 'done' && !input.evidence && !old.evidence) throw new Error('Closing as done needs evidence: what was observed that proves it.');
  const at = iso(now), due = dueAt(input, now);
  const updated: Commitment = {
    ...old, updatedAt: at,
    ...(input.status ? { status: input.status } : {}),
    ...(input.next ? { next: clip(input.next) } : {}),
    ...(input.evidence ? { evidence: clip(input.evidence) } : {}),
    ...(due ? { due } : {}),
    ...(input.progress || input.evidence || (input.status && input.status !== old.status) ? { progressAt: at } : {}),
    notes: input.progress ? [...old.notes, { at, text: clip(input.progress, 240) }].slice(-MAX_NOTES) : old.notes,
  };
  write(dir, items.map(c => c.id === old.id ? updated : c), now);
  return updated;
}

const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${m % 60 ? `${m % 60}m` : ''}` : `${Math.floor(h / 24)}d`;
};

/** What makes an open item need attention now: past its deadline, or a day old with no next step or no progress. */
export function attention(c: Commitment, now: number): string | undefined {
  if (closed(c.status)) return undefined;
  if (c.due && Date.parse(c.due) <= now) return `OVERDUE ${span(now - Date.parse(c.due))}`;
  if (now - Date.parse(c.createdAt) >= STALE_MS && !c.next) return 'no next step for 24h+';
  if (now - Date.parse(c.progressAt) >= STALE_MS) return `no progress for ${span(now - Date.parse(c.progressAt))}`;
  return undefined;
}

export function describe(c: Commitment, now: number): string {
  const flag = attention(c, now);
  const due = c.due ? `, due ${brasiliaTime(Date.parse(c.due))}${Date.parse(c.due) > now ? ` (in ${span(Date.parse(c.due) - now)})` : ''}` : '';
  return `${flag ? `⚠ ${flag} · ` : ''}${c.id} [${c.owner} · ${c.status} · ${span(now - Date.parse(c.createdAt))} old${due}] ${c.text}${c.next ? ` — next: ${c.next}` : ''}`;
}

/** Open items, the ones needing attention first, then by deadline, then oldest. */
export function openCommitments(items: readonly Commitment[], now: number) {
  const rank = (c: Commitment) => { const flag = attention(c, now); return flag?.startsWith('OVERDUE') ? 0 : flag ? 1 : c.due ? 2 : 3; };
  return items.filter(c => !closed(c.status))
    .sort((a, b) => rank(a) - rank(b) || (a.due && b.due ? a.due.localeCompare(b.due) : 0) || a.createdAt.localeCompare(b.createdAt));
}

/** The block every turn reads; empty when nothing is open. Times in Brasília (UTC-3). */
export function commitmentsContext(items: readonly Commitment[], now = Date.now()): string {
  const open = openCommitments(items, now);
  if (!open.length) return '';
  const lines = [`Open commitments (${open.length}; ages now, times UTC-3; keep them current with the commitments tool: progress, next step, close with evidence):`];
  for (const [index, c] of open.entries()) {
    const line = `- ${describe(c, now)}`;
    if ([...lines, line].join('\n').length > CONTEXT_MAX) { lines.push(`- … ${open.length - index} more: commitments {action:"list"}`); break; }
    lines.push(line);
  }
  return lines.join('\n');
}

/** For the 07:00 summary: what waits on the operator, and what is overdue or stuck. */
export function summaryLines(items: readonly Commitment[], now: number) {
  const open = openCommitments(items, now);
  return {
    waiting: open.filter(c => c.owner === 'operator' || c.status === 'waiting_operator').map(c => `${c.text}${c.next ? ` (próximo: ${c.next})` : ''}`),
    attention: open.filter(c => c.owner === 'optchat' && c.status !== 'waiting_operator' && attention(c, now))
      .map(c => `${c.text} — ${attention(c, now)!.replace(/^OVERDUE/, 'atrasado').replace('no next step for 24h+', 'sem próximo passo há 24h+').replace(/^no progress for/, 'sem progresso há')}`),
  };
}

// ---- Presence: a long turn tells the operator where it is, and a stuck one changes course. ----
export const PRESENCE_REPORT_MS = 10 * 60_000;
export const PRESENCE_STALL_MS = 30 * 60_000;
export class Presence {
  private reportedAt = 0;
  private provenAt = 0;
  private nudged = { report: false, stall: false };
  start(now: number) { this.reportedAt = this.provenAt = now; this.nudged = { report: false, stall: false }; }
  /** The operator was told something (slack_send). */
  reported(now: number) { this.reportedAt = now; this.nudged.report = false; }
  /** Progress was recorded on a commitment. */
  progressed(now: number) { this.provenAt = now; this.nudged.stall = false; }
  /** The notice to append to this tool result, at most once per threshold until the clock resets. */
  check(now: number): string | undefined {
    if (!this.reportedAt) return undefined;
    if (!this.nudged.stall && now - this.provenAt >= PRESENCE_STALL_MS) {
      this.nudged.stall = true;
      return `[OptChat presence] ${span(now - this.provenAt)} without recorded progress in this turn. Stop and change course: summarize what you know, record it on the commitment (commitments update with progress/next), tell the operator in one line with slack_send, then take a different route or close it as blocked.`;
    }
    if (!this.nudged.report && now - this.reportedAt >= PRESENCE_REPORT_MS) {
      this.nudged.report = true;
      return `[OptChat presence] This turn has gone ${span(now - this.reportedAt)} without a word to the operator. Send one short progress line now with slack_send (with a topic, in Portuguese): what is done, what is running, when you expect to finish.`;
    }
    return undefined;
  }
}

// ---- The tool and the hooks. ----
const params = Type.Object({
  action: stringEnum(['list', 'add', 'update']),
  id: Type.Optional(Type.String({ description: 'update: the commitment id (c_xxxxxx)' })),
  text: Type.Optional(Type.String({ maxLength: 2000, description: 'add: what is promised or awaited, one line' })),
  source: Type.Optional(Type.String({ description: 'add: the memory message id it came from (the operator\'s request)' })),
  owner: Type.Optional(stringEnum(['optchat', 'operator'])),
  status: Type.Optional(stringEnum(STATUSES)),
  next: Type.Optional(Type.String({ maxLength: 1000, description: 'the next concrete step' })),
  progress: Type.Optional(Type.String({ maxLength: 1000, description: 'update: what moved, observed (resets the 30-min stall clock)' })),
  evidence: Type.Optional(Type.String({ maxLength: 1000, description: 'what was observed; required to close as done' })),
  due: Type.Optional(Type.String({ description: 'ISO deadline' })),
  dueInMinutes: Type.Optional(Type.Number({ description: 'deadline as minutes from now' })),
  supersedes: Type.Optional(Type.String({ description: 'add: id of an older commitment this replaces (it is dropped)' })),
  all: Type.Optional(Type.Boolean({ description: 'list: include closed ones (last 14 days)' })),
}, { additionalProperties: false });
type Params = { action: 'list' | 'add' | 'update'; id?: string; text?: string; source?: string; owner?: CommitmentOwner; status?: CommitmentStatus;
  next?: string; progress?: string; evidence?: string; due?: string; dueInMinutes?: number; supersedes?: string; all?: boolean };

function listText(dir: string, all: boolean, now: number) {
  const items = readCommitments(dir), shown = all ? items : openCommitments(items, now);
  if (!shown.length) return 'No open commitments.';
  return shown.map(c => {
    const last = c.notes.at(-1);
    return `${describe(c, now)}${c.evidence ? ` · evidence: ${c.evidence}` : ''}${last ? ` · last: ${brasiliaTime(Date.parse(last.at))} ${last.text}` : ''}`;
  }).join('\n');
}

export function commitmentsTool(owner: () => { dir: string; sourceExists(id: string): boolean }, onProgress: () => void = () => {}) {
  return {
    name: 'commitments', label: 'Commitments',
    description: 'Track what you promised the operator and what waits on him, so nothing rots: add (text, source message id, owner, next step, deadline), update (progress, next, status open/waiting_operator/blocked/done/dropped; done needs evidence), list. Open ones appear in every turn with age and deadline; a new operator decision supersedes the old item.',
    parameters: params,
    async execute(_id: string, args: Params) {
      const { dir, sourceExists } = owner(), now = Date.now();
      if (args.action === 'list') return result(listText(dir, args.all === true, now));
      if (args.action === 'add') {
        if (!args.text?.trim()) throw new Error('add needs text');
        if (!args.source || !sourceExists(args.source)) throw new Error('add needs source: the exact memory message id the commitment comes from');
        const item = addCommitment(dir, { ...args, text: args.text, source: args.source }, now);
        onProgress();
        return result(`Added ${describe(item, now)}`);
      }
      if (!args.id) throw new Error('update needs id');
      const item = updateCommitment(dir, { ...args, id: args.id }, now);
      if (args.progress || args.evidence || args.status) onProgress();
      return result(`Updated ${describe(item, now)}`);
    },
  };
}

/** Registers the tool and the presence nudges of a running turn. */
export function registerCommitments(pi: ExtensionAPI, owner: () => { dir: string; sourceExists(id: string): boolean } | undefined, now: () => number = Date.now) {
  const presence = new Presence();
  const required = () => {
    const o = owner();
    if (!o) throw new Error('Open an OptChat profile first.');
    return o;
  };
  pi.registerTool(commitmentsTool(required, () => presence.progressed(now())));
  pi.on('agent_start', () => presence.start(now()));
  pi.on('tool_call', event => { if (event.toolName === 'slack_send') presence.reported(now()); });
  pi.on('tool_result', event => {
    if (!owner()) return;
    const notice = presence.check(now());
    if (!notice) return;
    return { content: [...event.content, { type: 'text' as const, text: `\n${notice}` }] };
  });
  return {
    context(dir: string) {
      try { return commitmentsContext(readCommitments(dir), now()); }
      catch (error) { return `Commitments unreadable: ${error instanceof Error ? error.message : String(error)}`; }
    },
  };
}
