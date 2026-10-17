import { hash as sha256 } from 'node:crypto';

export interface CacheUsage { input: number; cacheRead: number; output: number; }

export const LEAN_CONTAINER_INSTRUCTIONS = 'You are an expert coding assistant fixing the reported issue in /testbed. Use only container_exec to inspect files, edit code and run commands inside the isolated repository. No host paths or network are available. Make a minimal correct change, preserve unrelated behavior, run focused tests and inspect the final diff. Finish with a concise summary of the change and actual test results. Do not repeat yourself or dump large files.';

/** Experimental run safeguard, not a provider token cap; tool execution is not timed here. */
export class ResponseBudget {
  exceeded = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private readonly milliseconds: number, private readonly abort: () => void) {
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error('Invalid response budget.');
  }
  begin(): void {
    if (this.exceeded) throw new Error('Response budget exceeded; no further requests allowed.');
    this.dispose();
    this.timer = setTimeout(() => { this.exceeded = true; this.abort(); }, this.milliseconds);
  }
  complete(): void { this.dispose(); }
  dispose(): void { clearTimeout(this.timer); this.timer = undefined; }
}

const hash = (value: unknown): string => sha256('sha256', JSON.stringify(value) ?? 'undefined');

/** Hash-only evidence: never persist prompts, tool output, credentials or cache keys. */
export class BenchmarkCacheTrace {
  readonly requests: Array<{
    instructionsHash: string; toolsHash: string; cacheKeyHash: string | null;
    inputItems: number; commonPrefixItems: number; previousInputItems: number;
    payloadToMessageEndMs?: number; firstDeltaMs?: number;
    firstDeltaKind?: 'text_delta' | 'thinking_delta' | 'toolcall_delta'; usage?: CacheUsage;
  }> = [];
  private previous: string[] = [];
  private readonly startedAt = new WeakMap<object, number>();

  request(payload: unknown, now = performance.now()): number | undefined {
    if (!payload || typeof payload !== 'object') return;
    const body = payload as Record<string, unknown>;
    const items = Array.isArray(body.input) ? body.input.map(hash) : [];
    let commonPrefixItems = 0;
    while (commonPrefixItems < Math.min(items.length, this.previous.length) && items[commonPrefixItems] === this.previous[commonPrefixItems]) commonPrefixItems++;
    const request = { instructionsHash: hash(body.instructions), toolsHash: hash(body.tools),
      cacheKeyHash: typeof body.prompt_cache_key === 'string' ? hash(body.prompt_cache_key) : null,
      inputItems: items.length, commonPrefixItems, previousInputItems: this.previous.length };
    this.requests.push(request);
    this.previous = items;
    this.startedAt.set(request, now);
    return this.requests.length - 1;
  }

  delta(kind: string, content: string, now = performance.now(), requestIndex = this.requests.length - 1): void {
    const current = this.requests[requestIndex];
    if (!current || current.usage || current.firstDeltaMs !== undefined || !content) return;
    if (kind !== 'text_delta' && kind !== 'thinking_delta' && kind !== 'toolcall_delta') return;
    current.firstDeltaMs = Math.max(0, now - this.startedAt.get(current)!);
    current.firstDeltaKind = kind;
  }

  complete(usage: CacheUsage, now = performance.now(), requestIndex = this.requests.length - 1): void {
    const current = this.requests[requestIndex];
    if (!current || current.usage) return;
    current.payloadToMessageEndMs = Math.max(0, now - this.startedAt.get(current)!);
    current.usage = { input: usage.input, cacheRead: usage.cacheRead, output: usage.output };
  }
}

export function summarizeCache(tasks: Array<{ taskId: string; providerEvidence: { usage: CacheUsage[] } }>) {
  let input = 0, cached = 0, firstInput = 0, zeroCacheAfterFirst = 0, calls = 0;
  const perTask = tasks.map(task => {
    let taskInput = 0, taskCached = 0;
    task.providerEvidence.usage.forEach((usage, index) => {
      taskInput += usage.input; taskCached += usage.cacheRead; calls++;
      if (index === 0) firstInput += usage.input;
      else if (usage.cacheRead === 0) zeroCacheAfterFirst++;
    });
    input += taskInput; cached += taskCached;
    return { taskId: task.taskId, calls: task.providerEvidence.usage.length,
      input: taskInput, cached: taskCached, cacheHitPercent: taskInput + taskCached ? 100 * taskCached / (taskInput + taskCached) : 0 };
  });
  return { tasks: tasks.length, calls, input, cached, cacheHitPercent: input + cached ? 100 * cached / (input + cached) : 0,
    firstInput, zeroCacheAfterFirst, perTask };
}
