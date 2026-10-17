import { createInterface } from 'node:readline';
import { createAssistantMessageEventStream, type Api, type AssistantMessageEvent, type Context, type Model, type SimpleStreamOptions } from '@earendil-works/pi-ai';

export type WireOptions = Pick<SimpleStreamOptions, 'reasoning' | 'maxTokens' | 'cacheRetention' | 'toolChoice' | 'temperature' | 'thinkingBudgets' | 'transport'>;
export function wireOptions(options: SimpleStreamOptions = {}): WireOptions {
  const { reasoning, maxTokens, cacheRetention, toolChoice, temperature, thinkingBudgets, transport } = options;
  return { reasoning, maxTokens, cacheRetention, toolChoice, temperature, thinkingBudgets, transport };
}
export type BridgeRequest = { kind: 'request'; id: number; context: Context; sessionId?: string; options?: WireOptions };
export type BridgeReply = { kind: 'event'; id: number; event: AssistantMessageEvent } | { kind: 'failure'; id: number };

/** Only model requests cross the pipe. No credentials, filesystem operations or host tool execution. */
export class ContainerModelBridge {
  private nextId = 0;
  private closed = false;
  private pending = new Map<number, { stream: ReturnType<typeof createAssistantMessageEventStream>; failure: () => void }>();
  constructor(private send: (request: BridgeRequest | { kind: 'cancel'; id: number }) => void) {}
  stream(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
    const stream = createAssistantMessageEventStream();
    const id = ++this.nextId;
    const failure = () => {
      this.pending.delete(id);
      stream.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], api: model.api,
        provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'error', errorMessage: 'Model bridge stopped; no automatic retry.',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
      stream.end();
    };
    const abort = () => { this.send({ kind: 'cancel', id }); failure(); };
    this.pending.set(id, { stream, failure });
    if (this.closed || options?.signal?.aborted) { failure(); return stream; }
    options?.signal?.addEventListener('abort', abort, { once: true });
    void stream.result().finally(() => options?.signal?.removeEventListener('abort', abort));
    this.send({ kind: 'request', id, context, sessionId: options?.sessionId, options: wireOptions(options) });
    return stream;
  }
  receive(reply: BridgeReply) {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    const { stream, failure } = pending;
    if (reply.kind === 'failure') { failure(); return; }
    stream.push(reply.event);
    if (reply.event.type === 'done' || reply.event.type === 'error') {
      this.pending.delete(reply.id);
      stream.end();
    }
  }
  close() {
    this.closed = true;
    for (const { failure } of this.pending.values()) failure();
  }
}

export function jsonLines(input: NodeJS.ReadableStream, receive: (message: unknown) => void, failed: (error: unknown) => void) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', line => {
    try { receive(JSON.parse(line)); } catch (error) { failed(error); }
  });
  return lines;
}
