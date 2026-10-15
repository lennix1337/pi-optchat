import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';

const root = join(tmpdir(), `oc-recovery-runtime-${process.pid}-${Date.now()}`);
const previousHome = process.env.OPTCHAT_HOME;
const previousPiDir = process.env.PI_CODING_AGENT_DIR;
process.env.OPTCHAT_HOME = join(root, 'home');
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
const PROFILE = 'recovery-runtime';
const interruptedSource = 'Run one synthetic effect, then hold until the test interrupts you.';
const recoveryRootId = '5a4d4950-bd26-4cca-8742-c12ec3f7a8bd';
const externalState = { effects: 0 };
const externalFile = join(root, 'external-state.json');
const effectJournalStatuses: string[] = [];
let effectExecutions = 0;
let recoveryEventsEmitted = 0;
let compactionRequestsAfterRecovery = 0;
let remoteReadExecutions = 0;
let destructiveExecutions = 0;
let effectStarted!: () => void;
const effectStartedPromise = new Promise<void>(resolve => { effectStarted = resolve; });

function operationFile() { return join(profilePath(PROFILE), 'operations.json'); }
function savedOperations(): { id: string; tool: string; status: string; error?: boolean; evidence?: string; recoveryIncidentId?: string }[] {
  return JSON.parse(readFileSync(operationFile(), 'utf8')).operations;
}
function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
}
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5000); }),
  ]).finally(() => clearTimeout(timer));
}

const recoveryTools: ExtensionFactory = pi => {
  pi.registerTool({
    name: 'write_effect', label: 'Synthetic external write', description: 'Write to the synthetic external system.',
    parameters: Type.Object({ mode: Type.String() }),
    async execute(_id, { mode }, signal) {
      effectExecutions++;
      effectJournalStatuses.push(savedOperations().at(-1)?.status ?? 'missing');
      externalState.effects++;
      mkdirSync(root, { recursive: true });
      writeFileSync(externalFile, JSON.stringify(externalState));
      if (mode === 'interrupt') {
        effectStarted();
        if (!signal) throw new Error('Pi did not supply the active tool abort signal');
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error('Synthetic interruption after external effect'));
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      }
      return { content: [{ type: 'text', text: JSON.stringify(externalState) }], details: {} };
    },
  });
  pi.registerTool({
    name: 'remote_read', label: 'Synthetic remote read', description: 'Read the synthetic external system without changing it.',
    annotations: { readOnlyHint: true }, parameters: Type.Object({}),
    async execute() {
      remoteReadExecutions++;
      pi.events.emit('optchat:recovery', { incidentId: recoveryRootId, phase: 'started', category: 'transient', provider: 'fixture', model: 'fixture' });
      recoveryEventsEmitted++;
      return { content: [{ type: 'text', text: JSON.stringify(externalState) }], details: {} };
    },
  });
  // Deliberately unannotated: a model-supplied readOnlyHint must never classify this as safe.
  pi.registerTool({
    name: 'destructive_unannotated', label: 'Unannotated destructive action', description: 'A synthetic effectful operation.',
    parameters: Type.Object({ readOnlyHint: Type.Optional(Type.Boolean()) }),
    async execute() {
      destructiveExecutions++;
      return { content: [{ type: 'text', text: 'destructive operation ran' }], details: {} };
    },
  });
};

