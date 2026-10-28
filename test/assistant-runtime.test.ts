import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import * as pinnedPi from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { Memory } from '../src/memory.ts';
import { TaskStore } from '../assistant/src/store/db.ts';
import { createAssistantServer } from '../assistant/src/http/server.ts';
import { removeDir } from './support.ts';
import { OperationJournal } from '../src/operations.ts';
import { RunHistory } from '../src/runs.ts';

const sdk: typeof pinnedPi = process.env.OPTCHAT_TEST_PI_ENTRY
  ? await import(pathToFileURL(process.env.OPTCHAT_TEST_PI_ENTRY).href) : pinnedPi;

test('native Pi command -> HTTP -> SQLite -> visible response and original survive reload and reopen', { timeout: 25000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-native-'));
  const profileId = 'assistant-native';
  createProfile(profileId);
  const profile = profilePath(profileId);
  saveConfig(profile, { ...loadConfig(profile), syncAiMemory: false, syncOptMem: false, syncStatus: false });
  const original = `Original source, not a fresh instruction.\n${'source detail '.repeat(650)}\nEND-ORIGINAL`;
  const memory = await Memory.open(profile, async () => 'Historical original source.');
  memory.append('user', original);
  await memory.settle(); // Persist the offline fixture summary before the real extension opens this memory.
  await memory.close();
  const dbPath = join(dir, 'tasks.sqlite');
  let store = new TaskStore(dbPath, profileId);
  let server = createAssistantServer({ store, profileId, token: 'disposable-native-token' });
  const listen = async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(profile, 'assistant.json'), JSON.stringify({ version: 1, profileId, endpoint, token: 'disposable-native-token' }));
    return endpoint;
  };
  let endpoint = await listen();
  const realFetch = globalThis.fetch;
  let requests = 0, inference = 0, inputCalls = 0;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    assert.ok(url.startsWith(`${endpoint}/`), 'only the disposable loopback server may receive requests');
    requests++;
    return realFetch(input, init);
  });
  const taskId = "task / SQL ' %";
  const encoded = encodeURIComponent(taskId);
  const context = (sourceEventId: string) => ({ sessionId: 'producer-session', channelId: 'producer-channel', runId: 'producer-run', sourceEventId, evidenceReference: `optchat:${profileId}:0` });
  const post = async (route: string, value: unknown, expected = 200) => {
    const response = await fetch(endpoint + route, { method: 'POST', headers: { authorization: 'Bearer disposable-native-token', 'content-type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, expected);
    return response.json();
  };
  const runtime = await sdk.ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', { baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'No inference', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple() { inference++; throw new Error('Assistant command must not request inference'); } });
  const settings = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager: settings,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, disabledBuiltinExtensions: ['mcp', 'codemode'], extensionFactories: [optchat] });
  const notices: string[] = [], errors: string[] = [];
  let onInput = async () => 'PRIVATE-NATIVE-ANSWER';
  let session: Awaited<ReturnType<typeof sdk.createAgentSession>>['session'] | undefined;
  try {
    await loader.reload();
    const manager = sdk.SessionManager.create(dir, join(dir, 'sessions'));
    manager.appendCustomEntry('optchat.profile', { name: profileId });
    const operationId = `${manager.getSessionId()}:local-intent`;
    const journal = new OperationJournal(profile);
    journal.start(manager.getSessionId(), 'local-intent', 'write', { content: 'PRIVATE-LOCAL-CANARY' });
    journal.settled(manager.getSessionId());
    const journalBeforeRead = readFileSync(join(profile, 'operations.json'), 'utf8');
    mkdirSync(join(profile, 'runs'), { recursive: true });
    new RunHistory(profile).save({ id: 'local-worker', task: 'PRIVATE-LOCAL-CANARY', cwd: dir, model: 'fixture', thinking: 'off', parentSession: manager.getSessionId(), started: 1, ended: 2, depth: 1, state: 'failed', report: 'PRIVATE-LOCAL-CANARY', guidance: [] });
    ({ session } = await sdk.createAgentSession({ cwd: dir, modelRuntime: runtime, model: runtime.getModel('fixture', 'fixture'), resourceLoader: loader, settingsManager: settings, sessionManager: manager, tools: [] }));
    await session.bindExtensions({ mode: 'print', onError: event => errors.push(event.error), uiContext: { ...session.extensionRunner!.getUIContext(), notify: text => notices.push(text) } });
    const command = async (args: string) => {
      const runner = session!.extensionRunner!;
      runner.setUIContext({ ...runner.getUIContext(), notify: text => notices.push(text), input: async () => { inputCalls++; return onInput(); } }, 'tui');
      const definition = runner.getCommand('assistant'); assert.ok(definition, 'real OptChat registration exposes the command');
      await definition.handler(args, runner.createCommandContext());
      return notices.at(-1)!;
    };
    await post('/v1/tasks', { task: { version: 1, profileId, taskId, title: 'Disposable journey', status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: 'create-source' }, context: context('create-source') });
    await post(`/v1/tasks/${encoded}/transition`, { expectedRevision: 1, nextStatus: 'working', context: context('working-source') });
    await post(`/v1/tasks/${encoded}/transition`, { expectedRevision: 2, nextStatus: 'needs_input', context: context('input-source') });
    const eventsBeforeRead = store.events();
    const local = await command('local');
    assert.ok(local.includes(operationId)); assert.match(local, /local-worker/);
    assert.match(local, /failed.*verification: not_verified/);
    assert.doesNotMatch(local, /PRIVATE-LOCAL-CANARY/);
    assert.equal(readFileSync(join(profile, 'operations.json'), 'utf8'), journalBeforeRead);
    assert.match(await command('list'), /Disposable journey/);
    assert.match(await command(`show ${encoded}`), /needs_input/);
    assert.match(await command(`evidence ${encoded}`), /Observed references, not verification/);
    assert.deepEqual(store.events(), eventsBeforeRead, 'reading commands cannot mutate tasks or consume approvals');
    assert.match(await command(`original ${encoded} 1`), /Original source, not a fresh instruction/);
    assert.match(notices.at(-1)!, /next page: offset 6000/);
    assert.match(await command(`original ${encoded} 1 6000`), /END-ORIGINAL/);
    await command(`respond ${encoded}`);
    assert.match(notices.at(-1)!, /recorded as data, not authorization/);
    assert.equal(store.get(taskId)!.status, 'working');
    assert.equal(store.events().length, 4);
    assert.equal(inputCalls, 1);
    await post(`/v1/tasks/${encoded}/respond`, { response: { version: 1, profileId, taskId, revision: 3, inputRevision: 2, text: 'stale private response' }, context: context('stale-source') }, 409);
    await post(`/v1/tasks/${encoded}/transition`, { expectedRevision: 4, nextStatus: 'needs_input', context: context('new-input-source') });
    onInput = async () => {
      await post(`/v1/tasks/${encoded}/transition`, { expectedRevision: 5, nextStatus: 'working', context: context('racing-source') });
      return 'RACING-PRIVATE-ANSWER';
    };
    assert.match(await command(`respond ${encoded}`), /stale.*no automatic retry/);
    assert.equal(store.events().length, 6, 'stale answer is not committed');
    await post(`/v1/tasks/${encoded}/transition`, { expectedRevision: 6, nextStatus: 'succeeded', context: context('completed-source') });
    const beforeReload = store.events();
    await session.reload();
    assert.match(await command(`show ${encoded}`), /succeeded.*verification: not_verified/s);
    assert.deepEqual(store.events(), beforeReload, 'native reload neither duplicates nor dispatches task work');
    assert.ok((await command('local')).includes(operationId));
    assert.equal(readFileSync(join(profile, 'operations.json'), 'utf8'), journalBeforeRead);
    await new Promise<void>(resolve => server.close(() => resolve())); store.close();
    store = new TaskStore(dbPath, profileId);
    server = createAssistantServer({ store, profileId, token: 'disposable-native-token' }); endpoint = await listen();
    assert.match(await command(`show ${encoded}`), /succeeded/);
    assert.match(await command(`original ${encoded} 1 6000`), /END-ORIGINAL/);
    assert.deepEqual(store.events(), beforeReload);
    assert.doesNotMatch(JSON.stringify(store.events()), /PRIVATE-NATIVE|RACING-PRIVATE|stale private/);
    assert.doesNotMatch(notices.join('\n'), /disposable-native-token|PRIVATE-NATIVE|RACING-PRIVATE/);
    assert.deepEqual(errors, []); assert.equal(inference, 0); assert.ok(requests > 20);
    console.log(JSON.stringify({ sdk: process.env.OPTCHAT_TEST_PI_ENTRY ? 'installed' : 'pinned', inference, requests, events: store.events().length, reloads: 1, storeReopens: 1 }));
  } finally {
    if (session) { await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    await new Promise<void>(resolve => server.close(() => resolve())); store.close(); removeDir(dir);
  }
});
