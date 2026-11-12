import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ESCALATION_RULE, overdueDay } from './commitment-due.ts';
import { brasiliaTime } from './heartbeat.ts';
import { ghIssueState, IssueStateCache } from './commitment-issues.ts';
import { logBackgroundFailure } from './exec-log.ts';
import { SLUG } from './slug.ts';
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
  /** The crew project (a specialist slug) whose owner keeps this item: the heartbeat hands its signals to that specialist. Absent: the manager's. */
  project?: string;
  /** While it waits on the operator: the answers he can tap on the App Home (each becomes his DM reply). */
  choices?: string[];
  /** Events the extension records on it by itself (see `LinkEvent`). */
  links?: Links;
  notes: { at: string; text: string }[];
}
/** `prs` are `owner/repo#N`, `runs` worker run ids; `reload` waits for one reload resume; `next` becomes the next step when a linked PR ends or a linked run or the reload arrives. `seen` holds the events already recorded. */
export interface Links { prs?: string[]; runs?: string[]; reload?: boolean; next?: string; seen?: string[] }
export type LinksInput = Omit<Links, 'seen'>;
interface Document { version: 1; items: Commitment[] }

const MAX_ITEMS = 200;
const MAX_NOTES = 5;
const MAX_TEXT = 400;
const CLOSED_KEEP_MS = 14 * 86_400_000;
export const STALE_MS = 24 * 3_600_000;
const CONTEXT_MAX = 2_000;
export const MAX_CHOICES = 4;
export const CHOICE_MAX = 40;
const MAX_LINKED = 5;
const MAX_SEEN = 20;
const PR_REF = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/;
export const closed = (s: CommitmentStatus) => s === 'done' || s === 'dropped';
const clip = (s: string, max = MAX_TEXT) => clean(s, max);

const isText = (value: unknown): value is string => typeof value === 'string';
const isTime = (value: unknown): value is string => isText(value) && Number.isFinite(Date.parse(value));
const isTexts = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);
function isLinks(value: unknown): value is Links {
  if (typeof value !== 'object' || value === null) return false;
  const l = value as Record<string, unknown>;
  return (l.prs === undefined || isTexts(l.prs)) && (l.runs === undefined || isTexts(l.runs)) && (l.seen === undefined || isTexts(l.seen))
    && (l.reload === undefined || typeof l.reload === 'boolean') && (l.next === undefined || isText(l.next));
}
/** A stored item whose status is not one of STATUSES would read as open forever (`closed` is false for anything else), and one without notes or times breaks every list. */
function isCommitment(value: unknown): value is Commitment {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return isText(c.id) && isText(c.text) && isText(c.source) && (c.owner === 'optchat' || c.owner === 'operator')
    && STATUSES.some(status => status === c.status) && isTime(c.createdAt) && isTime(c.updatedAt) && isTime(c.progressAt)
    && (c.due === undefined || isTime(c.due)) && (c.next === undefined || isText(c.next)) && (c.evidence === undefined || isText(c.evidence)) && (c.supersedes === undefined || isText(c.supersedes)) && (c.project === undefined || isText(c.project) && SLUG.test(c.project))
    && (c.choices === undefined || (Array.isArray(c.choices) && c.choices.every(isText))) && (c.links === undefined || isLinks(c.links))
    && Array.isArray(c.notes) && c.notes.every(note => typeof note === 'object' && note !== null && isTime((note as { at?: unknown }).at) && isText((note as { text?: unknown }).text));
}

