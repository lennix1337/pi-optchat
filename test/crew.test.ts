import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { AUDIT_DAYS, Crew, MEMORY_BYTES, NUDGE, checkContract, crewTool, crewWakeNote, missingParts, registerDelegationNudge, routeFor, specialistOf } from '../src/crew.ts';
import { Memory } from '../src/memory.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

const CONTRACT = 'Goal: rename foo to bar\nAcceptance: tests pass\nEvidence: npm test output\nAuthority: local commits only, no push';

test('routeFor follows the main model\'s provider family and live account, and falls back to the first route', () => {
  assert.deepEqual(routeFor('code', { provider: 'anthropic-account-2' }), { provider: 'anthropic-account-2', model: 'claude-sonnet-5-5', thinking: 'high' });
  assert.deepEqual(routeFor('mechanical', { provider: 'openai-codex' }), { provider: 'openai-codex', model: 'gpt-6-luna', thinking: 'medium' });
  assert.equal(routeFor('hard', { provider: 'anthropic' }).model, 'claude-opus-5-5');
  assert.equal(routeFor('code', { provider: 'google' }).provider, 'anthropic', 'no route for the family: the first one');
  assert.equal(routeFor('code', undefined).model, 'claude-sonnet-5-5');
  const custom = { code: [{ provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'low' as const }] };
  assert.equal(routeFor('code', { provider: 'anthropic' }, custom).model, 'claude-haiku-5-5', 'a profile route replaces the default');
  assert.equal(routeFor('plan', { provider: 'anthropic' }, custom).model, 'claude-opus-5-5', 'kinds it leaves out keep the default');
});

test('specialistOf maps the operator\'s project folders to their specialist', () => {
  assert.equal(specialistOf('C:/projetos/dentai-mono/apps/web'), 'dentai');
  assert.equal(specialistOf('C:\\projetos\\Genexus18MCP\\worktrees\\fix-1'), 'genexus18mcp');
  assert.equal(specialistOf('C:/projetos/pi-optchat'), 'harness');
  assert.equal(specialistOf('C:/projetos/ripwire'), 'harness');
  assert.equal(specialistOf('C:/projetos/dotfiles/payload'), 'dotfiles');
  assert.equal(specialistOf('C:/projetos/lolidle-save-editor'), undefined);
  assert.equal(specialistOf('C:/Users/swluc'), undefined);
});

test('a worker task must be a contract: the four parts, as headings or labels, in English or Portuguese', () => {
  assert.deepEqual(missingParts(CONTRACT), []);
  assert.deepEqual(missingParts('## Objetivo\nx\n## Critério de aceite\ny\n- **Prova:** z\nAutoridade: nenhuma'), []);
  assert.deepEqual(missingParts('Fix the login bug and run the tests'), ['goal', 'acceptance', 'evidence', 'authority']);
  assert.throws(() => checkContract('Goal: x\nAcceptance: y'), /add "Evidence:", "Authority:".*Nothing was started/);
});

test('the crew keeps charters and memories under their caps, briefs workers from them, and flags stale memories for the audit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-crew-'));
  try {
    const crew = new Crew(dir);
    crew.write('dentai', 'charter', 'DentAI: Next.js + Hono; deploy is the operator\'s.');
    crew.write('dentai', 'memory', '- build: pnpm turbo build\n- trap: Stripe webhooks need the raw body');
    assert.throws(() => crew.write('dentai', 'memory', 'x'.repeat(MEMORY_BYTES + 1)), /over its 6144-byte cap.*Nothing was written/);
    assert.match(crew.read('dentai', 'memory'), /raw body/, 'a refused write leaves the old memory');
    const brief = crew.brief('code', 'dentai');
    assert.match(brief, /\[Worker brief\] You are a code worker/);
    assert.match(brief, /<project-charter project="dentai">\nDentAI: Next\.js/);
    assert.match(brief, /Stripe webhooks need the raw body/);
    assert.match(brief, /## Memory proposal/);
    assert.doesNotMatch(brief, /You are a scout/);
    assert.match(crew.brief('plan', undefined), /You are a scout: read and investigate, change nothing/);
    assert.doesNotMatch(crew.brief('mechanical', undefined), /project-memory|Memory proposal/);
    assert.deepEqual(crew.auditDue(), []);
    const old = (Date.now() - (AUDIT_DAYS + 1) * 86_400_000) / 1000;
    utimesSync(join(dir, 'dentai', 'memory.md'), old, old);
    assert.deepEqual(crew.auditDue(), ['dentai']);
    crew.writeMissions('- GX18MCP sem issues abertas: próximo #955');
    const note = crewWakeNote(crew.missions(), crew.auditDue());
    assert.match(note, /Open missions \(crew missions\.md\):\n- GX18MCP sem issues abertas/);
    assert.match(note, /Weekly audit due for the memory of: dentai/);
    assert.doesNotMatch(crewWakeNote('', []), /Open missions|audit/);
  } finally { removeDir(dir); }
});

test('the crew tool lists, reads and replaces parts, and refuses a write without its project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-crew-tool-'));
  try {
    const crew = new Crew(dir), tool = crewTool(() => crew);
    const text = async (args: Parameters<typeof tool.execute>[1]) => (await tool.execute('id', args)).content[0].text;
    assert.equal(await text({ action: 'write', project: 'harness', part: 'memory', text: '- gates: npm run verify' }), 'Wrote harness memory: 23 B.');
    assert.equal(await text({ action: 'read', project: 'harness' }), '- gates: npm run verify');
    assert.equal(await text({ action: 'read', part: 'missions' }), '(empty)');
    assert.match(await text({ action: 'list' }), /harness: charter 0 B, memory 24 B, written 0\.0 d ago[\s\S]*No audit due\./);
    await assert.rejects(tool.execute('id', { action: 'write', part: 'memory', text: 'x' }), /needs project/);
  } finally { removeDir(dir); }
});

