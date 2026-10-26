import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderResponse } from '@earendil-works/pi-ai';
import { record } from './cache.ts';
import { nonnegative, safeIdentifier } from './diagnostic-metadata.ts';
import { bytes, start, type Compression } from './memory.ts';
import type { UsageErrorCategory, UsageOutcome } from './usage.ts';

export interface CompactorDiagnostic {
  date: string; node: string; attempt: number; provider: string; model: string; api: string;
  requestedThinking: string; thinking?: string; elapsedMs: number; sourceBytes: number; viewBytes: number; tools: number;
  events: Record<string, number>; requestBytes?: number; toolChoice?: string; httpStatus?: number; requestId?: string;
  nativeStatus?: string; responseId?: string; incompleteReason?: string; nativeErrorCode?: string; nativeOutputTypes?: string[];
  nativeContentTypes?: string[]; nativeTextBytes?: number;
  stopReason?: string; rawStopReason?: string; blocks?: { type: string; bytes?: number; name?: string }[];
  usage?: AssistantMessage['usage']; outcome?: UsageOutcome; errorCategory?: UsageErrorCategory;
  transportCode?: string; aborted?: boolean; lastEventElapsedMs?: number;
  /** Local correlation ID shared by recovery and all attempts in one compaction operation. */
  incidentId?: string; recoveryIncidentId?: string; sessionId?: string; kind?: 'compaction'; failed?: boolean;
}
export type RecoveryPhase = 'started' | 'recovering' | 'stopped' | 'completed';
export type RecoveryCategory = 'policy_refusal' | 'quota' | 'context_limit' | 'transient' | 'unknown';
export interface RecoveryIncidentEvent {
  incidentId: string; phase: RecoveryPhase; category: RecoveryCategory; provider?: string; model?: string;
  /** Session correlation is optional because the producer may not have session context. */
  sessionId?: string;
}
export interface RecoveryDiagnostic extends RecoveryIncidentEvent { date: string; kind: 'recovery' }
const recoveryPhases = new Set<RecoveryPhase>(['started', 'recovering', 'stopped', 'completed']);
const recoveryCategories = new Set<RecoveryCategory>(['policy_refusal', 'quota', 'context_limit', 'transient', 'unknown']);
const isIdentifier = (value: unknown): value is string => safeIdentifier(value) && !value.includes('/');
const identifier = (value: unknown) => isIdentifier(value) ? value : undefined;
const boundedNumber = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => nonnegative(value) && value <= max;
const thinkings = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const outcomes = new Set(['stop', 'toolUse', 'error', 'aborted', 'length', 'text', 'tool_call', 'empty', 'exception']);
const categories = new Set(['cancelled', 'timeout', 'connection_failure', 'stream_interrupted', 'rate_or_usage_limit', 'authentication', 'policy_refusal', 'unavailable', 'context_limit', 'other']);
const choices = new Set(['none', 'auto', 'required', 'any']);
export const createCompactorIncidentId = () => randomUUID();
const transportCodes = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR']);
function transportCode(error: unknown): string | undefined {
  for (let depth = 0; depth < 5 && record(error); depth++) {
    if (typeof error.code === 'string' && transportCodes.has(error.code)) return error.code;
    error = error.cause;
  }
}
export function errorCategory(error: unknown): UsageErrorCategory {
  if (record(error) && error.code === 'OPTCHAT_POLICY_REFUSAL') return 'policy_refusal';
  const text = error instanceof Error ? error.message : String(error);
  if (/\bOPTCHAT_POLICY_REFUSAL\b/.test(text)) return 'policy_refusal';
  const code = transportCode(error);
  if (code === 'ABORT_ERR') return 'cancelled';
  if (code?.includes('TIMEOUT') || code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'ENOTFOUND') return 'connection_failure';
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') return 'stream_interrupted';
  if (/abort|cancel/i.test(text)) return 'cancelled';
  if (/rate.?limit|\b429\b|quota|usage.limit|billing/i.test(text)) return 'rate_or_usage_limit';
  if (/auth|api.key|401|403/i.test(text)) return 'authentication';
  if (/overload|unavailable|\b502\b|\b503\b|\b504\b|\b529\b/i.test(text)) return 'unavailable';
  if (/upstream connect error|disconnect\/reset before headers|connection refused|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|fetch failed/i.test(text)) return 'connection_failure';
  if (/timeout|timed.out/i.test(text)) return 'timeout';
  if (/context|too.long|token.limit/i.test(text)) return 'context_limit';
  if (/\bterminated\b|stream ended without a stop reason|ECONNRESET|UND_ERR_SOCKET/i.test(text)) return 'stream_interrupted';
  return 'other';
}
function safeUsage(value: unknown): AssistantMessage['usage'] | undefined {
  if (!record(value) || !record(value.cost)) return undefined;
  const cost = value.cost;
  const usageKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const;
  const costKeys = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const;
  if (!usageKeys.every(key => boundedNumber(value[key])) || !costKeys.every(key => boundedNumber(cost[key]))) return undefined;
  return { input: value.input as number, output: value.output as number, cacheRead: value.cacheRead as number,
    cacheWrite: value.cacheWrite as number, totalTokens: value.totalTokens as number,
    cost: { input: cost.input as number, output: cost.output as number, cacheRead: cost.cacheRead as number,
      cacheWrite: cost.cacheWrite as number, total: cost.total as number } };
}
function safeStringArray(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  return values.slice(0, 64).flatMap(value => safeIdentifier(value, 80) ? [value] : []);
}
/** Project diagnostics onto a strict metadata-only schema before any persistence. */
export function sanitizeCompactorDiagnostic(value: CompactorDiagnostic): CompactorDiagnostic | undefined {
  if (!record(value) || typeof value.date !== 'string' || !Number.isFinite(Date.parse(value.date))
    || typeof value.node !== 'string' || !/^\d+\+\d+$/.test(value.node)
    || !Number.isSafeInteger(value.attempt) || value.attempt < 0
    || !boundedNumber(value.elapsedMs) || !boundedNumber(value.sourceBytes) || !boundedNumber(value.viewBytes) || !boundedNumber(value.tools, 100_000)
    || !record(value.events)) return undefined;
  const eventEntries = Object.entries(value.events).slice(0, 64).filter(([name, count]) => safeIdentifier(name, 80) && Number.isSafeInteger(count) && Number(count) >= 0);
  const diagnostic: CompactorDiagnostic = {
    date: new Date(Date.parse(value.date)).toISOString(), node: value.node, attempt: value.attempt,
    provider: safeIdentifier(value.provider) ? value.provider : 'unknown', model: safeIdentifier(value.model) ? value.model : 'unknown',
    api: safeIdentifier(value.api) ? value.api : 'unknown',
    requestedThinking: typeof value.requestedThinking === 'string' && thinkings.has(value.requestedThinking) ? value.requestedThinking : 'unknown',
    elapsedMs: value.elapsedMs, sourceBytes: value.sourceBytes, viewBytes: value.viewBytes, tools: value.tools,
    events: Object.fromEntries(eventEntries.map(([name, count]) => [name, count as number])), kind: 'compaction',
  };
  if (safeIdentifier(value.incidentId)) diagnostic.incidentId = value.incidentId;
  if (safeIdentifier(value.recoveryIncidentId)) diagnostic.recoveryIncidentId = value.recoveryIncidentId;
  if (identifier(value.sessionId)) diagnostic.sessionId = value.sessionId;
  if (typeof value.thinking === 'string' && thinkings.has(value.thinking)) diagnostic.thinking = value.thinking;
  for (const key of ['requestBytes', 'nativeTextBytes', 'lastEventElapsedMs'] as const) if (boundedNumber(value[key])) diagnostic[key] = value[key];
  if (Number.isInteger(value.httpStatus) && value.httpStatus! >= 100 && value.httpStatus! <= 599) diagnostic.httpStatus = value.httpStatus;
  if (typeof value.toolChoice === 'string' && choices.has(value.toolChoice)) diagnostic.toolChoice = value.toolChoice;
  if (typeof value.aborted === 'boolean') diagnostic.aborted = value.aborted;
  if (typeof value.failed === 'boolean') diagnostic.failed = value.failed;
  if (identifier(value.requestId)) diagnostic.requestId = value.requestId;
  if (identifier(value.responseId)) diagnostic.responseId = value.responseId;
  for (const key of ['nativeStatus', 'incompleteReason', 'nativeErrorCode', 'stopReason', 'rawStopReason'] as const) {
    const allowed = key === 'stopReason' ? outcomes : undefined;
    if (typeof value[key] === 'string' && (allowed?.has(value[key]!) ?? safeIdentifier(value[key]))) diagnostic[key] = value[key];
  }
  if (Array.isArray(value.nativeOutputTypes)) diagnostic.nativeOutputTypes = safeStringArray(value.nativeOutputTypes);
  if (Array.isArray(value.nativeContentTypes)) diagnostic.nativeContentTypes = safeStringArray(value.nativeContentTypes);
  if (typeof value.outcome === 'string' && outcomes.has(value.outcome)) diagnostic.outcome = value.outcome;
  if (typeof value.errorCategory === 'string' && categories.has(value.errorCategory)) diagnostic.errorCategory = value.errorCategory;
  if (typeof value.transportCode === 'string' && transportCodes.has(value.transportCode)) diagnostic.transportCode = value.transportCode;
  const usage = safeUsage(value.usage);
  if (usage) diagnostic.usage = usage;
  if (Array.isArray(value.blocks)) diagnostic.blocks = value.blocks.slice(0, 64).flatMap(block => record(block) && safeIdentifier(block.type, 80)
    ? [{ type: block.type, ...(boundedNumber(block.bytes) ? { bytes: block.bytes } : {}), ...(identifier(block.name) ? { name: block.name } : {}) }]
    : []);
  return diagnostic;
}
export class CompactorTrace {
  readonly diagnostic: CompactorDiagnostic;
  private readonly began = Date.now();
  constructor(input: Compression, model: Model<Api>, requestedThinking: string, thinking: string | undefined, attempt: number, tools: number, incidentId: string = createCompactorIncidentId()) {
    this.diagnostic = { date: new Date().toISOString(), node: `${start(input.part)}+${2 ** input.part.l}`, attempt,
      incidentId, kind: 'compaction', provider: model.provider, model: model.id, api: model.api,
      requestedThinking, thinking,
      elapsedMs: 0, sourceBytes: bytes(input.source), viewBytes: bytes(input.context), tools, events: {} };
  }
  payload(payload: unknown) {
    this.diagnostic.requestBytes = bytes(JSON.stringify(payload) ?? '');
    if (!record(payload)) return;
    const choice = record(payload.tool_choice) ? payload.tool_choice.type : payload.tool_choice;
    if (typeof choice === 'string' && choices.has(choice)) this.diagnostic.toolChoice = choice;
  }
  response(response: ProviderResponse) {
    this.diagnostic.httpStatus = response.status;
    this.diagnostic.requestId = identifier(response.headers['x-request-id'] ?? response.headers['request-id']);
  }
  event(event: AssistantMessageEvent) {
    this.diagnostic.lastEventElapsedMs = Date.now() - this.began;
    const counts = this.diagnostic.events;
    if (event.type.length <= 80 && safeIdentifier(event.type)) counts[event.type] = (counts[event.type] ?? 0) + 1;
  }
  native(event: unknown) {
    this.diagnostic.lastEventElapsedMs = Date.now() - this.began;
    if (!record(event) || !record(event.response)) return;
    const response = event.response;
    this.diagnostic.nativeStatus = identifier(response.status);
    this.diagnostic.responseId = identifier(response.id);
    if (record(response.incomplete_details)) this.diagnostic.incompleteReason = identifier(response.incomplete_details.reason);
    if (record(response.error)) this.diagnostic.nativeErrorCode = identifier(response.error.code);
    if (Array.isArray(response.output)) {
      this.diagnostic.nativeOutputTypes = response.output.flatMap(item => record(item) && safeIdentifier(item.type, 80) ? [item.type] : []);
      const content = response.output.flatMap(item => record(item) && Array.isArray(item.content) ? item.content.filter(record) : []);
      this.diagnostic.nativeContentTypes = content.flatMap(block => safeIdentifier(block.type, 80) ? [block.type] : []);
      this.diagnostic.nativeTextBytes = content.reduce((total, block) => total + (block.type === 'output_text' && typeof block.text === 'string' ? bytes(block.text) : 0), 0);
    }
  }
  result(reply: AssistantMessage) {
    const d = this.diagnostic;
    d.stopReason = reply.stopReason; d.rawStopReason = identifier(reply.rawStopReason);
    d.usage = safeUsage(reply.usage);
    d.blocks = reply.content.map(block => ({ type: block.type,
      ...(block.type === 'text' ? { bytes: bytes(block.text) } : {}),
      ...(block.type === 'thinking' ? { bytes: bytes(block.thinking) } : {}),
      ...(block.type === 'toolCall' && identifier(block.name) ? { name: block.name } : {}) }));
    if (reply.errorMessage) d.errorCategory = errorCategory(reply.errorMessage);
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted' || reply.stopReason === 'length') d.outcome = reply.stopReason;
    else if (reply.content.some(block => block.type === 'toolCall')) d.outcome = 'tool_call';
    else if (reply.content.some(block => block.type === 'text' && block.text.trim())) d.outcome = 'text';
    else d.outcome = 'empty';
    d.failed = reply.stopReason === 'error' || reply.stopReason === 'aborted' || reply.stopReason === 'length' || d.outcome !== 'text';
  }
  failure(error: unknown) {
    this.diagnostic.outcome ??= 'exception';
    this.diagnostic.failed = true;
    this.diagnostic.errorCategory ??= errorCategory(error);
    const code = transportCode(error);
    if (code) this.diagnostic.transportCode = code;
  }
  finish(signal: AbortSignal) {
    this.diagnostic.elapsedMs = Date.now() - this.began;
    this.diagnostic.aborted = signal.aborted;
    return sanitizeCompactorDiagnostic(this.diagnostic) ?? this.diagnostic;
  }
}
export function sanitizeRecoveryDiagnostic(value: unknown, date = new Date().toISOString()): RecoveryDiagnostic | undefined {
  if (!record(value) || !Number.isFinite(Date.parse(date)) || !safeIdentifier(value.incidentId)
    || typeof value.phase !== 'string' || !recoveryPhases.has(value.phase as RecoveryPhase)
    || typeof value.category !== 'string' || !recoveryCategories.has(value.category as RecoveryCategory)) return undefined;
  return {
    date: new Date(Date.parse(date)).toISOString(), kind: 'recovery', incidentId: value.incidentId,
    phase: value.phase as RecoveryPhase, category: value.category as RecoveryCategory,
    ...(safeIdentifier(value.provider) ? { provider: value.provider } : {}),
    ...(safeIdentifier(value.model) ? { model: value.model } : {}),
    ...(isIdentifier(value.sessionId) ? { sessionId: value.sessionId } : {}),
  };
}
function appendBoundedDiagnostic(directory: string, name: string, diagnostic: object) {
  const file = join(directory, name);
  const line = JSON.stringify(diagnostic) + '\n';
  if (existsSync(file) && statSync(file).size + bytes(line) > 1_000_000) renameSync(file, `${file}.1`);
  appendFileSync(file, line, { mode: 0o600 });
}
/** Project before persisting; each JSONL diagnostic stream rotates at 1 MB. */
function writeProjectedDiagnostic<T>(directory: string, name: string, value: T, project: (value: T) => object | undefined) {
  const diagnostic = project(value);
  if (diagnostic) appendBoundedDiagnostic(directory, name, diagnostic);
}
/** Metadata-only compactor diagnostics; each JSONL stream retains one rotated 1 MB file. */
export const writeCompactorDiagnostic = (directory: string, diagnostic: CompactorDiagnostic) =>
  writeProjectedDiagnostic(directory, 'compactor-diagnostics.jsonl', diagnostic, sanitizeCompactorDiagnostic);
/** One main request's view against the last one's (cache.ts ViewReport), joined to usage.jsonl by date. It runs while the request
 * is built, so a failed write is reported and the request goes on. */
export function writeCacheDiagnostic(directory: string, report: object) {
  try { appendBoundedDiagnostic(directory, 'cache-diagnostics.jsonl', report); }
  catch { console.error('OptChat could not write cache-diagnostics.jsonl; requests are unchanged.'); }
}
/** Persist a metadata-only main recovery event for correlation with attempts and session journals. */
export const writeRecoveryDiagnostic = (directory: string, event: RecoveryIncidentEvent) =>
  writeProjectedDiagnostic(directory, 'recovery-diagnostics.jsonl', event, sanitizeRecoveryDiagnostic);
