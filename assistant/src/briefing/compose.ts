import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Event, SourceKind } from '../contracts/events.ts';
import type { Task } from '../contracts/tasks.ts';
import type { CalendarEvent, GoogleConnections } from '../connectors/google.ts';
import { isTimeZone, localDateTime } from '../connectors/google.ts';
import { boundedInteger } from '../limits.ts';
import { sha256 } from '../hash.ts';
import { zonedInstant } from '../routines/schedule.ts';
import type { TaskStore } from '../store/db.ts';
import { triage, type TriageRules, type Uncertainty, type Urgency } from './triage.ts';

/**
 * Daily and on-demand briefings: the task inbox, today's agenda, triaged mail and what changed since the previous
 * briefing, with every source that could not be read listed as such. One daily briefing exists per profile and local
 * date however many clients ask; each on-demand briefing is its own. Message bodies are never stored, private
 * subjects are withheld, and nothing here starts work: Start is a separate call that needs the operator authority.
 */
export type BriefingKind = 'daily' | 'on_demand';
export type Section = 'tasks' | 'agenda' | 'messages' | 'changes';
export type BriefingItem = { itemId: string; section: Section; title: string; sourceRef: string; reason: string; urgency: Urgency; uncertainty: Uncertainty; untrusted: boolean; startable: boolean };
export type SourceState = { sourceId: string; state: 'ok' | 'partial' | 'unavailable'; error: string | null };
export type Briefing = {
  version: 1; briefingId: string; profileId: string; kind: BriefingKind; localDate: string; timeZone: string; createdAt: string;
  taskSequence: number; sources: SourceState[]; items: BriefingItem[]; distractions: number;
};
export type StartRequest = { requestId: string; sessionId: string; channelId: string; actorId: string; sourceKind: SourceKind };
export type ComposerOptions = {
  databasePath: string; profileId: string; operatorAuthority: object; timeZone: string; store: TaskStore; google: GoogleConnections;
  /** The connections to read, by name. There is no default: an unnamed account is never read. */
  connections: string[]; rules: TriageRules; retentionDays?: number; now?: () => number;
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
      CREATE UNIQUE INDEX IF NOT EXISTS briefings_daily ON briefings (profile, local_date) WHERE kind = 'daily';`);
  }

  /** Today's briefing for this profile; when another client already made it, that one is returned without reading again. */
  async daily(): Promise<Briefing> {
    const localDate = localDateTime(this.now(), this.options.timeZone).date;
    const existing = this.dailyFor(localDate);
    if (existing) return existing;
    const briefing = await this.compose('daily', localDate);
    // The first client to commit wins; a client that composed concurrently returns the stored one.
    this.db.prepare('INSERT INTO briefings VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING').run(this.options.profileId, briefing.briefingId, 'daily', localDate, Date.parse(briefing.createdAt), JSON.stringify(briefing));
    return this.dailyFor(localDate)!;
  }

  async onDemand(): Promise<Briefing> {
    const briefing = await this.compose('on_demand', localDateTime(this.now(), this.options.timeZone).date);
    this.db.prepare('INSERT INTO briefings VALUES (?, ?, ?, ?, ?, ?)').run(this.options.profileId, briefing.briefingId, 'on_demand', briefing.localDate, Date.parse(briefing.createdAt), JSON.stringify(briefing));
    return briefing;
  }

  /** The newest stored briefing of either kind, or null when none is kept. */
  latest(): Briefing | null { return this.one('ORDER BY created DESC LIMIT 1'); }

  get(briefingId: string): Briefing | null { return this.one('AND briefing_id = ?', briefingId); }

  /** Start turns one briefing item into a queued task in the store. Only the operator authority can call it; repeating it returns the same task. */
  start(briefingId: string, itemId: string, authority: object, request: StartRequest): Task {
    if (authority !== this.options.operatorAuthority) fail('unauthorized');
    const briefing = this.get(briefingId) ?? fail('briefing_unknown');
    const item = briefing.items.find(candidate => candidate.itemId === itemId) ?? fail('briefing_item_unknown');
    if (!item.startable) fail('briefing_item_not_startable');
    const store = this.options.store;
    // Keyed by the source item, so the same mail or event started from two briefings or clients is one task.
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
      // Another client may have started the same item between the check and the insert.
      const raced = store.get(taskId);
      if (raced) return raced;
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private dailyFor(localDate: string): Briefing | null { return this.one("AND local_date = ? AND kind = 'daily'", localDate); }

  /** One of this profile's briefings; `rest` is a fixed SQL suffix with placeholders for `args`, never input text. */
  private one(rest: string, ...args: string[]): Briefing | null {
    const row = this.db.prepare(`SELECT body FROM briefings WHERE profile = ? ${rest}`).get(this.options.profileId, ...args) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as Briefing : null;
  }

  private async compose(kind: BriefingKind, localDate: string): Promise<Briefing> {
    const now = this.now();
    this.db.prepare('DELETE FROM briefings WHERE profile = ? AND created < ?').run(this.options.profileId, now - this.retentionDays * DAY_MS);
    const since = this.latest();
    const sources: SourceState[] = [];
    const items: Omit<BriefingItem, 'itemId'>[] = [];
    let distractions = 0;
    const taskSequence = this.readTasks(since, sources, items);
    const agenda: (Omit<BriefingItem, 'itemId'> & { at: string })[] = [];
    const { from, to } = dayRange(localDate, this.options.timeZone);
    for (const connectionId of this.options.connections) {
      await this.read(`${connectionId}:mail`, sources, async () => {
        const page = await this.options.google.listMessages(connectionId);
        for (const message of page.items) {
          const result = triage(message, this.options.rules);
          if (result.urgency === 'low') { distractions++; continue; }
          items.push({ section: 'messages', title: result.private ? PRIVATE_TITLE : bounded(message.subject || '(no subject)'), sourceRef: `gmail:${connectionId}:${message.ref.id}`, reason: result.reason, urgency: result.urgency, uncertainty: result.uncertainty, untrusted: true, startable: true });
        }
        return page.truncated;
      });
      await this.read(`${connectionId}:calendar`, sources, async () => {
        const page = await this.options.google.listEvents(connectionId, { from, to, timeZone: this.options.timeZone });
        for (const event of page.items) {
          agenda.push({ at: event.allDay ? '' : event.start, section: 'agenda', title: bounded(`${event.localStart ?? 'All day'} ${event.title}`), sourceRef: `calendar:${connectionId}:${event.ref.id}`, reason: event.recurring ? 'recurring_event' : 'event', urgency: 'normal', uncertainty: 'low', untrusted: true, startable: true });
          if (since && updatedSince(event, since.createdAt)) items.push({ section: 'changes', title: bounded(`${event.title} (updated)`), sourceRef: `calendar:${connectionId}:${event.ref.id}`, reason: 'changed_since_last_briefing', urgency: 'normal', uncertainty: 'low', untrusted: true, startable: false });
        }
        return page.truncated;
      });
    }
    agenda.sort((a, b) => a.at.localeCompare(b.at));
    const ordered = [...items, ...agenda.map(({ at: _at, ...item }) => item)]
      .sort((a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] || SECTION_ORDER[a.section] - SECTION_ORDER[b.section]);
    return {
      version: 1, briefingId: randomUUID(), profileId: this.options.profileId, kind, localDate, timeZone: this.options.timeZone, createdAt: new Date(now).toISOString(),
      taskSequence, sources, items: ordered.map(item => ({ itemId: sha256(`${item.section}\n${item.sourceRef}`).slice(0, 16), ...item })), distractions,
    };
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

  /** One source: a failure is recorded with its code and does not stop the others. */
  private async read(sourceId: string, sources: SourceState[], work: () => Promise<boolean>): Promise<void> {
    try {
      const truncated = await work();
      sources.push({ sourceId, state: truncated ? 'partial' : 'ok', error: truncated ? 'truncated' : null });
    } catch (error) {
      sources.push({ sourceId, state: 'unavailable', error: errorCode(error) });
    }
  }
}

function bounded(text: string): string { return Array.from(text).slice(0, 200).join(''); }

function updatedSince(event: CalendarEvent, createdAt: string): boolean {
  return event.updated !== null && Date.parse(event.updated) > Date.parse(createdAt);
}

/** [local midnight, next local midnight) of a local date, as instants. */
function dayRange(localDate: string, timeZone: string): { from: string; to: string } {
  const [year, month, day] = localDate.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    from: new Date(zonedInstant(year, month, day, 0, 0, timeZone)).toISOString(),
    to: new Date(zonedInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone)).toISOString(),
  };
}
