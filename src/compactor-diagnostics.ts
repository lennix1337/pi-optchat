import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Api, AssistantMessage, AssistantMessageEvent, Model, ProviderResponse } from '@earendil-works/pi-ai';
import { record } from './cache.ts';
import { bytes, start, type Compression } from './memory.ts';

export interface CompactorDiagnostic {
  date: string; node: string; attempt: number; provider: string; model: string; api: string;
  requestedThinking: string; thinking?: string; elapsedMs: number; sourceBytes: number; viewBytes: number; tools: number;
  events: Record<string, number>; requestBytes?: number; toolChoice?: string; httpStatus?: number; requestId?: string;
  nativeStatus?: string; responseId?: string; incompleteReason?: string; nativeErrorCode?: string; nativeOutputTypes?: string[];
  nativeContentTypes?: string[]; nativeTextBytes?: number;
  stopReason?: string; rawStopReason?: string; blocks?: { type: string; bytes?: number; name?: string }[];
  usage?: AssistantMessage['usage']; outcome?: string; errorCategory?: string;
  transportCode?: string; aborted?: boolean; lastEventElapsedMs?: number;
}
/** Identifier fields only, never arbitrary response/error strings or headers. */
const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : undefined;
const transportCodes = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ABORT_ERR']);
function transportCode(error: unknown): string | undefined {
  for (let depth = 0; depth < 5 && record(error); depth++) {
    if (typeof error.code === 'string' && transportCodes.has(error.code)) return error.code;
    error = error.cause;
  }
}
export function errorCategory(error: unknown) {
  const code = transportCode(error);
  if (code === 'ABORT_ERR') return 'cancelled';
  if (code?.includes('TIMEOUT') || code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ECONNREFUSED' || code === 'EAI_AGAIN' || code === 'ENOTFOUND') return 'connection_failure';
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET') return 'stream_interrupted';
  const text = error instanceof Error ? error.message : String(error);
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
export class CompactorTrace {
  readonly diagnostic: CompactorDiagnostic;
  private readonly began = Date.now();
  constructor(input: Compression, model: Model<Api>, requestedThinking: string, thinking: string | undefined, attempt: number, tools: number) {
    this.diagnostic = { date: new Date().toISOString(), node: `${start(input.part)}+${2 ** input.part.l}`, attempt,
      provider: model.provider, model: model.id, api: model.api, requestedThinking, thinking,
      elapsedMs: 0, sourceBytes: bytes(input.source), viewBytes: bytes(input.context), tools, events: {} };
  }
  payload(payload: unknown) {
    this.diagnostic.requestBytes = bytes(JSON.stringify(payload) ?? '');
    if (!record(payload)) return;
    const choice = record(payload.tool_choice) ? payload.tool_choice.type : payload.tool_choice;
    if (choice === 'none' || choice === 'auto' || choice === 'required' || choice === 'any') this.diagnostic.toolChoice = choice;
  }
  response(response: ProviderResponse) {
    this.diagnostic.httpStatus = response.status;
    this.diagnostic.requestId = identifier(response.headers['x-request-id'] ?? response.headers['request-id']);
  }
  event(event: AssistantMessageEvent) {
    this.diagnostic.lastEventElapsedMs = Date.now() - this.began;
    const counts = this.diagnostic.events;
    counts[event.type] = (counts[event.type] ?? 0) + 1;
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
      this.diagnostic.nativeOutputTypes = response.output.flatMap(item => record(item) && identifier(item.type) ? [identifier(item.type)!] : []);
      const content = response.output.flatMap(item => record(item) && Array.isArray(item.content) ? item.content.filter(record) : []);
      this.diagnostic.nativeContentTypes = content.flatMap(block => identifier(block.type) ? [identifier(block.type)!] : []);
      this.diagnostic.nativeTextBytes = content.reduce((total, block) => total + (block.type === 'output_text' && typeof block.text === 'string' ? bytes(block.text) : 0), 0);
    }
  }
  result(reply: AssistantMessage) {
    const d = this.diagnostic;
    d.stopReason = reply.stopReason; d.rawStopReason = identifier(reply.rawStopReason);
    d.usage = reply.usage;
    d.blocks = reply.content.map(block => ({ type: block.type,
      ...(block.type === 'text' ? { bytes: bytes(block.text) } : {}),
      ...(block.type === 'thinking' ? { bytes: bytes(block.thinking) } : {}),
      ...(block.type === 'toolCall' ? { name: identifier(block.name) } : {}) }));
    if (reply.errorMessage) d.errorCategory = errorCategory(reply.errorMessage);
    if (reply.stopReason === 'error' || reply.stopReason === 'aborted' || reply.stopReason === 'length') d.outcome = reply.stopReason;
    else if (reply.content.some(block => block.type === 'toolCall')) d.outcome = 'tool_call';
    else if (reply.content.some(block => block.type === 'text' && block.text.trim())) d.outcome = 'text';
    else d.outcome = 'empty';
  }
  failure(error: unknown) {
    this.diagnostic.outcome ??= 'exception';
    this.diagnostic.errorCategory ??= errorCategory(error);
    const code = transportCode(error);
    if (code) this.diagnostic.transportCode = code;
  }
  finish(signal: AbortSignal) {
    this.diagnostic.elapsedMs = Date.now() - this.began;
    this.diagnostic.aborted = signal.aborted;
    return this.diagnostic;
  }
}
/** Two bounded files; no prompts, output text, tool arguments, reasoning, or credentials. */
export function writeCompactorDiagnostic(directory: string, diagnostic: CompactorDiagnostic) {
  const file = join(directory, 'compactor-diagnostics.jsonl');
  const line = JSON.stringify(diagnostic) + '\n';
  if (existsSync(file) && statSync(file).size + bytes(line) > 1_000_000) renameSync(file, `${file}.1`);
  appendFileSync(file, line, { mode: 0o600 });
}
