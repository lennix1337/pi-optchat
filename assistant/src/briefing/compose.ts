import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Event, SourceKind } from '../contracts/events.ts';
import type { Task } from '../contracts/tasks.ts';
import type { CalendarEvent, DraftPreview, GoogleConnections, MailMessage } from '../connectors/google.ts';
import { isTimeZone, localDateTime } from '../connectors/google.ts';
import { boundedInteger, boundedText } from '../limits.ts';
import { sha256 } from '../hash.ts';
import { zonedInstant } from '../routines/schedule.ts';
import type { TaskStore } from '../store/db.ts';
import { immediate } from '../store/transaction.ts';
import { agendaInstant, buildMeetingCard, byMeetingStart, meetingId, type MeetingPrepCard } from './meeting-prep.ts';
import { MAX_LEARNED_RULES, parseRule, triage, type LearnedRule, type Triage, type TriageRules, type Uncertainty, type Urgency } from './triage.ts';

/**
 * Daily and on-demand briefings: the task inbox, today's agenda, triaged mail and what changed since the previous
 * briefing, with every source that could not be read listed as such. One daily briefing exists per profile and local
 * date however many clients ask; each on-demand briefing is its own. Message bodies are never stored, private
 * subjects are withheld. Only a new daily briefing can save a receipt-only reply draft; Start and sending are separate actions.
 */
export type BriefingKind = 'daily' | 'on_demand';
export type Section = 'tasks' | 'agenda' | 'messages' | 'changes';
export type BriefingStep = { kind: 'next'; text: string } | { kind: 'reply_draft'; draftId: string; subject: string };
export type BriefingItem = { itemId: string; section: Section; title: string; sourceRef: string; reason: string; urgency: Urgency; uncertainty: Uncertainty; untrusted: boolean; startable: boolean; step?: BriefingStep };
export type RuleEffect = { ruleId: string; reason: string; hidden: number };
export type ReplyDraft = { draftId: string; subject: string; preview: DraftPreview };
const NEXT_STEP: Record<Section, string> = { tasks: 'Open the task to see its current status.', agenda: 'Review the calendar event.', messages: 'Review the original message.', changes: 'Review what changed.' };
export type SourceState = { sourceId: string; state: 'ok' | 'partial' | 'unavailable'; error: string | null };
export type Briefing = {
  version: 1; briefingId: string; profileId: string; kind: BriefingKind; localDate: string; timeZone: string; createdAt: string;
  taskSequence: number; sources: SourceState[]; items: BriefingItem[]; distractions: number; meetingPrep?: MeetingPrepCard[]; ruleEffects?: RuleEffect[];
};
export type StartRequest = { requestId: string; sessionId: string; channelId: string; actorId: string; sourceKind: SourceKind };
export type ComposerOptions = {
  databasePath: string; profileId: string; operatorAuthority: object; timeZone: string; store: TaskStore; google: GoogleConnections;
  /** The connections to read, by name. There is no default: an unnamed account is never read. */
  connections: string[]; rules: TriageRules; retentionDays?: number; now?: () => number; meetingPrep?: boolean;
};

const DAY_MS = 86_400_000;
const PRIVATE_TITLE = '[private content withheld]';
const OPEN_STATUSES = new Set(['suggested', 'queued', 'working', 'needs_input', 'ready_for_review', 'failed']);
const NEEDS_OWNER = new Set(['needs_input', 'ready_for_review', 'failed']);
const URGENCY_ORDER: Record<Urgency, number> = { urgent: 0, normal: 1, low: 2 };
const SECTION_ORDER: Record<Section, number> = { tasks: 0, agenda: 1, messages: 2, changes: 3 };
const MAX_STORE_PAGES = 20;
const fail = (code: string): never => { throw new Error(code); };
const errorCode = (error: unknown) => error instanceof Error && /^[a-z][a-z_]{0,63}$/.test(error.message) ? error.message : 'source_failed';
type Item = Omit<BriefingItem, 'itemId'>;
type AgendaItem = Item & { at: string };

