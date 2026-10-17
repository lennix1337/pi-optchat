import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Api, AssistantMessageEvent, Context, Model } from '@earendil-works/pi-ai';
import type { ContainerAgentConfig } from './optchat-container-agent.ts';
import { jsonLines, wireOptions, type BridgeRequest, type WireOptions } from './optchat-model-bridge.ts';

export type ModelForwarder = (context: Context, options: WireOptions & { signal: AbortSignal; sessionId: string }) => AsyncIterable<AssistantMessageEvent>;

/** Host executes only the supplied Docker command. Model tool calls are never dispatched here. */
export async function runTransport(command: string, args: string[], config: ContainerAgentConfig, forward: ModelForwarder, timeoutMs = 120_000) {
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const seed = randomUUID();
  const active = new Map<number, AbortController>();
  const forwarding = new Set<Promise<void>>();
  const requests: { id: number; started: number; durationMs?: number; usage?: unknown; stopReason?: string; canceled?: boolean }[] = [];
  const seen = new Set<number>();
  const canceled = new Set<number>();
  let result: unknown;
  type Ready = { bound: boolean; tools: string[]; provider: string; model: string; thinking: string };
  let ready: Ready | undefined;
  let failure: Error | undefined;
  let providerFailure: 'quota' | 'policy' | 'other' | undefined;
  let stderrBytes = 0;
  child.stderr.on('data', data => { stderrBytes += data.length; });
  const send = (value: unknown) => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(value)}\n`); };
  const fail = (reason: string) => {
    failure ??= new Error(reason);
    for (const controller of active.values()) controller.abort();
    child.stdin.destroy();
    child.kill();
  };
  child.stdin.on('error', () => fail('Container input pipe closed.'));
  const deadline = setTimeout(() => fail('Container task timed out; no retry.'), timeoutMs);
  const lines = jsonLines(child.stdout, message => {
    const value = message as { kind: string; id: number; context?: Context };
    if (value.kind === 'ready' && !ready) {
      const evidence = message as Ready;
      if (!evidence?.bound || evidence.provider !== config.model.provider || evidence.model !== config.model.id || evidence.thinking !== config.thinking
        || !Array.isArray(evidence.tools) || !['zoom', 'output_read', 'shell_start'].every(name => evidence.tools.includes(name))) {
        fail('Container did not activate real OptChat.'); return;
      }
      ready = evidence;
    } else if (value.kind === 'request' && ready && !result) {
      if (!Number.isSafeInteger(value.id) || value.id <= 0 || seen.has(value.id) || seen.size >= 64 || !Array.isArray(value.context?.messages)) {
        fail('Invalid or replayed model request.'); return;
      }
      seen.add(value.id);
      const request = message as BridgeRequest;
      const controller = new AbortController();
      active.set(request.id, controller);
      const record: typeof requests[number] = { id: request.id, started: Date.now() };
      requests.push(record);
      const responseDeadline = setTimeout(() => { controller.abort(); fail('Model response exceeded 60 seconds; no retry.'); }, 60_000);
      const forwarded = (async () => {
        try {
          const sessionId = createHash('sha256').update(`${seed}:${request.sessionId ?? 'main'}`).digest('hex');
          let terminal = false;
          for await (const event of forward(request.context, { ...wireOptions(request.options), signal: controller.signal, sessionId })) {
            if (controller.signal.aborted) throw new Error('Aborted');
            // Provider error diagnostics may contain request information. Never send raw errors into the container.
            if (event.type === 'error') {
              const detail = event.error.errorMessage ?? '';
              providerFailure = /usage policy|policy.?refus|blocked by provider/i.test(detail) ? 'policy' : /quota|usage limit|rate.?limit|429|credits/i.test(detail) ? 'quota' : 'other';
              send({ kind: 'failure', id: request.id }); fail(`Model returned ${providerFailure} error; no retry.`); return;
            }
            send({ kind: 'event', id: request.id, event });
            if (event.type === 'done') {
              terminal = true;
              record.usage = event.message.usage; record.stopReason = event.message.stopReason;
            }
          }
          if (!terminal && !canceled.has(request.id)) fail('Model stream ended without a final response.');
        } catch {
          if (!canceled.has(request.id)) { send({ kind: 'failure', id: request.id }); fail('Model transport failed; no retry.'); }
        }
        finally { clearTimeout(responseDeadline); record.durationMs = Date.now() - record.started; active.delete(request.id); }
      })();
      forwarding.add(forwarded);
      void forwarded.finally(() => forwarding.delete(forwarded));
    } else if (value.kind === 'cancel') {
      canceled.add(value.id);
      const record = requests.find(request => request.id === value.id);
      if (record) { record.canceled = true; record.stopReason = 'aborted'; }
      active.get(value.id)?.abort();
    } else if (value.kind === 'result' && ready && !result) {
      result = message;
    } else fail('Unexpected container protocol message.');
  }, () => fail('Invalid JSON on container protocol.'));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(new Error('Could not launch container transport.')));
      child.once('close', code => {
        if (failure) reject(failure);
        else if (code !== 0 || !ready || !result) reject(new Error(`Container failed acceptance (exit ${code}; stderr ${stderrBytes} bytes).`));
        else resolve();
      });
      // Only public model metadata is sent. Provider auth/header configuration never crosses the pipe.
      const m = config.model;
      const publicModel: Model<Api> = { id: m.id, name: m.name, api: m.api, provider: m.provider, baseUrl: 'https://invalid.local',
        reasoning: m.reasoning, input: m.input, cost: m.cost, contextWindow: m.contextWindow, maxTokens: m.maxTokens };
      send({ ...config, model: publicModel });
    });
    return { ready, result, requests, stderrBytes };
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error('Container transport failed.'), {
      evidence: { ready, result, requests, stderrBytes, providerFailure, failureReason: failure?.message },
    });
  } finally {
    clearTimeout(deadline); lines.close();
    for (const controller of active.values()) controller.abort();
    child.stdin.destroy();
    if (child.exitCode === null) child.kill();
    let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...forwarding]),
        new Promise<never>((_, reject) => { shutdownTimer = setTimeout(() => reject(new Error('Model cancellation not observed; do not retry.')), 5000); }),
      ]);
    } finally { clearTimeout(shutdownTimer); }
  }
}
