import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { record } from './cache.ts';
import { appendJson } from './store.ts';
import { nonnegative, safeIdentifier } from './diagnostic-metadata.ts';

export type UsageRole = 'main' | 'subagent' | 'compactor' | 'import';
export type UsageKind = 'conversation' | 'subagent' | 'compaction' | 'session-overhead' | 'import';
export type UsageOutcome = 'stop' | 'toolUse' | 'length' | 'error' | 'aborted' | 'text' | 'tool_call' | 'empty' | 'exception';
export type UsageErrorCategory = 'cancelled' | 'timeout' | 'connection_failure' | 'stream_interrupted' | 'rate_or_usage_limit' | 'authentication' | 'policy_refusal' | 'unavailable' | 'context_limit' | 'other';
export const ranges = ['This session', 'Last hour', 'Today', 'Last 7 days', 'All time'] as const;
export type UsageRange = typeof ranges[number];
export interface UsageEntry {
  id?: string; date: string; role: UsageRole; model: string; provider?: string;
  session?: string; runId?: string; usage: Usage;
  /** Optional attribution fields; omitted by pre-existing ledger records. */
  incidentId?: string; recoveryIncidentId?: string; attempt?: number; kind?: UsageKind; outcome?: UsageOutcome; failed?: boolean; errorCategory?: UsageErrorCategory;
}
export interface UsageAttribution {
  incidentId?: string; recoveryIncidentId?: string; attempt?: number; outcome?: UsageOutcome; failed?: boolean; errorCategory?: UsageErrorCategory;
}
const usageKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const;
const costKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const;
const roles: UsageRole[] = ['main', 'subagent', 'compactor', 'import'];
const kinds: UsageKind[] = ['conversation', 'subagent', 'compaction', 'session-overhead', 'import'];
const outcomes: UsageOutcome[] = ['stop', 'toolUse', 'length', 'error', 'aborted', 'text', 'tool_call', 'empty', 'exception'];
const errorCategories = ['cancelled', 'timeout', 'connection_failure', 'stream_interrupted', 'rate_or_usage_limit', 'authentication', 'policy_refusal', 'unavailable', 'context_limit', 'other'];
function validUsage(value: unknown): value is Usage {
  if (!record(value) || !record(value.cost)) return false;
  const cost = value.cost;
  return usageKeys.every(k => nonnegative(value[k])) && costKeys.every(k => nonnegative(cost[k]));
}
const optionalString = (value: unknown) => value === undefined || typeof value === 'string';
const stopOutcome = (value: AssistantMessage['stopReason']): UsageOutcome | undefined => outcomes.includes(value as UsageOutcome) ? value as UsageOutcome : undefined;
type MessageEntry = Extract<SessionEntry, { type: 'message' }>;
function backfilledMessage(entry: MessageEntry, session: string, role: 'main' | 'subagent', runId?: string): UsageEntry | undefined {
  const { message } = entry;
  if ((message.role !== 'assistant' && message.role !== 'toolResult') || !message.usage) return;
  const failed = message.role === 'assistant' && (message.stopReason === 'error' || message.stopReason === 'aborted');
  const outcome = message.role === 'assistant' ? stopOutcome(message.stopReason) : undefined;
  return { id: `entry:${entry.id}:${entry.timestamp}`, date: new Date(message.timestamp).toISOString(), role, session, runId,
    provider: message.role === 'assistant' ? message.provider : undefined,
    model: message.role === 'assistant' ? message.model : 'tool-usage-model-unavailable', usage: message.usage,
    kind: role === 'subagent' ? 'subagent' : 'conversation', ...(outcome ? { outcome } : {}), ...(failed ? { failed: true } : {}) };
}
function backfilledOverhead(entry: SessionEntry, session: string, role: 'main' | 'subagent', runId?: string): UsageEntry | undefined {
  if ((entry.type !== 'usage' && entry.type !== 'compaction' && entry.type !== 'branch_summary') || !entry.usage) return;
  return { id: `entry:${entry.id}:${entry.timestamp}`, date: entry.timestamp, role, session, runId, model: 'session-overhead',
    kind: entry.type === 'compaction' ? 'compaction' : 'session-overhead', usage: entry.usage };
}
function copyUsage(value: Usage): Usage {
  return {
    input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite,
    totalTokens: value.totalTokens,
    cost: { input: value.cost.input, output: value.cost.output, cacheRead: value.cost.cacheRead, cacheWrite: value.cost.cacheWrite, total: value.cost.total },
  };
}
function validEntry(value: unknown): value is UsageEntry {
  return record(value) && typeof value.date === 'string' && Number.isFinite(Date.parse(value.date))
    && typeof value.role === 'string' && roles.includes(value.role as UsageRole) && typeof value.model === 'string'
    && ['id', 'provider', 'session', 'runId', 'incidentId', 'recoveryIncidentId'].every(k => optionalString(value[k]))
    && (value.attempt === undefined || (typeof value.attempt === 'number' && Number.isSafeInteger(value.attempt) && value.attempt > 0))
    && (value.kind === undefined || (typeof value.kind === 'string' && kinds.includes(value.kind as UsageKind)))
    && (value.outcome === undefined || (typeof value.outcome === 'string' && outcomes.includes(value.outcome as UsageOutcome)))
    && (value.failed === undefined || typeof value.failed === 'boolean')
    && (value.errorCategory === undefined || (typeof value.errorCategory === 'string' && errorCategories.includes(value.errorCategory)))
    && validUsage(value.usage);
}
function canonicalEntry(entry: UsageEntry): UsageEntry {
  const parsedDate = Date.parse(entry.date);
  const safe = (value: string | undefined) => safeIdentifier(value) ? value : undefined;
  return {
    ...(safe(entry.id) ? { id: entry.id } : {}), date: new Date(parsedDate).toISOString(), role: entry.role,
    model: safe(entry.model) ? entry.model : 'unknown',
    ...(safe(entry.provider) ? { provider: entry.provider } : {}),
    ...(safe(entry.session) ? { session: entry.session } : {}),
    ...(safe(entry.runId) ? { runId: entry.runId } : {}),
    ...(safe(entry.incidentId) ? { incidentId: entry.incidentId } : {}),
    ...(safe(entry.recoveryIncidentId) ? { recoveryIncidentId: entry.recoveryIncidentId } : {}),
    ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
    ...(entry.kind === undefined ? {} : { kind: entry.kind }),
    ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
    ...(entry.failed === undefined ? {} : { failed: entry.failed }),
    ...(entry.errorCategory === undefined ? {} : { errorCategory: entry.errorCategory }),
    usage: copyUsage(entry.usage),
  };
}
export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
export function addUsage(total: Usage, usage: Usage) {
  for (const key of usageKeys) total[key] += usage[key];
  for (const key of costKeys) total.cost[key] += usage.cost[key];
}