export class BriefingComposer {
  private readonly db: DatabaseSync;
  private readonly options: ComposerOptions;
  private readonly retentionDays: number;
  private readonly now: () => number;

  constructor(options: ComposerOptions) {
    const valid = options?.operatorAuthority && typeof options.operatorAuthority === 'object' && typeof options.profileId === 'string' && options.profileId.length > 0
      && options.store?.matchesProfile(options.profileId) && options.google && Array.isArray(options.connections) && options.connections.length <= 10
      && options.connections.every(c => typeof c === 'string' && c.length > 0) && new Set(options.connections).size === options.connections.length
      && Array.isArray(options.rules?.trustedSenders) && options.rules.trustedSenders.every(s => typeof s === 'string') && isTimeZone(options.timeZone);
    if (!valid) fail('invalid_options');
    this.retentionDays = boundedInteger(options.retentionDays, 14, 1, 90);
    this.options = { ...options, connections: [...options.connections], rules: { trustedSenders: [...options.rules.trustedSenders] } };
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS briefings (profile TEXT NOT NULL, briefing_id TEXT NOT NULL, kind TEXT NOT NULL, local_date TEXT NOT NULL, created INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (profile, briefing_id));
      CREATE UNIQUE INDEX IF NOT EXISTS briefings_daily ON briefings (profile, local_date) WHERE kind = 'daily';
      CREATE TABLE IF NOT EXISTS meeting_prep_announced (profile TEXT NOT NULL, card_id TEXT NOT NULL, start_ms INTEGER NOT NULL, PRIMARY KEY (profile, card_id));
      CREATE TABLE IF NOT EXISTS briefing_reply_drafts (profile TEXT NOT NULL, id TEXT NOT NULL, last_used INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (profile, id));
      CREATE TABLE IF NOT EXISTS briefing_triage_rules (profile TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (profile, id));`);
  }

  /** Today's briefing for this profile; when another client already made it, that one is returned without reading again. */
  async daily(): Promise<Briefing> { return (await this.readDaily(this.now())).briefing; }

  /** Only a briefing composed in this pass is fresh enough to reuse for reminders. */
  async readDaily(now: number): Promise<{ briefing: Briefing; fresh: Briefing | null }> {
    const localDate = localDateTime(now, this.options.timeZone).date;
    const existing = this.dailyFor(localDate);
    if (existing) return { briefing: existing, fresh: null };
    const drafts: ReplyDraft[] = [];
    const fresh = await this.compose('daily', now, localDate, drafts);
    return immediate(this.db, () => {
      const inserted = this.db.prepare('INSERT INTO briefings VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(this.options.profileId, fresh.briefingId, 'daily', localDate, now, JSON.stringify(fresh));
      if (!inserted.changes) return { briefing: this.dailyFor(localDate)!, fresh: null };
      if (drafts.length) this.saveDrafts(drafts, now);
      if (fresh.sources.every(source => source.state !== 'unavailable')) this.pruneExpired(now);
      return { briefing: fresh, fresh };
    });
  }

  async onDemand(): Promise<Briefing> {
    const now = this.now();
    const briefing = await this.compose('on_demand', now, localDateTime(now, this.options.timeZone).date);
    this.db.prepare('INSERT INTO briefings VALUES (?, ?, ?, ?, ?, ?)').run(this.options.profileId, briefing.briefingId, 'on_demand', briefing.localDate, Date.parse(briefing.createdAt), JSON.stringify(briefing));
    return briefing;
  }

  async upcomingMeetingPrep(now: number, leadMs: number, fresh: Briefing | null, canRead: (sourceId: string) => boolean = () => true): Promise<{ cards: MeetingPrepCard[]; sources: SourceState[] }> {
    const { google, timeZone, rules, profileId } = this.options;
    const end = now + leadMs;
    this.db.prepare('DELETE FROM meeting_prep_announced WHERE profile = ? AND start_ms <= ?').run(profileId, now);
    const rows = this.db.prepare('SELECT card_id FROM meeting_prep_announced WHERE profile = ? AND start_ms <= ?').all(profileId, end) as { card_id: string }[];
    const seen = new Set(rows.map(row => row.card_id));
    const due = (meeting: CalendarEvent | MeetingPrepCard) => {
      const start = agendaInstant(meeting.start, timeZone);
      return !meeting.allDay && start > now && start <= end && !seen.has('cardId' in meeting ? meeting.cardId : meetingId(meeting));
    };
    if (fresh) return { cards: (fresh.meetingPrep ?? []).filter(due), sources: fresh.sources };

    const range = { from: new Date(now).toISOString(), to: new Date(end + 1000).toISOString(), timeZone };
    const connections = this.options.connections.filter(id => canRead(`${id}:calendar`));
    const results = await Promise.all(connections.map(async id => {
      let events: CalendarEvent[] = [];
      const calendar = await readSource(`${id}:calendar`, async () => {
        const page = await google.listEvents(id, range);
        events = page.items.filter(event => event.attendees.length > 0 && due(event));
        return page.truncated;
      });
      const sources = [calendar];
      let messages: MailMessage[] = [];
      if (events.length && canRead(`${id}:mail`)) sources.push(await readSource(`${id}:mail`, async () => {
        const page = await google.listMessages(id);
        messages = page.items;
        return page.truncated;
      }));
      return { events, messages, sources };
    }));
    const tasks: Omit<BriefingItem, 'itemId'>[] = [];
    const sources = results.flatMap(result => result.sources);
    if (canRead('tasks') && results.some(result => result.events.length)) this.readTasks(null, sources, tasks);
    const cards = results.flatMap(({ events, messages }) => events.map(event => buildMeetingCard(event, messages, tasks, timeZone, rules)));
    return { cards: cards.sort(byMeetingStart), sources };
  }

  /** Claim before calling out: a throw or crash can leave delivery uncertain, so it must not be replayed. */
  claimMeetingPrep(cardId: string, start: number): boolean {
    const result = this.db.prepare('INSERT INTO meeting_prep_announced VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(this.options.profileId, cardId, start);
    return Number(result.changes) === 1;
  }

  /** The newest stored briefing of either kind, or null when none is kept. */
  latest(): Briefing | null { return this.one('ORDER BY created DESC LIMIT 1'); }

  get(briefingId: string): Briefing | null { return this.one('AND briefing_id = ?', briefingId); }

  draft(id: string): ReplyDraft | null {
    const row = this.db.prepare('SELECT body FROM briefing_reply_drafts WHERE profile = ? AND id = ? AND last_used >= ?').get(this.options.profileId, id, this.retentionCutoff(this.now()));
    return row ? JSON.parse(row.body as string) as ReplyDraft : null;
  }

  learnedRules(): LearnedRule[] {
    return this.db.prepare('SELECT body FROM briefing_triage_rules WHERE profile = ? ORDER BY rowid').all(this.options.profileId)
      .map(row => JSON.parse(row.body as string) as LearnedRule);
  }

  learnRule(text: string, authority: object): LearnedRule {
    if (authority !== this.options.operatorAuthority) fail('unauthorized');
    const rule: LearnedRule = { ruleId: randomUUID(), ...parseRule(text), createdAt: new Date(this.now()).toISOString() };
    const inserted = this.db.prepare(`INSERT INTO briefing_triage_rules (profile, id, body) SELECT ?, ?, ?
      WHERE (SELECT COUNT(*) FROM briefing_triage_rules WHERE profile = ?) < ?`)
      .run(this.options.profileId, rule.ruleId, JSON.stringify(rule), this.options.profileId, MAX_LEARNED_RULES);
    if (!inserted.changes) fail('triage_rules_full');
    return rule;
  }

  forgetRule(id: string, authority: object): boolean {
    if (authority !== this.options.operatorAuthority) fail('unauthorized');
    return this.db.prepare('DELETE FROM briefing_triage_rules WHERE profile = ? AND id = ?').run(this.options.profileId, id).changes !== 0;
  }

  /** Start turns one briefing item into a queued task in the store. Only the operator authority can call it; repeating it returns the same task. */
  start(briefingId: string, itemId: string, authority: object, request: StartRequest): Task {
    if (authority !== this.options.operatorAuthority) fail('unauthorized');
    const briefing = this.get(briefingId) ?? fail('briefing_unknown');
    const item = briefing.items.find(candidate => candidate.itemId === itemId) ?? fail('briefing_item_unknown');
    if (!item.startable) fail('briefing_item_not_startable');
    const store = this.options.store;

    const taskId = `briefing-${sha256(item.sourceRef).slice(0, 32)}`;
    const existing = store.get(taskId);
    if (existing) return existing;
    const task: Task = { version: 1, profileId: this.options.profileId, taskId, title: item.title, status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: request?.requestId };
    const event: Event = {
      version: 1, eventId: randomUUID(), profileId: this.options.profileId, sessionId: request?.sessionId, channelId: request?.channelId, taskId, runId: 'briefing-start',
      source: { actorId: request?.actorId, sourceKind: request?.sourceKind, sourceEventId: request?.requestId }, observedAt: new Date(this.now()).toISOString(),
      sequence: store.nextSequence(), correlationId: briefing.briefingId, evidence: { kind: 'observed', reference: `briefing:${briefing.briefingId}#${item.itemId}` },
    };
    try { return store.create(task, event); } catch (error) {

      const raced = store.get(taskId);
      if (raced) return raced;
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private dailyFor(localDate: string): Briefing | null { return this.one("AND local_date = ? AND kind = 'daily'", localDate); }

  /** One of this profile's briefings; `rest` is a fixed SQL suffix with placeholders for `args`, never input text. */
  private one(rest: string, ...args: (string | number)[]): Briefing | null {
    const row = this.db.prepare(`SELECT body FROM briefings WHERE profile = ? ${rest}`).get(this.options.profileId, ...args) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as Briefing : null;
  }

  private retentionCutoff(now: number): number { return now - this.retentionDays * DAY_MS; }

  private pruneExpired(now: number): void {
    const cutoff = this.retentionCutoff(now);
    this.db.prepare('DELETE FROM briefings WHERE profile = ? AND created < ?').run(this.options.profileId, cutoff);
    this.db.prepare('DELETE FROM briefing_reply_drafts WHERE profile = ? AND last_used < ?').run(this.options.profileId, cutoff);
  }

  private async compose(kind: BriefingKind, now: number, localDate: string, drafts?: ReplyDraft[]): Promise<Briefing> {
    const since = this.one('AND created >= ? ORDER BY created DESC LIMIT 1', this.retentionCutoff(now));
    const rules = { ...this.options.rules, learned: this.learnedRules() };
    const effects = new Map(rules.learned.map(({ ruleId, reason }) => [ruleId, { ruleId, reason, hidden: 0 }]));
    const sources: SourceState[] = [];
    const items: Item[] = [];
    let distractions = 0;
    const taskSequence = this.readTasks(since, sources, items);
    const agenda: AgendaItem[] = [];
    const { timeZone, meetingPrep, connections } = this.options;
    const tasks = items.filter(item => item.section === 'tasks');
    const cards: MeetingPrepCard[] = [];
    const range = dayRange(localDate, timeZone);
    const reads = await Promise.all(connections.map(id => readConnection({ ...this.options, rules }, id, range, now, since, effects,
      (message, result, sourceRef) => drafts && this.replyStep(message, result, sourceRef, drafts))));
    for (const found of reads) {
      for (const event of found.meetings) cards.push(buildMeetingCard(event, found.messages, tasks, timeZone, rules));
      sources.push(...found.sources);
      items.push(...found.mail, ...found.changes);
      agenda.push(...found.agenda);
      distractions += found.distractions;
    }
    agenda.sort((a, b) => a.at.localeCompare(b.at));
    const ordered = [...items, ...agenda.map(({ at: _at, ...item }) => item)]
      .sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] || SECTION_ORDER[a.section] - SECTION_ORDER[b.section]);
    return {
      version: 1, briefingId: randomUUID(), profileId: this.options.profileId, kind, localDate, timeZone: this.options.timeZone, createdAt: new Date(now).toISOString(),
      taskSequence, sources, items: ordered.map(item => ({ itemId: sha256(`${item.section}\n${item.sourceRef}`).slice(0, 16), ...item,
        step: item.step ?? { kind: 'next', text: NEXT_STEP[item.section] } })), distractions, ruleEffects: [...effects.values()],
      ...(meetingPrep ? { meetingPrep: cards.sort(byMeetingStart) } : {}),
    };
  }

  private replyStep(message: MailMessage, result: Triage, sourceRef: string, drafts: ReplyDraft[]): BriefingStep | undefined {
    if (result.private || result.suspectedInjection || message.bodyTruncated || message.attachments.some(a => a.executable)
      || !message.labels.includes('INBOX') || !message.labels.includes('UNREAD') || message.labels.includes('SENT') || message.labels.includes('DRAFT')) return;
    const draft = this.options.google.receiptReply(message);
    if (!draft) return;
    const draftId = `reply-${sha256(JSON.stringify([sourceRef, draft.preview.account, draft.preview.contentHash])).slice(0, 32)}`;
    drafts.push({ draftId, ...draft });
    return { kind: 'reply_draft', draftId, subject: draft.subject };
  }

  private saveDrafts(drafts: ReplyDraft[], now: number): void {
    const save = this.db.prepare(`INSERT INTO briefing_reply_drafts (profile, id, last_used, body) VALUES (?, ?, ?, ?)
      ON CONFLICT(profile, id) DO UPDATE SET last_used = MAX(last_used, excluded.last_used)`);
    for (const draft of drafts) save.run(this.options.profileId, draft.draftId, now, JSON.stringify(draft));
  }

  /** Open tasks, and the last state of every task changed since the previous briefing. Returns the sequence read up to. */
  private readTasks(since: Briefing | null, sources: SourceState[], items: Omit<BriefingItem, 'itemId'>[]): number {
    const store = this.options.store;
    try {
      const upTo = store.nextSequence() - 1;
      let truncated = false;
      let cursor: string | null = null;
      for (let page = 0; ; page++) {
        if (page >= MAX_STORE_PAGES) { truncated = true; break; }
        const result = store.list(cursor, 50);
        for (const task of result.tasks) {
          if (!OPEN_STATUSES.has(task.status)) continue;
          items.push({ section: 'tasks', title: task.title, sourceRef: `task:${task.taskId}`, reason: task.status, urgency: NEEDS_OWNER.has(task.status) ? 'urgent' : 'normal', uncertainty: 'low', untrusted: false, startable: false });
        }
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
      }
      if (since) {
        const changed = new Map<string, Task>();
        for (let after = since.taskSequence, page = 0; after < upTo; page++) {
          if (page >= MAX_STORE_PAGES) { truncated = true; break; }
          const events = store.events(after, 100).filter(entry => entry.event.sequence <= upTo);
          if (!events.length) break;
          for (const entry of events) changed.set(entry.task.taskId, entry.task);
          after = events.at(-1)!.event.sequence;
        }
        for (const task of changed.values()) items.push({ section: 'changes', title: bounded(`${task.title}: ${task.status}`), sourceRef: `task:${task.taskId}`, reason: 'changed_since_last_briefing', urgency: 'normal', uncertainty: 'low', untrusted: false, startable: false });
      }
      sources.push({ sourceId: 'tasks', state: truncated ? 'partial' : 'ok', error: truncated ? 'truncated' : null });
      return upTo;
    } catch (error) {
      sources.push({ sourceId: 'tasks', state: 'unavailable', error: errorCode(error) });
      return since?.taskSequence ?? 0;
    }
  }

}