export function readCommitments(dir: string): Commitment[] {
  const file = join(dir, COMMITMENTS_FILE);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Document;
  if (parsed?.version !== 1 || !Array.isArray(parsed.items) || !parsed.items.every(isCommitment)) throw new Error(`Unreadable commitments file ${file}`);
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

/** A project is a crew slug (a known specialist or a new one); '' clears it on update. */
function projectOf(project: string | undefined): string | undefined {
  if (project === undefined || project === '') return undefined;
  if (!SLUG.test(project)) throw new Error(`"${project}" is not a valid project: use a crew slug (lowercase letters, digits and hyphens, at most 41 characters), e.g. dentai.`);
  return project;
}

/** Short distinct answers, at most MAX_CHOICES; an empty list clears them. */
function choicesOf(choices: readonly string[] | undefined): string[] | undefined {
  if (choices === undefined) return undefined;
  const kept = [...new Set(choices.map(c => clean(c, CHOICE_MAX)).filter(Boolean))];
  if (kept.length > MAX_CHOICES) throw new Error(`At most ${MAX_CHOICES} choices.`);
  return kept;
}

/** The links after `given` is applied over `old`: a list replaces its list, `reload: false` or an empty list clears it; nothing left means no links. Rejects what no event can match. */
function linksOf(given: LinksInput | undefined, old?: Links): Links | undefined {
  if (given === undefined) return old;
  const merged: Links = { ...old, ...given.prs !== undefined ? { prs: given.prs } : {}, ...given.runs !== undefined ? { runs: given.runs } : {} };
  const prs = [...new Set((merged.prs ?? []).map(p => p.trim()))], runs = [...new Set((merged.runs ?? []).map(r => r.trim()))];
  for (const pr of prs) if (!PR_REF.test(pr)) throw new Error(`links.prs wants owner/repo#N, got "${pr}"`);
  if (runs.some(r => !r || r.length > 40)) throw new Error('links.runs wants worker run ids');
  if (prs.length > MAX_LINKED || runs.length > MAX_LINKED) throw new Error(`At most ${MAX_LINKED} linked PRs and ${MAX_LINKED} runs.`);
  const reload = given.reload ?? merged.reload, next = given.next === undefined ? merged.next : given.next ? clip(given.next) : undefined;
  if (!prs.length && !runs.length && !reload) return undefined;
  return { ...prs.length ? { prs } : {}, ...runs.length ? { runs } : {}, ...reload ? { reload } : {}, ...next ? { next } : {}, ...merged.seen?.length ? { seen: merged.seen } : {} };
}

export type AddInput = { text: string; source: string; owner?: CommitmentOwner; next?: string; due?: string; dueInMinutes?: number; supersedes?: string; project?: string; choices?: string[]; links?: LinksInput };
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
    ...(projectOf(input.project) ? { project: projectOf(input.project) } : {}),
    ...(choicesOf(input.choices)?.length ? { choices: choicesOf(input.choices) } : {}),
    ...(linksOf(input.links) ? { links: linksOf(input.links) } : {}),
  };
  const next = items.map(c => c.id === input.supersedes
    ? { ...c, status: 'dropped' as const, updatedAt: at, notes: [...c.notes, { at, text: `superseded by ${item.id}` }].slice(-MAX_NOTES) } : c);
  write(dir, [...next, item], now);
  return item;
}

/** Why an update of an item overdue for a day is refused, or undefined when it is one of the three ways out: close it (done or dropped), change its status, set a future due, or set choices. */
export function overdueRefusal(old: Commitment, input: UpdateInput, now: number): string | undefined {
  if (!overdueDay(old, now)) return undefined;
  if (input.status !== undefined && input.status !== old.status) return undefined;
  if (choicesOf(input.choices)?.length) return undefined;
  const due = dueAt(input, now);
  if (due !== undefined && Date.parse(due) > now) return undefined;
  return `${old.id} is overdue ${span(now - Date.parse(old.due!))}: a note or a next step is not enough; to update it, ${ESCALATION_RULE}.`;
}