/** One profile's ledger. Stable message IDs make resume/backfill idempotent. */
export class UsageLedger {
  readonly entries: UsageEntry[] = [];
  private invalid = 0;
  private readonly ids = new Set<string>();
  private readonly cursors = new Map<string, number>();
  private readonly file: string;
  constructor(directory: string) {
    this.file = join(directory, 'usage.jsonl');
    const contents = existsSync(this.file) ? readFileSync(this.file, 'utf8') : '';
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry: unknown = JSON.parse(line);
        if (!validEntry(entry)) { this.invalid++; continue; }
        if (entry.id && this.ids.has(entry.id)) continue;
        this.entries.push(entry); if (entry.id) this.ids.add(entry.id);
      } catch { this.invalid++; }
    }
    if (contents && !contents.endsWith('\n')) appendFileSync(this.file, '\n');
  }
  get warnings() { return this.invalid ? [`${this.invalid} unreadable usage records excluded; totals may be incomplete.`] : []; }
  add(entry: UsageEntry) {
    if (!validEntry(entry)) { this.invalid++; return; }
    const safeEntry = canonicalEntry(entry);
    if (safeEntry.id && this.ids.has(safeEntry.id)) return;
    appendJson(this.file, safeEntry);
    this.entries.push(safeEntry); if (safeEntry.id) this.ids.add(safeEntry.id);
  }
  compression(message: AssistantMessage, role: 'compactor' | 'import', session: string, attribution: UsageAttribution = {}) {
    const hasText = message.content.some(block => block.type === 'text' && block.text.trim());
    const hasToolCall = message.content.some(block => block.type === 'toolCall');
    const failed = attribution.failed ?? (message.stopReason === 'error' || message.stopReason === 'aborted' || message.stopReason === 'length' || !hasText || hasToolCall);
    this.add({ id: randomUUID(), date: new Date(message.timestamp).toISOString(), role, session,
      provider: message.provider, model: message.model, usage: message.usage,
      kind: role === 'import' ? 'import' : 'compaction',
      outcome: attribution.outcome ?? (hasToolCall ? 'tool_call' : hasText ? stopOutcome(message.stopReason) : 'empty'),
      failed,
      ...(attribution.incidentId === undefined ? {} : { incidentId: attribution.incidentId }),
      ...(attribution.recoveryIncidentId === undefined ? {} : { recoveryIncidentId: attribution.recoveryIncidentId }),
      ...(attribution.attempt === undefined ? {} : { attempt: attribution.attempt }),
      ...(attribution.errorCategory === undefined ? {} : { errorCategory: attribution.errorCategory }),
    });
  }
  backfill(entries: SessionEntry[], session: string, role: 'main' | 'subagent' = 'main', runId?: string) {
    const cursorKey = `${session}:${runId ?? ''}`;
    const cursor = this.cursors.get(cursorKey) ?? 0;
    for (const entry of entries.slice(cursor <= entries.length ? cursor : 0)) {
      // Pi forks preserve entry IDs/timestamps. Never count inherited responses twice.
      const usage = entry.type === 'message' ? backfilledMessage(entry, session, role, runId) : backfilledOverhead(entry, session, role, runId);
      if (usage) this.add(usage);
    }
    this.cursors.set(cursorKey, entries.length);
  }
  select(range: UsageRange, session: string, now = Date.now()) {
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const since = range === 'Last hour' ? now - 3600_000 : range === 'Today' ? today.getTime() : range === 'Last 7 days' ? now - 7 * 86400_000 : 0;
    return this.entries.filter(e => range === 'This session' ? e.session === session : range === 'All time' || (Date.parse(e.date) >= since && Date.parse(e.date) <= now));
  }
}

export function summarizeUsage(entries: UsageEntry[]) {
  const total = emptyUsage(), groups = new Map<string, { role: UsageRole; provider?: string; model: string; usage: Usage; failures: number }>();
  let failures = 0;
  for (const entry of entries) {
    // Provider is part of a model's identity; legacy records without it remain grouped under unknown.
    const key = JSON.stringify([entry.role, entry.provider ?? '', entry.model]);
    let group = groups.get(key);
    if (!group) { group = { role: entry.role, provider: entry.provider, model: entry.model, usage: emptyUsage(), failures: 0 }; groups.set(key, group); }
    addUsage(group.usage, entry.usage); addUsage(total, entry.usage);
    if (entry.failed) { group.failures++; failures++; }
  }
  return { total, failures, groups: [...groups.values()] };
}