test('a memory file stamped slightly ahead of the clock reads as 0.0 days old, never negative', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-crew-age-'));
  try {
    const crew = new Crew(dir);
    crew.write('harness', 'memory', '- x');
    const ahead = new Date(Date.now() + 5_000);
    utimesSync(join(dir, 'harness', 'memory.md'), ahead, ahead);
    assert.equal(crew.age('harness'), 0);
  } finally { removeDir(dir); }
});

test('the delegation nudge appears on every Nth execution call of a turn, only in manager mode', async () => {
  const handlers = new Map<string, (event: any) => any>();
  const pi = { on: (name: string, handler: (event: any) => any) => { handlers.set(name, handler); } };
  let on = true;
  registerDelegationNudge(pi as never, () => 3, () => on);
  const call = (toolName: string) => handlers.get('tool_result')!({ toolName, content: [{ type: 'text', text: 'ok' }] });
  assert.equal(call('bash'), undefined);
  assert.equal(call('read'), undefined, 'reads do not count');
  assert.equal(call('edit'), undefined);
  assert.equal(call('bash').content.at(-1).text, `\n${NUDGE(3)}`);
  handlers.get('agent_start')!({});
  assert.equal(call('bash'), undefined, 'a new turn starts the count again');
  on = false;
  for (let i = 0; i < 5; i++) assert.equal(call('bash'), undefined);
});

test('contract workers start from their project brief on their kind\'s model; plain subagents keep the chat view; the watcher reports a silent child once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-crew-agents-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  memory.append('user', 'CHAT_SENTINEL_42');
  const prompts = new Map<string, string>(), reports: string[] = [];
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const model = (id: string) => ({ id, name: id, reasoning: false, input: ['text' as const], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 100000, maxTokens: 1000 });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions', models: [model('child'), model('worker')],
    streamSimple(m, context) {
      const stream = createAssistantMessageEventStream();
      const initial = textContent(context.messages.find(x => x.role === 'user')?.content);
      prompts.set(`${m.id}:${initial.split('Your task:\n').at(-1)}`, initial);
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const crew = new Crew(join(dir, 'crew'));
  crew.write('harness', 'memory', '- HARNESS_MEMORY_LINE');
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async text => { reports.push(text); }, () => {}, dir,
    { route: () => ({ provider: 'optchat-test', model: 'worker', thinking: 'minimal' }), crew, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  try {
    await assert.rejects(children.spawn([{ task: 'Fix it', kind: 'code' }], dir), /is a contract/);
    assert.equal(children.history.records.size, 0, 'a refused contract starts nothing');
    const [worker, plain] = await children.spawn([{ task: CONTRACT, kind: 'code', project: 'harness' }, { task: 'plain task' }], dir);
    await (children as any).running.get(worker)?.completion; await (children as any).running.get(plain)?.completion;
    const workerPrompt = prompts.get(`worker:${CONTRACT}`)!, plainPrompt = prompts.get('child:plain task')!;
    assert.ok(workerPrompt, 'the code worker ran on its route\'s model');
    assert.match(workerPrompt, /\[Worker brief\][\s\S]*HARNESS_MEMORY_LINE/);
    assert.doesNotMatch(workerPrompt, /CHAT_SENTINEL_42/, 'a worker never gets the manager\'s chat');
    assert.match(plainPrompt, /CHAT_SENTINEL_42/);
    assert.equal(children.history.records.get(worker)?.kind, 'code');
    assert.equal(children.history.records.get(worker)?.project, 'harness');

    const silent = { info: { id: 'silent1', state: 'running', model: 'optchat-test/worker', kind: 'code' }, updated: Date.now() - 20 * 60_000, tools: new Map([['t', { name: 'bash', args: {}, started: 0 }]]) };
    (children as any).running.set('silent1', silent);
    assert.deepEqual(await children.checkStalls(), ['silent1']);
    assert.match(reports.at(-1)!, /\[silent1\] Watcher: no activity for 20 min while its bash call runs \(optchat-test\/worker, code worker\)/);
    assert.deepEqual(await children.checkStalls(), [], 'reported once');
    silent.updated = Date.now();
    assert.deepEqual(await children.checkStalls(), []);
    silent.updated = Date.now() - 20 * 60_000;
    assert.deepEqual(await children.checkStalls(), ['silent1'], 'reported again after it showed activity');
    (children as any).running.delete('silent1');
  } finally { await children.close(); await memory.close(); removeDir(dir); }
});

test('a profile config keeps valid worker routes and refuses an unknown kind or an empty list', async () => {
  const { writeFileSync } = await import('node:fs');
  const { loadConfig } = await import('../src/profiles.ts');
  const dir = mkdtempSync(join(tmpdir(), 'optchat-routes-'));
  const sonnet = { provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'high' };
  const base = { compactor: sonnet, subagent: sonnet };
  const load = (extra: object) => { writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...base, ...extra })); return loadConfig(dir); };
  try {
    assert.deepEqual(load({ workerModels: { code: [sonnet] } }).workerModels, { code: [sonnet] });
    assert.equal(load({}).workerModels, undefined);
    assert.throws(() => load({ workerModels: { review: [sonnet] } }), /Invalid profile config/);
    assert.throws(() => load({ workerModels: { code: [] } }), /Invalid profile config/);
  } finally { removeDir(dir); }
});
