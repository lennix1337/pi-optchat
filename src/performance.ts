import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { estimatedContextTokens } from './run-context.ts';

export type Stage = 'context' | 'projection' | 'tool' | 'provider_headers' | 'first_content' | 'response' | 'persistence' | 'settle' | 'child_open' | 'compaction';
interface Timing { count: number; totalMs: number; maxMs: number; lastMs: number }
/** In-memory bounded numeric aggregates only; raw prompts, tool args, outputs and errors never enter telemetry. */
export class PerformanceMetrics {
  private readonly stages: Partial<Record<Stage, Timing>> = {};
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
  context(messages: readonly AgentMessage[]) {
    let systemBytes = 0, toolSchemaBytes = 0, instructionBytes = 0, skillCatalogueBytes = 0;
    const prefix: string[] = [];
    for (const message of messages) if (message.role === 'system') {
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      const sections = message.sections ?? {};
      const stable = JSON.stringify([text, sections, message.toolsAdded, message.toolsRemoved]); prefix.push(stable);
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
  snapshot() { return { stages: structuredClone(this.stages), request: { ...this.request }, payload: { ...this.payload } }; }
}
/** Real hook boundaries, not provider inference time or end-to-end speed claims. */
export function registerPerformance(pi: ExtensionAPI, metrics: () => PerformanceMetrics | undefined) {
  const tools = new Map<string, number>();
  let request: number | undefined, first = false;
  pi.on('tool_execution_start', event => { if (metrics()) tools.set(event.toolCallId, performance.now()); });
  pi.on('tool_execution_end', event => {
    const start = tools.get(event.toolCallId); tools.delete(event.toolCallId);
    if (start !== undefined) metrics()?.record('tool', performance.now() - start);
  });
  pi.on('before_provider_request', event => {
    const current = metrics();
    if (current) { current.providerPayload(event.payload); request = performance.now(); first = false; }
    return event.payload;
  });
  pi.on('after_provider_response', () => { if (request !== undefined) metrics()?.record('provider_headers', performance.now() - request); });
  pi.on('message_update', event => {
    if (request === undefined || first || event.message.role !== 'assistant') return;
    if (!event.message.content.some(block => block.type === 'text' && block.text.length || block.type === 'thinking' && block.thinking.length || block.type === 'toolCall')) return;
    metrics()?.record('first_content', performance.now() - request); first = true;
  });
  pi.on('message_end', event => {
    if (request !== undefined && event.message.role === 'assistant') {
      metrics()?.record('response', performance.now() - request); request = undefined;
    }
  });
  pi.on('agent_settled', () => { tools.clear(); request = undefined; });
}
export const performanceTool = (metrics: () => PerformanceMetrics, outputs: () => object) => ({
  name: 'context_metrics', label: 'Context performance', exposure: 'deferred' as const, annotations: { readOnlyHint: true },
  description: 'Numeric local stage timings and latest request size estimates for this session. No raw prompts/output. Not provider billing or proof of task success.',
  parameters: Type.Object({}),
  async execute() { return { content: [{ type: 'text' as const, text: JSON.stringify({ ...metrics().snapshot(), output: outputs() }, null, 2) }], details: {} }; },
});