test('Pi runtime journals before effects, preserves interrupted outcomes, allows trusted read-only observation, and resumes only after evidence', async () => {
  mkdirSync(root, { recursive: true });
  createProfile(PROFILE);
  saveConfig(profilePath(PROFILE), {
    ...loadConfig(profilePath(PROFILE)),
    compactor: { provider: 'fixture', model: 'fixture', thinking: 'off' },
    subagent: { provider: 'fixture', model: 'fixture', thinking: 'off' },
  });

  let recoveryRequests = 0;
  let recoveryContext = '';
  let recoveryOperationalContext = '';
  const sessions: { close: () => Promise<void>; prompt: (text: string) => Promise<void>; messages: () => AgentMessage[] }[] = [];
  const newSession = async (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
    runtime.registerProvider('fixture', {
      baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const messages = context.messages as AgentMessage[];
        let content: AssistantMessage['content'];
        let stopReason: AssistantMessage['stopReason'];
        const compactionRequest = messages.some(message => {
          if (message.role !== 'user') return false;
          const text = typeof message.content === 'string' ? message.content
            : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
          return text.includes('Compaction:');
        });
        if (compactionRequest) {
          if (recoveryEventsEmitted > 0) compactionRequestsAfterRecovery++;
          content = [{ type: 'text', text: 'Synthetic memory summary.' }];
          stopReason = 'stop';
        } else if (name === 'interrupted') {
          const calls = messages.filter(message => message.role === 'assistant' && message.content.some(part => part.type === 'toolCall')).length;
          content = calls === 0 ? [{ type: 'toolCall', id: 'spawn-1', name: 'write_effect', arguments: { mode: 'interrupt' } }] : [{ type: 'text', text: 'Stopped.' }];
          stopReason = calls === 0 ? 'toolUse' : 'stop';
        } else {
          if (recoveryRequests === 0) recoveryContext = JSON.stringify(messages);
          const request = recoveryRequests++;
          const readResult = [...messages].reverse().find(message => message.role === 'toolResult' && message.toolName === 'remote_read');
          const observation = readResult && readResult.role === 'toolResult' ? textContent(readResult.content) : 'remote observation missing';
          const nextCalls: Array<{ name: string; args: JsonObject }> = [
            { name: 'write_effect', args: { mode: 'blocked-replay' } },
            { name: 'remote_read', args: {} },
            { name: 'operation_state', args: {} },
            { name: 'operational_state', args: { update: { kind: 'authorization', text: 'A nonexistent source must not be accepted.', sourceMessageId: '999999' } } },
            { name: 'operational_state', args: { update: { kind: 'authorization', text: 'A tool-call source is not direct user authorization.', sourceMessageId: '1' } } },
            { name: 'operational_state', args: { update: { kind: 'authorization', text: 'A source reference cannot authorize using a substring.', sourceMessageId: '0' } } },
            { name: 'operational_state', args: { update: { kind: 'constraint', text: interruptedSource, sourceMessageId: '0', evidence: [{ kind: 'self-reported', ref: 'original user message 0' }] } } },
            { name: 'write_effect', args: { mode: 'blocked-after-constraint-record' } },
            { name: 'destructive_unannotated', args: { readOnlyHint: true } },
            { name: 'operation_state', args: { id: 'op_not_a_pending_operation', evidence: 'synthetic negative lookup' } },
            { name: 'operation_state', args: { id: savedOperations()[0]!.id, evidence: `remote_read observed ${observation}` } },
            { name: 'operational_state', args: {} },
            { name: 'write_effect', args: { mode: 'retry-after-evidence' } },
            { name: 'write_effect', args: { mode: 'same-call-id-in-new-turn' } },
          ];
          const next = nextCalls[request];
          if (request === 7) recoveryOperationalContext = JSON.stringify(messages);
          const id = request === 0 || request === 12 || request === 13 ? 'spawn-1' : `recovery-${request}`;
          content = next ? [{ type: 'toolCall', id, name: next.name, arguments: next.args }] : [{ type: 'text', text: 'Recovered.' }];
          stopReason = next ? 'toolUse' : 'stop';
        }
        const message: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), stopReason, usage: emptyUsage() };
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => { stream.push({ type: 'done', reason: stopReason, message }); stream.end(); });
        return stream;
      },
    });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, 'agent'), settingsManager, noExtensions: true,
      noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat, recoveryTools] });
    await loader.reload();
    const manager = SessionManager.create(dir, join(dir, 'sessions'));
    const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader,
      settingsManager, sessionManager: manager, tools: ['write_effect', 'remote_read', 'destructive_unannotated', 'operation_state', 'operational_state'] });
    session.extensionRunner.setFlagValue('optchat-profile', PROFILE);
    await session.bindExtensions({ mode: 'print', onError: error => { throw new Error(error.error); } });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
    };
    const entry = { close, prompt: (text: string) => session.prompt(text), messages: () => session.state.messages as AgentMessage[] };
    sessions.push(entry);
    return entry;
  };

  try {
    const first = await newSession('interrupted');
    const interruptedPrompt = first.prompt(interruptedSource).catch(() => undefined);
    await withTimeout(effectStartedPromise, 'the initial external effect');
    assert.deepEqual(effectJournalStatuses, ['started'], 'the durable operation intent exists before the external side effect runs');
    await first.close();
    await withTimeout(interruptedPrompt, 'the interrupted Pi run');

    const unresolved = savedOperations();
    assert.equal(effectExecutions, 1, 'the first external effect actually ran');
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0]!.status, 'started', 'interrupting before a response leaves the intent unresolved');
    assert.equal(unresolved[0]!.error, undefined);

    const resumed = await newSession('resumed');
    await resumed.prompt('Recover conservatively: observe first, reconcile with evidence, then retry.');
    for (let i = 0; i < 8; i++) await resumed.prompt(`Post-recovery compaction probe ${i}: ${'synthetic source '.repeat(40)}`);
    // The next turn waits for the eighth probe's real memory summary to settle before its provider request.
    await resumed.prompt('Finish the synthetic compaction probe; no tools needed.');

    assert.match(recoveryContext, /Operational recovery \(not an authorization\): 1 tool outcomes uncertain/,
      'the reopened Pi request receives the journal recovery guidance');
    assert.equal(effectExecutions, 3, 'the interrupted effect was not replayed; two new calls ran only after evidence resolution');
    assert.equal(recoveryEventsEmitted, 1, 'the fixture emitted its recovery event from the actual read-only tool execution');
    assert.ok(compactionRequestsAfterRecovery >= 8, 'eight real compactor requests were made after the recovery event');
    assert.deepEqual(effectJournalStatuses, ['started', 'started', 'started'], 'every effect began only after its intent was durable');
    assert.equal(remoteReadExecutions, 1, 'the trusted installed read-only tool executed while the journal was uncertain');
    assert.equal(destructiveExecutions, 0, 'the unannotated tool stayed blocked despite a model-supplied readOnlyHint');
    assert.match(recoveryOperationalContext, /Operational state \(records; no authority; implementation != verification\)/,
      'the next real model request receives the operational-state context');
    assert.ok(recoveryOperationalContext.includes(interruptedSource));

    const results = resumed.messages().filter(message => message.role === 'toolResult');
    const remoteReadResult = results.find(message => message.role === 'toolResult' && message.toolName === 'remote_read');
    assert.ok(remoteReadResult && remoteReadResult.role === 'toolResult' && !remoteReadResult.isError);
    assert.match(textContent(remoteReadResult.content), /"effects":1/, 'the read-only observation saw the completed first effect');
    const destructiveResult = results.find(message => message.role === 'toolResult' && message.toolName === 'destructive_unannotated');
    assert.ok(destructiveResult && destructiveResult.role === 'toolResult' && destructiveResult.isError, 'the unannotated operation was blocked by the journal');
    const stateResults = results.filter(message => message.role === 'toolResult' && message.toolName === 'operation_state');
    assert.deepEqual(stateResults.map(message => message.role === 'toolResult' && message.isError), [false, true, false],
      'inspection works, an invalid resolution fails, and the evidence-backed resolution succeeds');
    const operationalResults = results.filter(message => message.role === 'toolResult' && message.toolName === 'operational_state');
    assert.deepEqual(operationalResults.map(message => message.role === 'toolResult' && message.isError), [true, true, true, false, false],
      'missing, non-user, and partial-quote sources are rejected; an exact-source update and later inspection succeed');
    assert.match(textContent(operationalResults[0]!.role === 'toolResult' ? operationalResults[0]!.content : []), /original message in this profile/);
    assert.match(textContent(operationalResults[1]!.role === 'toolResult' ? operationalResults[1]!.content : []), /direct non-imported user/);
    assert.match(textContent(operationalResults[2]!.role === 'toolResult' ? operationalResults[2]!.content : []), /entire user source/);
    const operationalState = JSON.parse(readFileSync(join(profilePath(PROFILE), 'operational-state.json'), 'utf8'));
    assert.equal(operationalState.entries.length, 1, 'rejected updates are not persisted');
    assert.equal(operationalState.entries[0].kind, 'constraint');
    assert.equal(operationalState.entries[0].sourceMessageId, '0');
    assert.equal(operationalState.entries[0].text, interruptedSource, 'constraints quote the full original source verbatim');

    const final = savedOperations();
    assert.equal(final.length, 3, 'read-only calls and failures are excluded from the operation journal');
    assert.equal(final[0]!.status, 'reconciled');
    assert.match(final[0]!.evidence ?? '', /remote_read observed .*"effects":1/);
    assert.equal(final[1]!.tool, 'write_effect');
    assert.equal(final[1]!.status, 'response_recorded');
    assert.equal(final[1]!.error, false);
    assert.equal(final[2]!.tool, 'write_effect');
    assert.equal(final[2]!.status, 'response_recorded');
    assert.equal(final[2]!.error, false);
    assert.equal(final[1]!.recoveryIncidentId, recoveryRootId);
    assert.equal(final[2]!.recoveryIncidentId, recoveryRootId);
    assert.equal(final[1]!.id.split(':').at(-1), 'spawn-1');
    assert.equal(final[2]!.id.split(':').at(-1), 'spawn-1');
    assert.notEqual(final[1]!.id, final[2]!.id, 'the same provider tool-call ID in distinct turns gets distinct journal identities');
    assert.equal(new Set(final.map(operation => operation.id)).size, 3);

    const recoveryEvents = readJsonl(join(profilePath(PROFILE), 'recovery-diagnostics.jsonl'));
    const recoveryEvent = recoveryEvents.find(event => event.kind === 'recovery' && event.incidentId === recoveryRootId);
    assert.ok(recoveryEvent, 'the subscribed parent extension persisted the recovery event');
    assert.equal(typeof recoveryEvent.sessionId, 'string', 'the event emitter may omit sessionId; the parent supplies it');
    const sessionId = recoveryEvent.sessionId as string;
    assert.ok(final[1]!.id.startsWith(`${sessionId}:`));
    assert.ok(final[2]!.id.startsWith(`${sessionId}:`));

    const compactorDiagnostics = readJsonl(join(profilePath(PROFILE), 'compactor-diagnostics.jsonl'));
    const sessionCompactions = compactorDiagnostics.filter(item => item.sessionId === sessionId && item.kind === 'compaction');
    assert.ok(sessionCompactions.length >= 8, `expected at least eight compactor snapshots for the resumed session, got ${sessionCompactions.length}`);
    assert.ok(sessionCompactions.slice(-8).every(item => item.recoveryIncidentId === recoveryRootId),
      'the eighth and subsequent post-event compactor snapshots retain the recovery root ID');

    const usageEntries = readJsonl(join(profilePath(PROFILE), 'usage.jsonl'));
    assert.ok(usageEntries.some(item => item.session === sessionId && item.kind === 'compaction' && item.recoveryIncidentId === recoveryRootId),
      'the usage ledger forwards the root recovery ID with the resumed session attribution');
  } finally {
    for (const session of sessions.reverse()) await session.close();
    rmSync(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = previousHome;
    if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousPiDir;
  }
});