async function readConnection({ google, timeZone, meetingPrep, rules }: ComposerOptions, id: string, { from, to }: { from: string; to: string }, now: number, since: Briefing | null,
  effects: Map<string, RuleEffect>, replyStep: (message: MailMessage, result: Triage, sourceRef: string) => BriefingStep | undefined) {
  const mail: Item[] = [], changes: Item[] = [], agenda: AgendaItem[] = [], meetings: CalendarEvent[] = [];
  let messages: MailMessage[] = [], distractions = 0;
  const prepEnd = now + DAY_MS;
  const dayStart = Date.parse(from), dayEnd = Date.parse(to);
  const calendarTo = meetingPrep && prepEnd > dayEnd ? new Date(prepEnd).toISOString() : to;
  const sources = await Promise.all([
    readSource(`${id}:mail`, async () => {
      const page = await google.listMessages(id);
      if (meetingPrep) messages = page.items;
      for (const message of page.items) {
        const result = triage(message, rules);
        const effect = result.hiddenBy ? effects.get(result.hiddenBy) : undefined;
        if (effect) effect.hidden++;
        if (effect || result.urgency === 'low') { distractions++; continue; }
        const sourceRef = `gmail:${id}:${message.ref.id}`;
        const step = replyStep(message, result, sourceRef);
        mail.push({ section: 'messages', title: result.private ? PRIVATE_TITLE : bounded(message.subject || '(no subject)'), sourceRef, reason: result.reason, urgency: result.urgency, uncertainty: result.uncertainty, untrusted: true, startable: !step, ...(step ? { step } : {}) });
      }
      return page.truncated;
    }),
    readSource(`${id}:calendar`, async () => {
      const page = await google.listEvents(id, { from, to: calendarTo, timeZone });
      for (const event of page.items) {
        if (meetingPrep) {
          const start = agendaInstant(event.start, timeZone);
          const end = agendaInstant(event.end, timeZone);
          const inPrep = start < prepEnd && (event.allDay ? end > now : start >= now);
          if (inPrep && event.attendees.length) meetings.push(event);
          if (start >= dayEnd || end <= dayStart) continue;
        }
        agenda.push({ at: event.allDay ? '' : event.start, section: 'agenda', title: bounded(`${event.localStart ?? 'All day'} ${event.title}`), sourceRef: `calendar:${id}:${event.ref.id}`, reason: event.recurring ? 'recurring_event' : 'event', urgency: 'normal', uncertainty: 'low', untrusted: true, startable: true });
        if (since && updatedSince(event, since.createdAt)) changes.push({ section: 'changes', title: bounded(`${event.title} (updated)`), sourceRef: `calendar:${id}:${event.ref.id}`, reason: 'changed_since_last_briefing', urgency: 'normal', uncertainty: 'low', untrusted: true, startable: false });
      }
      return page.truncated;
    }),
  ]);
  return { mail, changes, agenda, meetings, messages, distractions, sources };
}

async function readSource(sourceId: string, work: () => Promise<boolean>): Promise<SourceState> {
  try {
    const truncated = await work();
    return { sourceId, state: truncated ? 'partial' : 'ok', error: truncated ? 'truncated' : null };
  } catch (error) {
    return { sourceId, state: 'unavailable', error: errorCode(error) };
  }
}

function bounded(text: string): string { return boundedText(text, 200); }

function updatedSince(event: CalendarEvent, createdAt: string): boolean {
  return event.updated !== null && Date.parse(event.updated) > Date.parse(createdAt);
}


function dayRange(localDate: string, timeZone: string): { from: string; to: string } {
  const [year, month, day] = localDate.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    from: new Date(zonedInstant(year, month, day, 0, 0, timeZone)).toISOString(),
    to: new Date(zonedInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone)).toISOString(),
  };
}