export type UpdateInput = { id: string; status?: CommitmentStatus; next?: string; progress?: string; evidence?: string; due?: string; dueInMinutes?: number; project?: string; choices?: string[]; links?: LinksInput };
export function updateCommitment(dir: string, input: UpdateInput, now = Date.now()): Commitment {
  const items = readCommitments(dir);
  const old = items.find(c => c.id === input.id);
  if (!old) throw new Error(`No commitment ${input.id}`);
  if (input.status === 'done' && !input.evidence && !old.evidence) throw new Error('Closing as done needs evidence: what was observed that proves it.');
  const at = iso(now), due = dueAt(input, now), choices = choicesOf(input.choices), links = linksOf(input.links, old.links);
  const project = projectOf(input.project), { choices: oldChoices, links: _links, project: oldProject, ...rest } = old;
  const updated: Commitment = {
    ...rest, ...(input.project === undefined && oldProject ? { project: oldProject } : {}), ...(project ? { project } : {}),
    ...(choices === undefined && oldChoices ? { choices: oldChoices } : {}), updatedAt: at,
    ...(choices?.length ? { choices } : {}),
    ...(links ? { links } : {}),
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

/** What the extension sees that a commitment may be linked to: a gitwatch event of a PR, the end of a worker run, the reload resume. */
export type LinkEvent =
  | { type: 'pr'; repo: string; pr: number; kind: string; text: string }
  | { type: 'run'; id: string; state: string }
  | { type: 'reload'; id: string };
/** Gitwatch kinds worth a progress line (a pending-checks update is not); `merged` and `closed` end the PR. */
const PR_KINDS = new Set(['merged', 'closed', 'reopened', 'checks', 'mergeState', 'review', 'stall']);
const PR_ENDS = new Set(['merged', 'closed']);

/** The note an event writes, the key that makes a repeat of it a no-op, whether the commitment's `next` applies, and whether the item is linked to it. */
function linkNote(event: LinkEvent): { key: string; text: string; ends: boolean; linked: (l: Links) => boolean } | undefined {
  if (event.type === 'pr') {
    if (event.pr <= 0 || !PR_KINDS.has(event.kind) || /^checks running/.test(event.text)) return undefined;
    const ref = `${event.repo}#${event.pr}`.toLowerCase();
    return { key: `pr:${ref}:${event.kind}:${event.text}`, text: `gitwatch ${event.repo}#${event.pr}: ${event.text}`, ends: PR_ENDS.has(event.kind),
      linked: l => l.prs?.some(p => p.toLowerCase() === ref) === true };
  }
  if (event.type === 'run') return { key: `run:${event.id}:${event.state}`, text: `worker run ${event.id} ${event.state}`, ends: true, linked: l => l.runs?.includes(event.id) === true };
  return { key: `reload:${event.id}`, text: 'reload done; continuation started', ends: true, linked: l => l.reload === true };
}

/**
 * Appends one progress line to every open commitment linked to `event` and resets its stall clock: no model call. A
 * repeat of an event it already recorded adds nothing. It never changes the status (done needs evidence); `next` is
 * set only from the link's own `next`, when the PR ends or the run or reload arrives. A reload link is used up by its resume.
 * Returns the commitments it changed.
 */
export function recordLinkEvent(dir: string, event: LinkEvent, now = Date.now()): Commitment[] {
  const note = linkNote(event);
  if (!note || !existsSync(join(dir, COMMITMENTS_FILE))) return [];
  const items = readCommitments(dir), at = iso(now), changed: Commitment[] = [];
  const next = items.map(c => {
    const links = c.links;
    if (closed(c.status) || !links || !note.linked(links) || links.seen?.includes(note.key)) return c;
    const { reload: _used, ...kept } = links;
    const left: Links = event.type === 'reload' ? kept : { ...links, seen: [...(links.seen ?? []), note.key].slice(-MAX_SEEN) };
    const { links: _old, ...rest } = c;
    const updated: Commitment = { ...rest, updatedAt: at, progressAt: at, notes: [...c.notes, { at, text: clip(note.text, 240) }].slice(-MAX_NOTES),
      ...(note.ends && links.next ? { next: links.next } : {}),
      ...(left.prs?.length || left.runs?.length || left.reload ? { links: left } : {}) };
    changed.push(updated);
    return updated;
  });
  if (changed.length) write(dir, next, now);
  return changed;
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
  return `${flag ? `⚠ ${flag} · ` : ''}${c.id} [${c.owner} · ${c.status}${c.project ? ` · project ${c.project}` : ''} · ${span(now - Date.parse(c.createdAt))} old${due}] ${c.text}${c.next ? ` — next: ${c.next}` : ''}`;
}

/** Open items, the ones needing attention first, then by deadline, then oldest. */
export function openCommitments(items: readonly Commitment[], now: number) {
  const rank = (c: Commitment) => { const flag = attention(c, now); return flag?.startsWith('OVERDUE') ? 0 : flag ? 1 : c.due ? 2 : 3; };
  return items.filter(c => !closed(c.status))
    .sort((a, b) => rank(a) - rank(b) || (a.due && b.due ? a.due.localeCompare(b.due) : 0) || a.createdAt.localeCompare(b.createdAt));
}

/** The block every turn reads; empty when nothing is open. Times in Brasília (UTC-3). */
export function commitmentsContext(items: readonly Commitment[], now = Date.now(), issueHint: (c: Commitment) => string | undefined = () => undefined): string {
  const open = openCommitments(items, now);
  if (!open.length) return '';
  const lines = [`Open commitments (${open.length}; ages now, times UTC-3; keep them current with the commitments tool: progress, next step, close with evidence):`];
  for (const [index, c] of open.entries()) {
    const hint = issueHint(c);
    const line = `- ${describe(c, now)}${hint ? ` · ${hint}` : ''}${overdueDay(c, now) ? ` · overdue 24h+: ${ESCALATION_RULE}` : ''}`;
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
    attention: open.filter(c => c.owner === 'optchat' && (c.status !== 'waiting_operator' || overdueDay(c, now)) && attention(c, now))
      .map(c => `${c.text} — ${attention(c, now)!.replace(/^OVERDUE/, 'atrasado').replace('no next step for 24h+', 'sem próximo passo há 24h+').replace(/^no progress for/, 'sem progresso há')}${c.status === 'waiting_operator' ? ' · revisar espera' : ''}${c.next ? ` (próximo: ${c.next})` : ''}`),
  };
}

/** What waits on the operator, as the App Home lists it: the item, what is asked of him and the answers he can tap. */
export type WaitingItem = { text: string; ask?: string; choices?: string[] };
export function waitingItems(items: readonly Commitment[], now: number): WaitingItem[] {
  return openCommitments(items, now).filter(c => c.owner === 'operator' || c.status === 'waiting_operator')
    .map(c => ({ text: c.text, ...(c.next ? { ask: c.next } : {}), ...(c.choices?.length ? { choices: c.choices } : {}) }));
}

/**
 * What the waiting board puts under "Esperando você": the operator's items and the questions waiting on him, with their id and since when they wait
 * (the last update: no field records the moment it started waiting). Missing choices alone cannot tell whether a real question is waiting.
 */
export type BoardWaitItem = WaitingItem & { id: string; since: number };
export function boardWaiting(items: readonly Commitment[], now: number): BoardWaitItem[] {
  return openCommitments(items, now).filter(c => c.owner === 'operator' || c.status === 'waiting_operator')
    .map(c => ({ id: c.id, text: c.text, since: Date.parse(c.updatedAt) || now, ...(c.next ? { ask: c.next } : {}), ...(c.choices?.length ? { choices: c.choices } : {}) }));
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
  id: Type.Optional(Type.String()),
  text: Type.Optional(Type.String({ maxLength: 2000 })),
  source: Type.Optional(Type.String({ description: 'his message id, or "latest"' })),
  owner: Type.Optional(stringEnum(['optchat', 'operator'])),
  status: Type.Optional(stringEnum(STATUSES)),
  next: Type.Optional(Type.String()),
  progress: Type.Optional(Type.String({ description: 'what moved; resets stall clock' })),
  evidence: Type.Optional(Type.String()),
  due: Type.Optional(Type.String()),
  dueInMinutes: Type.Optional(Type.Number()),
  supersedes: Type.Optional(Type.String({ description: 'id it replaces' })),
  project: Type.Optional(Type.String({ description: 'slug; "" clears' })),
  choices: Type.Optional(Type.Array(Type.String({ maxLength: CHOICE_MAX }), { maxItems: MAX_CHOICES, description: 'his Slack Home taps; [] clears' })),
  links: Type.Optional(Type.Object({
    prs: Type.Optional(Type.Array(Type.String())), runs: Type.Optional(Type.Array(Type.String())), reload: Type.Optional(Type.Boolean()), next: Type.Optional(Type.String()),
  }, { additionalProperties: false, description: 'auto progress, never done: prs owner/repo#N, run ids, reload; next: step once it ends' })),
  all: Type.Optional(Type.Boolean({ description: 'include closed' })),
}, { additionalProperties: false });
type Params = { action: 'list' | 'add' | 'update'; id?: string; text?: string; source?: string; owner?: CommitmentOwner; status?: CommitmentStatus;
  next?: string; progress?: string; evidence?: string; due?: string; dueInMinutes?: number; supersedes?: string; project?: string; choices?: string[]; links?: LinksInput; all?: boolean };

function listText(dir: string, all: boolean, now: number) {
  const items = readCommitments(dir), shown = all ? items : openCommitments(items, now);
  if (!shown.length) return 'No open commitments.';
  return shown.map(c => {
    const last = c.notes.at(-1);
    const l = c.links, linked = l ? [...l.prs ?? [], ...(l.runs ?? []).map(r => `run ${r}`), ...l.reload ? ['reload'] : []] : [];
    return `${describe(c, now)}${c.evidence ? ` · evidence: ${c.evidence}` : ''}${linked.length ? ` · linked: ${linked.join(', ')}` : ''}${last ? ` · last: ${brasiliaTime(Date.parse(last.at))} ${last.text}` : ''}`;
  }).join('\n');
}

type Owner = { dir: string; sourceExists(id: string): boolean; latestSource?(): string | undefined };

export function commitmentsTool(owner: () => Owner, onProgress: () => void = () => {}) {
  return {
    name: 'commitments', label: 'Commitments',
    description: 'Promises to the operator and what waits on him. Open items show every turn; done needs evidence.',
    parameters: params,
    async execute(_id: string, args: Params) {
      const { dir, sourceExists, latestSource } = owner(), now = Date.now();
      if (args.action === 'list') return result(listText(dir, args.all === true, now));
      if (args.action === 'add') {
        if (!args.text?.trim()) throw new Error('add needs text');
        // The request that started this turn is not in the view yet, so "latest" stands for it.
        const latest = latestSource?.();
        if (args.source === 'latest' && !latest) throw new Error('add source "latest": no operator message yet in this profile');
        const source = args.source === 'latest' ? latest! : args.source;
        if (!source || !sourceExists(source)) throw new Error(`add needs source: the exact memory message id the commitment comes from, or "latest"${latest ? ` (now ${latest})` : ''}`);
        const item = addCommitment(dir, { ...args, text: args.text, source }, now);
        onProgress();
        return result(`Added ${describe(item, now)}`);
      }
      if (!args.id) throw new Error('update needs id');
      const old = readCommitments(dir).find(c => c.id === args.id);
      const refusal = old && overdueRefusal(old, { ...args, id: args.id }, now);
      if (refusal) throw new Error(refusal);
      const item = updateCommitment(dir, { ...args, id: args.id }, now);
      if (args.progress || args.evidence || args.status) onProgress();
      return result(`Updated ${describe(item, now)}`);
    },
  };
}

/** Registers the tool and the presence nudges of a running turn. */
export function registerCommitments(pi: ExtensionAPI, owner: () => Owner | undefined, now: () => number = Date.now) {
  const presence = new Presence();
  const issues = new IssueStateCache(ghIssueState, Date.now, (key, error) => logBackgroundFailure(owner()?.dir, `commitment issues ${key}`, error));
  const issueText = (c: Commitment) => `${c.text} ${c.next ?? ''}`;
  const required = () => {
    const o = owner();
    if (!o) throw new Error('Open an OptChat profile first.');
    return o;
  };
  pi.registerTool(commitmentsTool(required, () => presence.progressed(now())));
  /** An event the extension saw: linked commitments get their progress line (no model call), and the running turn counts it as progress. */
  const linked = (event: LinkEvent) => {
    const dir = owner()?.dir;
    if (!dir) return;
    try { if (recordLinkEvent(dir, event, now()).length) presence.progressed(now()); }
    catch (error) { logBackgroundFailure(dir, `commitment link ${event.type}`, error); }
  };
  pi.on('message_end', ({ message }) => {
    if (message.role !== 'custom' || message.customType !== 'gitwatch') return;
    const { repo, events } = (message.details ?? {}) as { repo?: unknown; events?: unknown };
    if (typeof repo !== 'string' || !Array.isArray(events)) return;
    for (const e of events as { pr?: unknown; kind?: unknown; text?: unknown }[])
      if (typeof e?.pr === 'number' && typeof e.kind === 'string' && typeof e.text === 'string') linked({ type: 'pr', repo, pr: e.pr, kind: e.kind, text: e.text });
  });
  pi.on('agent_start', () => presence.start(now()));
  pi.on('tool_result', event => {
    if (!owner()) return;
    // Only a delivered post told the operator anything; a refused or failed send keeps the reminder due.
    if (event.toolName === 'slack_send' && !event.isError) presence.reported(now());
    const notice = presence.check(now());
    if (!notice) return;
    return { content: [...event.content, { type: 'text' as const, text: `\n${notice}` }] };
  });
  return {
    /** A worker run reached an end state. */
    runEnded: (run: { id: string; state: string }) => linked({ type: 'run', id: run.id, state: run.state }),
    /** The continuation of reload ticket `id` started. */
    reloadResumed: (id: string) => linked({ type: 'reload', id }),
    context(dir: string) {
      try {
        const items = readCommitments(dir);
        const texts = openCommitments(items, now()).map(issueText);
        setImmediate(() => { for (const text of texts) void issues.refresh(text); });
        return commitmentsContext(items, now(), c => issues.hint(issueText(c)));
      } catch (error) { return `Commitments unreadable: ${error instanceof Error ? error.message : String(error)}`; }
    },
  };
}
