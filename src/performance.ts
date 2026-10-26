import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { estimatedContextTokens } from './run-context.ts';

export type Stage = 'context' | 'projection' | 'tool' | 'provider_headers' | 'first_content' | 'response' | 'persistence' | 'settle' | 'child_open' | 'compaction';
interface Timing { count: number; totalMs: number; maxMs: number; lastMs: number }
/** Tool names kept apart; later ones are counted together. Recent durations kept per tool for its percentiles. */
const TOOL_NAMES = 64, TOOL_SAMPLES = 256, OTHER_TOOLS = '(other)';
const round = (ms: number) => Math.round(ms * 10) / 10;
/** Nearest-rank percentile of sorted durations. */
const rank = (sorted: readonly number[], p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
/** Each tool's own execution time by name, slowest total first. */
class ToolTimings {
  private readonly tools = new Map<string, { count: number; errors: number; totalMs: number; maxMs: number; samples: number[] }>();
  record(name: string, duration: number, isError: boolean) {
    const key = this.tools.has(name) || this.tools.size < TOOL_NAMES ? name : OTHER_TOOLS;
    const timing = this.tools.get(key) ?? { count: 0, errors: 0, totalMs: 0, maxMs: 0, samples: [] };
    timing.count++; timing.errors += Number(isError); timing.totalMs += duration; timing.maxMs = Math.max(timing.maxMs, duration);
    timing.samples.push(duration); if (timing.samples.length > TOOL_SAMPLES) timing.samples.shift();
    this.tools.set(key, timing);
  }
  snapshot() {
    return Object.fromEntries([...this.tools].sort(([, a], [, b]) => b.totalMs - a.totalMs).map(([name, t]) => {
      const sorted = [...t.samples].sort((a, b) => a - b);
      return [name, { count: t.count, errors: t.errors, totalMs: round(t.totalMs), avgMs: round(t.totalMs / t.count), p50Ms: round(rank(sorted, 0.5)),
        p90Ms: round(rank(sorted, 0.9)), maxMs: round(t.maxMs) }];
    }));
  }
}
/** In-memory bounded numeric aggregates only; raw prompts, tool args, outputs and errors never enter telemetry. */
export class PerformanceMetrics {
  private readonly stages: Partial<Record<Stage, Timing>> = {};
  private readonly tools = new ToolTimings();
  private prefix?: string;
  private payload = { enabled: false, calls: 0, bytes: 0, maxBytes: 0, measurementFailures: 0 };
  measurePayload(enabled: boolean) { this.payload.enabled = enabled; }
  providerPayload(value: unknown) {
    if (!this.payload.enabled) return;
    try {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const bytes = Buffer.byteLength(text ?? '');
      this.payload = { ...this.payload, calls: this.payload.calls + 1, bytes, maxBytes: Math.max(this.payload.maxBytes, bytes) };
    } catch { this.payload.measurementFailures++; }
  }
  private request = { calls: 0, estimatedTokens: 0, systemBytes: 0, toolSchemaBytes: 0, instructionBytes: 0, skillCatalogueBytes: 0, prefixChanges: 0 };
  record(stage: Stage, duration: number) {
    if (!Number.isFinite(duration) || duration < 0) return;
    const old = this.stages[stage] ?? { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
    this.stages[stage] = { count: old.count + 1, totalMs: old.totalMs + duration, maxMs: Math.max(old.maxMs, duration), lastMs: duration };
  }
  /** One tool execution, from Pi's start to its end event: the tool's own time, without the model's. */
  recordTool(name: string, duration: number, isError = false) {
    if (!Number.isFinite(duration) || duration < 0) return;
    this.record('tool', duration);
    this.tools.record(name, duration, isError);
  }
  context(messages: readonly AgentMessage[]) {
    let systemBytes = 0, toolSchemaBytes = 0, instructionBytes = 0, skillCatalogueBytes = 0;
    const prefix: string[] = [];
    for (const [index, message] of messages.entries()) if (message.role === 'system') {
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      const sections = message.sections ?? {};
      // The cached prefix is the leading system message; later ones are changes sent after it.
      if (index === 0) prefix.push(JSON.stringify([text, sections, message.toolsAdded, message.toolsRemoved]));
      systemBytes += Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(sections));
      if (message.toolsAdded?.length) toolSchemaBytes += Buffer.byteLength(JSON.stringify(message.toolsAdded));
      // Main OptChat flattens Pi's sections; account for tagged instructions/catalogues there too.
      for (const match of text.matchAll(/<(instructions|project_context|skills|available_skills)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
        if (match[1].includes('skill')) skillCatalogueBytes += Buffer.byteLength(match[2]);
        else instructionBytes += Buffer.byteLength(match[2]);
      }
      for (const [name, content] of Object.entries(sections)) {
        if (/instruction|context|project/.test(name)) instructionBytes += Buffer.byteLength(content ?? '');
        if (/skill/.test(name)) skillCatalogueBytes += Buffer.byteLength(content ?? '');
      }
    }
    const digest = createHash('sha256').update(prefix.join('\n')).digest('hex');
    const changed = this.prefix !== undefined && this.prefix !== digest ? 1 : 0; this.prefix = digest;
    this.request = { calls: this.request.calls + 1, estimatedTokens: estimatedContextTokens(messages), systemBytes, toolSchemaBytes,
      instructionBytes, skillCatalogueBytes, prefixChanges: this.request.prefixChanges + changed };
  }
  snapshot() { return { stages: structuredClone(this.stages), tools: this.tools.snapshot(), request: { ...this.request }, payload: { ...this.payload } }; }
}
/** Real hook boundaries, not provider inference time or end-to-end speed claims. */
export function registerPerformance(pi: ExtensionAPI, metrics: () => PerformanceMetrics | undefined,
  onLatency?: (messageTimestamp: number, latency: { firstMs?: number; responseMs: number }) => void) {
  const tools = new Map<string, { name: string; start: number }>();
  let request: number | undefined, first = false, firstMs: number | undefined;
  pi.on('tool_execution_start', event => { if (metrics()) tools.set(event.toolCallId, { name: event.toolName ?? 'unknown', start: performance.now() }); });
  pi.on('tool_execution_end', event => {
    const started = tools.get(event.toolCallId); tools.delete(event.toolCallId);
    if (started) metrics()?.recordTool(started.name, performance.now() - started.start, event.isError === true);
  });
  pi.on('before_provider_request', event => {
    const current = metrics();
    if (current) { current.providerPayload(event.payload); request = performance.now(); first = false; firstMs = undefined; }
    return event.payload;
  });
  pi.on('after_provider_response', () => { if (request !== undefined) metrics()?.record('provider_headers', performance.now() - request); });
  pi.on('message_update', event => {
    if (request === undefined || first || event.message.role !== 'assistant') return;
    if (!event.message.content.some(block => block.type === 'text' && block.text.length || block.type === 'thinking' && block.thinking.length || block.type === 'toolCall')) return;
    firstMs = performance.now() - request;
    metrics()?.record('first_content', firstMs); first = true;
  });
  pi.on('message_end', event => {
    if (request !== undefined && event.message.role === 'assistant') {
      const responseMs = performance.now() - request;
      metrics()?.record('response', responseMs); request = undefined;
      onLatency?.(event.message.timestamp, { ...(firstMs === undefined ? {} : { firstMs }), responseMs });
    }
  });
  pi.on('agent_settled', () => { tools.clear(); request = undefined; });
}
export const performanceTool = (metrics: () => PerformanceMetrics, outputs: () => object) => ({
  name: 'context_metrics', label: 'Context performance', exposure: 'deferred' as const, annotations: { readOnlyHint: true },
  description: 'Numeric local stage/per-tool timings, tool error counts and latest request size estimates for this session. No raw prompts/output. Not provider billing or proof of task success.',
  parameters: Type.Object({}, { additionalProperties: false }),
  async execute() { return { content: [{ type: 'text' as const, text: JSON.stringify({ ...metrics().snapshot(), output: outputs() }, null, 2) }], details: {} }; },
});
