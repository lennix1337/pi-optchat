import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children, specialistMemoryTool } from '../src/agents.ts';
import type { ModelChoice } from '../src/compactor.ts';
import { AUDIT_DAYS, Crew, DIGEST_BYTES, type WorkerKind, MEMORY_BYTES, NUDGE, SPECIALIST_VIEW_BYTES, checkContract, crewTool, crewWakeNote, missingParts, pauseOnApiKey, registerDelegationNudge, routeFor, specialistOf } from '../src/crew.ts';
import { Memory, type Compressor } from '../src/memory.ts';
import { quotaPlan } from '../src/quota-health.ts';
import type { RunInfo } from '../src/runs.ts';
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
  assert.deepEqual(routeFor('code', { provider: 'openai-codex-account-2' }), { provider: 'openai-codex-account-2', model: 'gpt-6.1-terra', thinking: 'high' }, 'a Codex manager on a numbered account keeps that account');
  assert.deepEqual(routeFor('code', { provider: 'anthropic' }), { provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'high' });
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
  assert.equal(specialistOf('C:/projetos/lolidle-save-editor'), 'lolidle-save-editor', 'any other repo is its own specialist');
  assert.equal(specialistOf('C:\\projetos\\My_App.v2\\worktrees\\fix'), 'my-app-v2', 'the repo name as a slug; worktrees inside it belong to it');
  for (const repo of ['ai-memory', 'PiG', 'deepseek-harness', 'optmem']) assert.equal(specialistOf(`C:/projetos/${repo}/src`), 'harness', repo);
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
    crew.markAudited('dentai', new Date(old * 1000));
    assert.deepEqual([...crew.auditDue()], ['dentai']);
    crew.writeMissions('- GX18MCP sem issues abertas: próximo #955');
    const note = crewWakeNote(crew.missions(), crew.auditReasons());
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

test('a specialist with no memory or a thin memory is due for the audit, until audited or until its memory is written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-crew-audit-'));
  try {
    const crewDir = join(dir, 'crew'), crew = new Crew(crewDir), tool = crewTool(() => crew);
    const text = async (args: Parameters<typeof tool.execute>[1]) => (await tool.execute('id', args)).content[0].text;
    const day = 86_400_000, now = Date.now();
    const stamp = (specialist: string, days: number) => { const at = (now - days * day) / 1000; utimesSync(join(crewDir, specialist, 'memory.md'), at, at); };
    for (const specialist of ['dentai', 'harness', 'lolidle', 'orphan']) crew.write(specialist, 'charter', `# ${specialist}`);
    // Memories that predate audit.json: a thin one and a full one, both last written 8 days ago.
    writeFileSync(join(crewDir, 'dentai', 'memory.md'), 'x'.repeat(272) + '\n');
    writeFileSync(join(crewDir, 'harness', 'memory.md'), 'y'.repeat(5 * 1024));
    stamp('dentai', 8); stamp('harness', 8);
    const reasons = (at: number) => crew.auditReasons(at).map(({ specialist, reasons }) => `${specialist}: ${reasons.join('+')}`);
    assert.deepEqual(reasons(now), ['dentai: aged+thin', 'harness: aged', 'lolidle: missing', 'orphan: missing']);
    assert.equal(crew.auditReasons(now)[0].memoryBytes, 273);
    assert.deepEqual([...crew.auditDue(now)], ['dentai', 'harness', 'lolidle', 'orphan']);
    assert.equal(crew.auditDue(now).includes('genexus18mcp'), false, 'no charter, so nothing to audit');

    const note = crewWakeNote('', crew.auditReasons(now), crew.pendingCounts());
    assert.match(note, /Weekly audit due for the memory of: dentai, harness, lolidle, orphan/);
    assert.match(note, /thin: dentai 273 B/);
    assert.match(note, /missing: lolidle, orphan/);
    assert.match(note, /aged: dentai, harness/);
    assert.match(await text({ action: 'list' }), /^Audit due: dentai \(aged, thin\), harness \(aged\), lolidle \(missing\), orphan \(missing\)$/m);

    assert.equal(await text({ action: 'audit', project: 'dentai' }), 'dentai audited: memory 273 B, reasons aged, thin, proposals pending 0');
    assert.equal(await text({ action: 'audit', project: 'lolidle' }), 'lolidle audited: memory 0 B, reasons missing, proposals pending 0');
    assert.deepEqual(reasons(now + 6 * day), ['harness: aged', 'orphan: missing'], 'audited ones rest for the audit window');
    assert.deepEqual([...crew.auditDue(now + 6 * day)], ['harness', 'orphan']);
    assert.deepEqual([...crew.auditDue(now + 8 * day)], ['dentai', 'harness', 'lolidle', 'orphan'], 'and come back after it');
    await assert.rejects(tool.execute('id', { action: 'audit' }), /needs project/);
    assert.match(await text({ action: 'list' }), /^dentai: charter 9 B, memory 273 B, written 8\.0 d ago, audited \d{4}-\d\d-\d\d$/m);

    crew.write('harness', 'memory', 'z'.repeat(5 * 1024));
    assert.ok(JSON.parse(readFileSync(join(crewDir, 'audit.json'), 'utf8')).harness, 'writing a memory stamps its audit');
    assert.equal(crew.auditDue(now + 6 * day).includes('harness'), false, 'writing the memory counts as the audit');
    writeFileSync(join(crewDir, 'orphan', 'memory.md'), 'w'.repeat(5 * 1024));
    stamp('orphan', 1);
    assert.equal(crew.auditDue(now).includes('orphan'), false, 'a 5 KB memory written a day ago is not due');

    assert.deepEqual(readdirSync(crewDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort(), ['dentai', 'harness', 'lolidle', 'orphan'], 'no folder is made for the audit stamps');
  } finally { removeDir(dir); }
});

test('a memory proposal older than two days is flagged in the wake note and the list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-crew-stale-'));
  try {
    const crew = new Crew(join(dir, 'crew')), tool = crewTool(() => crew);
    const day = 86_400_000, now = Date.now();
    crew.propose('dentai', 'run-old', '- trap: raw body', new Date(now - 3 * day).toISOString());
    crew.propose('dentai', 'run-new', '- build: pnpm', new Date(now - 0.5 * day).toISOString());
    crew.propose('harness', 'run-fresh', '- gate: npm run check', new Date(now).toISOString());
    const counts = crew.pendingCounts(now);
    assert.deepEqual(counts, [{ specialist: 'dentai', count: 2, oldestDays: 3 }, { specialist: 'harness', count: 1, oldestDays: 0 }]);
    const note = crewWakeNote('', [], counts);
    assert.match(note, /Memory proposals pending.*dentai \(2\), harness \(1\)/);
    assert.match(note, /Proposals waiting more than 2 days.*dentai 3 d/);
    assert.doesNotMatch(note, /waiting more than 2 days[^\n]*harness/);
    assert.doesNotMatch(crewWakeNote('', [], crew.pendingCounts(now - 3 * day)), /waiting more than 2 days/, 'nothing is stale when every proposal is recent');
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

test('the delegation nudge does not count bash calls that only read', () => {
  const handlers = new Map<string, (event: any) => any>();
  registerDelegationNudge({ on: (name: string, handler: (event: any) => any) => { handlers.set(name, handler); } } as never, () => 2, () => true);
  const call = (command: string, toolName = 'bash') => handlers.get('tool_result')!({ toolName, input: { command }, content: [{ type: 'text', text: 'ok' }] });
  const reads = ['cat package.json', 'head -n 5 a.ts | wc -l', 'tail -f log', "sed -n '1,20p' src/a.ts", 'grep -rn "foo" src && rg bar', 'ls -la; git status --short', 'git log --oneline -5',
    'git -C C:/projetos/x diff --stat', 'git show HEAD:a.ts', 'gh pr view 12', 'gh issue list --state open', 'git diff 2>&1 | head -20', 'grep -i x f'];
  for (const command of reads) for (let i = 0; i < 3; i++) assert.equal(call(command), undefined, `read: ${command}`);
  const executes = ['npm test', 'cat a > b', 'sed -i s/a/b/ f', "sed -n -i 'p' f", 'ls && make clean', 'git commit -m x', 'git push', 'gh pr merge 3', 'gh api -X POST /x', 'cat $(make)', 'echo hi', 'git diff --output=out.patch', 'grep foo f | tee out', 'cat a; npm test'];
  for (const command of executes) {
    handlers.get('agent_start')!({});
    assert.equal(call(command), undefined, `first: ${command}`);
    assert.ok(call(command)?.content.at(-1).text.includes(NUDGE(2)), `counts: ${command}`);
  }
  handlers.get('agent_start')!({});
  assert.equal(call('x', 'edit'), undefined);
  assert.ok(call('x', 'write'), 'edit and write still count');
  handlers.get('agent_start')!({});
  assert.equal(call('x', 'shell_start'), undefined);
  assert.ok(call('cat a', 'shell_start'), 'shell_start counts whatever it runs');
});

/** A Children over a synthetic provider: `control.reply` is what workers answer, `control.hold` keeps their turn from ending until it resolves. */
async function crewHarness(options: { providers?: Record<string, string[]>; route?: (kind: WorkerKind) => ModelChoice; compress?: Compressor } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-crew-agents-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  memory.append('user', 'CHAT_SENTINEL_42');
  const prompts = new Map<string, string>(), tools = new Map<string, string[]>(), reports: string[] = [], control: { reply: string; hold?: Promise<void> } = { reply: 'done' };
  const compressions = { count: 0 };
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const model = (id: string) => ({ id, name: id, reasoning: false, input: ['text' as const], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 100000, maxTokens: 1000 });
  const synthetic = (models: string[]) => ({
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions' as const, models: models.map(model),
    streamSimple(m: { id: string; api: string; provider: string }, context: { messages: { role: string; content: unknown; toolsAdded?: { name: string }[] }[]; tools?: { name: string }[] }) {
      const stream = createAssistantMessageEventStream();
      const initial = textContent(context.messages.find(x => x.role === 'user')?.content);
      prompts.set(`${m.id}:${initial.split('Your task:\n').at(-1)}`, initial);
      tools.set(`${m.id}:${initial.split('Your task:\n').at(-1)}`, [...context.tools ?? [], ...context.messages.flatMap(x => x.toolsAdded ?? [])].map(tool => tool.name));
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: control.reply }], api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      void (control.hold ?? Promise.resolve()).then(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  runtime.registerProvider('optchat-test', synthetic(['child', 'worker']) as never);
  for (const [provider, models] of Object.entries(options.providers ?? {})) runtime.registerProvider(provider, synthetic(models) as never);
  const crew = new Crew(join(dir, 'crew'), { compress: options.compress ?? (async input => { compressions.count++; return input.source.slice(0, 100); }) });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async text => { reports.push(text); }, () => {}, dir,
    { route: options.route ?? (() => ({ provider: 'optchat-test', model: 'worker', thinking: 'minimal' })), crew, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  const done = async (...ids: string[]) => { for (const id of ids) await (children as any).running.get(id)?.completion; };
  return { dir, memory, prompts, tools, reports, control, crew, compressions, children, done, close: async () => { await children.close(); await crew.closeAll(); await memory.close(); removeDir(dir); } };
}

test('contract workers start from their project brief on their kind\'s model; plain subagents keep the chat view; the watcher reports a silent child once', async () => {
  const { dir, memory, prompts, reports, crew, children } = await crewHarness();
  crew.write('harness', 'memory', '- HARNESS_MEMORY_LINE');
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
  } finally { await children.close(); await crew.closeAll(); await memory.close(); removeDir(dir); }
});

test('specialists are the known four plus every folder of the crew dir; a project must be a slug, and the error lists the specialists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-crew-slugs-'));
  try {
    const crew = new Crew(join(dir, 'crew')), tool = crewTool(() => crew);
    const text = async (args: Parameters<typeof tool.execute>[1]) => (await tool.execute('id', args)).content[0].text;
    assert.deepEqual(crew.specialists(), ['dentai', 'genexus18mcp', 'harness', 'dotfiles']);
    assert.equal(await text({ action: 'write', project: 'lolidle', part: 'charter', text: '# lolidle' }), 'Wrote lolidle charter: 9 B.');
    assert.deepEqual(crew.specialists(), ['dentai', 'genexus18mcp', 'harness', 'dotfiles', 'lolidle']);
    assert.match(await text({ action: 'list' }), /^lolidle: charter 10 B, memory 0 B$/m);
    assert.deepEqual([...crew.auditDue()], ['lolidle'], 'a specialist with a charter and no memory is due, as missing');
    assert.throws(() => crew.check('Bad Slug'), /"Bad Slug" is not a valid project.*Specialists: dentai, genexus18mcp, harness, dotfiles, lolidle\./);
    await assert.rejects(tool.execute('id', { action: 'read', project: '../x', part: 'memory' }), /not a valid project/);
    await assert.rejects(tool.execute('id', { action: 'write', project: 'a'.repeat(42), part: 'memory', text: 'x' }), /not a valid project/);
    assert.equal(crew.check('a'.repeat(41)), 'a'.repeat(41));
  } finally { removeDir(dir); }
});

test('a contract worker for a project with no charter creates it from the template and the spawn result says so', async () => {
  const { dir, crew, children, prompts, done, close } = await crewHarness();
  try {
    crew.write('harness', 'charter', '# harness: mine');
    const repo = join(dir, 'projetos', 'new-repo');
    mkdirSync(repo, { recursive: true });
    const text = await children.start([{ task: CONTRACT, kind: 'code', cwd: repo }], dir);
    assert.match(text, /new specialist new-repo created/);
    const charter = crew.read('new-repo', 'charter');
    assert.ok(Buffer.byteLength(charter) <= 4096);
    assert.match(charter, /new-repo/);
    assert.ok(charter.includes(repo), 'names the project path');
    assert.match(charter, /AGENTS\.md/);
    assert.match(charter, /Push, PRs, merges, releases, deploys, paid runs, production data and stopping processes you did not start go back to the manager/);
    assert.equal(crew.read('new-repo', 'memory'), '', 'its memory starts empty');
    assert.ok(crew.specialists().includes('new-repo'));
    await done(...(children as any).running.keys());
    assert.match(prompts.get(`worker:${CONTRACT}`)!, /<project-charter project="new-repo">\n# new-repo specialist/);
    const again = await children.start([{ task: CONTRACT, kind: 'code', cwd: repo }], dir);
    assert.doesNotMatch(again, /new specialist/, 'an existing charter is left alone');
    await done(...(children as any).running.keys());
    const known = await children.start([{ task: CONTRACT, kind: 'code', project: 'harness' }], dir);
    assert.doesNotMatch(known, /new specialist/);
    assert.equal(crew.read('harness', 'charter').trim(), '# harness: mine');
    await done(...(children as any).running.keys());
    await assert.rejects(children.start([{ task: CONTRACT, kind: 'code', project: 'Not A Slug' }], dir), /"Not A Slug" is not a valid project.*new-repo/);
    assert.deepEqual(crew.specialists().filter(s => /not/.test(s)), []);
  } finally { await close(); }
});

test('a worker report\'s "## Memory proposal" is kept for the manager until its project memory is written', async () => {
  const { crew, children, control, done, close } = await crewHarness();
  try {
    const tool = crewTool(() => crew), text = async (args: Parameters<typeof tool.execute>[1]) => (await tool.execute('id', args)).content[0].text;
    control.reply = 'Feito.\n\n## Memory proposal\n- trap: Stripe needs the raw body\n- rule: gate is npm run verify\n\n## Notes\nignored';
    const [first] = await children.spawn([{ task: CONTRACT, kind: 'code', project: 'dentai' }], process.cwd());
    await done(first);
    control.reply = 'Done.\n## Memory proposal\nnone';
    const [none] = await children.spawn([{ task: CONTRACT, kind: 'plan', project: 'dentai' }], process.cwd());
    await done(none);
    control.reply = '## Memory proposal\n' + 'x'.repeat(5000);
    const [long] = await children.spawn([{ task: CONTRACT, kind: 'plan', project: 'harness' }], process.cwd());
    await done(long);
    control.reply = 'No section at all';
    const [plain] = await children.spawn([{ task: 'a plain subagent' }], process.cwd());
    await done(plain);
    const pending = crew.pending();
    assert.deepEqual(pending.map(p => [p.specialist, p.runId]), [['dentai', first], ['harness', long]], 'none, no section and plain subagents record nothing');
    assert.equal(pending[0].text, '- trap: Stripe needs the raw body\n- rule: gate is npm run verify');
    assert.ok(Buffer.byteLength(pending[1].text) <= 2048);
    assert.ok(!Number.isNaN(Date.parse(pending[0].date)));
    assert.match(JSON.parse(readFileSync(join(crew.dir, 'pending.json'), 'utf8'))[0].text, /raw body/, 'kept on disk in crew/pending.json');
    assert.match(await text({ action: 'list' }), /^proposals pending: dentai \(1\), harness \(1\)$/m);
    assert.match(await text({ action: 'read', part: 'proposals', project: 'dentai' }), /\[dentai\] run \w+, [\s\S]*raw body/);
    assert.match(crewWakeNote('', [], crew.pendingCounts()), /Memory proposals pending.*dentai \(1\), harness \(1\)/);
    assert.doesNotMatch(crewWakeNote('', []), /proposals/);
    await text({ action: 'write', project: 'dentai', part: 'memory', text: '- trap: Stripe needs the raw body' });
    assert.deepEqual(crew.pendingCounts(), [{ specialist: 'harness', count: 1, oldestDays: 0 }], 'writing the memory clears that specialist\'s proposals only');
  } finally { await close(); }
});

test('one writer per repo: a code, mechanical or hard worker is refused where another works, plan workers and worktrees are not', async () => {
  const { dir, children, control, done, close } = await crewHarness();
  try {
    const repo = join(dir, 'repo'), worktree = join(repo, 'worktrees', 'wt');
    mkdirSync(join(repo, '.git'), { recursive: true }); mkdirSync(join(repo, 'src'), { recursive: true }); mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: ../../.git/worktrees/wt\n');
    let release!: () => void;
    control.hold = new Promise<void>(resolve => { release = resolve; });
    const [writer] = await children.spawn([{ task: CONTRACT, kind: 'code', cwd: repo }], dir);
    for (const kind of ['code', 'mechanical', 'hard'] as const) {
      await assert.rejects(children.spawn([{ task: CONTRACT, kind, cwd: join(repo, 'src') }], dir), /One writer per repo.*already working.*worker \w+.*git worktree inside the project.*Nothing was started/, kind);
    }
    assert.equal(children.history.records.size, 1, 'a refused worker starts nothing');
    await assert.rejects(children.spawn([{ task: CONTRACT, kind: 'code', cwd: worktree }, { task: CONTRACT, kind: 'mechanical', cwd: worktree }], dir), /another task of this spawn/);
    assert.equal(children.history.records.size, 1);
    const free = await children.spawn([{ task: CONTRACT, kind: 'plan', cwd: repo }, { task: CONTRACT, kind: 'code', cwd: worktree }, { task: 'a plain subagent', cwd: repo }], dir);
    assert.equal(free.length, 3, 'plan workers, a worktree and plain subagents are exempt');
    release();
    await done(writer, ...free);
    const [next] = await children.spawn([{ task: CONTRACT, kind: 'code', cwd: repo }], dir);
    await done(next);
  } finally { await close(); }
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

const FAMILIES = { anthropic: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'], 'anthropic-account-2': ['claude-sonnet-5-5'],
  'openai-codex': ['gpt-6.1-terra', 'gpt-6-luna', 'gpt-6.1-sol'], 'openai-codex-account-2': ['gpt-6.1-terra', 'gpt-6-luna', 'gpt-6.1-sol'] };

test('with no model given, a worker runs its kind\'s tier on the manager\'s own provider and account, and the spawn result names it', async () => {
  for (const [main, kind, expected] of [['anthropic', 'code', 'anthropic/claude-sonnet-5-5'], ['openai-codex', 'code', 'openai-codex/gpt-6.1-terra'],
    ['openai-codex-account-2', 'code', 'openai-codex-account-2/gpt-6.1-terra'], ['openai-codex-account-2', 'mechanical', 'openai-codex-account-2/gpt-6-luna'],
    ['anthropic-account-2', 'code', 'anthropic-account-2/claude-sonnet-5-5']] as const) {
    const { dir, children, prompts, done, close } = await crewHarness({ providers: FAMILIES, route: wanted => routeFor(wanted, { provider: main }) });
    try {
      const text = await children.start([{ task: CONTRACT, kind, cwd: dir }], dir);
      const [id] = [...(children as any).running.keys()] as string[];
      assert.equal(children.history.records.get(id)?.model, expected, `${main} ${kind}`);
      assert.ok(text.includes(`${id} on ${expected}`), `the result names the model: ${text}`);
      await done(id);
      const prompt = [...prompts.values()].find(value => value.endsWith(CONTRACT))!;
      assert.ok(prompt.includes(`Your model: ${expected}`), 'the worker is told its own model');
    } finally { await close(); }
  }
});

test('a task\'s explicit model overrides the route and may cross accounts and providers', async () => {
  const { dir, children, done, close } = await crewHarness({ providers: FAMILIES, route: kind => routeFor(kind, { provider: 'openai-codex' }) });
  try {
    const text = await children.start([{ task: CONTRACT, kind: 'code', model: 'anthropic-account-2/claude-sonnet-5-5' }, { task: CONTRACT, kind: 'plan', model: 'openai-codex-account-2/gpt-6.1-terra' },
      { task: 'plain', model: 'anthropic/claude-haiku-5-5' }], dir);
    assert.match(text, /^Started: /, text);
    const runs = [...(children as any).running.values()].map(live => live.info) as { model: string; kind?: string }[];
    assert.deepEqual(runs.map(run => run.model), ['anthropic-account-2/claude-sonnet-5-5', 'openai-codex-account-2/gpt-6.1-terra', 'anthropic/claude-haiku-5-5']);
    await done(...(children as any).running.keys());
  } finally { await close(); }
});

test('an explicit model that does not resolve fails the spawn, and a numbered account never silently falls to its base provider', async () => {
  const providers = { ...FAMILIES, 'openai-codex-account-2': ['gpt-6-luna'] };
  const { dir, children, close } = await crewHarness({ providers, route: kind => routeFor(kind, { provider: 'openai-codex-account-2' }) });
  try {
    for (const model of ['openai-codex-account-2/gpt-6.1-terra', 'openai-codex-account-3/gpt-6.1-terra', 'anthropic/nope', 'no-slash']) {
      await assert.rejects(children.start([{ task: CONTRACT, kind: 'code', model }], dir), /model .*(unavailable|not a model|is not provider\/model).*Nothing was started/s, model);
    }
    await assert.rejects(children.start([{ task: CONTRACT, kind: 'code' }], dir), /Worker model for "code" is unavailable: openai-codex-account-2\/gpt-6\.1-terra.*Nothing was started/s,
      'the default route fails instead of running on openai-codex');
    assert.equal(children.history.records.size, 0, 'nothing started');
    assert.match(await children.start([{ task: CONTRACT, kind: 'mechanical', cwd: dir }], dir), /on openai-codex-account-2\/gpt-6-luna/);
  } finally { await close(); }
});

/** A finished contract run as the crew records it. */
const runOf = (i: number, project: string, report: string, extra: Partial<RunInfo> = {}): RunInfo => ({ id: `run${String(i).padStart(5, '0')}`, task: `Goal: GOAL_${i} keep the tree\n${CONTRACT}`,
  cwd: 'C:/projetos/pi-optchat', model: 'anthropic/claude-sonnet-5-5', thinking: 'high', parentSession: '', depth: 1, started: Date.now() - 3_600_000 + i * 1000, ended: Date.now() - 3_000_000 + i * 1000,
  state: 'completed', report, guidance: [], kind: 'code', project, ...extra });

test('a finished contract run appends one leaf to its specialist tree, and a resumed run\'s new report a second', async () => {
  const { children, control, crew, done, close } = await crewHarness();
  try {
    control.reply = `Feito: FIRST_REPORT ${'r'.repeat(9000)}\n\n## Memory proposal\n- PROPOSAL_LINE`;
    const [id] = await children.spawn([{ task: CONTRACT, kind: 'code', project: 'harness' }], process.cwd());
    await done(id);
    const tree = crew.memory('harness'), run = children.history.records.get(id)!;
    assert.equal(tree.root.length, 1, 'one leaf per finished run');
    const leaf = tree.root[0].text;
    assert.match(leaf, new RegExp(`^\\[run ${id}\\] code completed \\d{4}-\\d\\d-\\d\\dT\\S+Z \u2192 \\d{4}-\\d\\d-\\d\\dT\\S+Z, cwd .+, model optchat-test/worker\\nGoal: rename foo to bar\\nFeito: FIRST_REPORT r+`));
    assert.doesNotMatch(leaf, /Memory proposal|PROPOSAL_LINE|Full chat/, 'neither the proposal nor the full-chat pointer');
    assert.ok(Buffer.byteLength(leaf) <= DIGEST_BYTES, `capped: ${Buffer.byteLength(leaf)} B`);
    assert.equal(tree.root[0].kind, 'work');
    assert.equal(tree.root[0].receipt, `run:${id}:${run.started}`);
    assert.equal(crew.record(run), false, 'the same run is appended at most once');
    assert.equal(tree.root.length, 1);
    control.reply = 'SECOND_REPORT';
    await children.tell(id, 'one more thing');
    await done(id);
    assert.equal(tree.root.length, 2, 'a resumed run reports again: a second leaf');
    assert.match(tree.root[1].text, new RegExp(`^\\[run ${id}\\] code completed[\\s\\S]*SECOND_REPORT$`));
    control.reply = 'PLAIN_REPORT';
    const [plain] = await children.spawn([{ task: 'a plain subagent' }], process.cwd());
    await done(plain);
    assert.equal(tree.root.length, 2, 'a plain subagent records nothing');
  } finally { await crew.closeAll(); await close(); }
});

test('specialist_memory reads only the worker\'s own project: its tree and its runs, never another project\'s', async () => {
  const { children, control, crew, tools, done, close } = await crewHarness();
  try {
    control.reply = 'HARNESS_RUN_REPORT';
    const [harness] = await children.spawn([{ task: `${CONTRACT}\nH`, kind: 'code', project: 'harness' }], process.cwd());
    await done(harness);
    control.reply = 'DENTAI_RUN_REPORT';
    const [dentai, plain] = await children.spawn([{ task: `${CONTRACT}\nD`, kind: 'plan', project: 'dentai' }, { task: 'a plain subagent' }], process.cwd());
    await done(dentai, plain);
    assert.ok(tools.get(`worker:${CONTRACT}\nD`)?.includes('specialist_memory'), 'a contract worker has the tool');
    assert.equal(tools.get('child:a plain subagent')?.includes('specialist_memory'), false, 'a plain subagent does not');
    const tool = specialistMemoryTool(() => crew, 'dentai', run => children.transcript(run));
    const text = async (args: Parameters<typeof tool.execute>[1]) => (await tool.execute('id', args)).content[0].text;
    await crew.memory('dentai').settle(undefined, 'tree');
    const view = await text({});
    assert.match(view, /DENTAI_RUN_REPORT/);
    assert.doesNotMatch(view, /HARNESS_RUN_REPORT/);
    assert.match(await text({ id: 0, n: 1 }), /^0\+1\|work: \[run \w+\] plan completed[\s\S]*DENTAI_RUN_REPORT/);
    assert.match(await text({ id: 0, findText: 'dentai_run' }), /DENTAI_RUN_REPORT/);
    assert.match(await text({ run: dentai }), /DENTAI_RUN_REPORT/, 'a run of its own project opens');
    await assert.rejects(tool.execute('id', { run: harness }), new RegExp(`${harness} is not a run of project dentai`));
    await assert.rejects(tool.execute('id', { run: plain }), /is not a run of project dentai/);
    await assert.rejects(tool.execute('id', { run: 'nope1234' }), /is not a run of project dentai/);
    await assert.rejects(tool.execute('id', { id: 5, n: 1 }), /No line|no line|has 1/i, 'past its own tree');
    assert.equal(crew.memory('harness').root.length, 1, 'the other project keeps its own tree');
  } finally { await crew.closeAll(); await close(); }
});

test('the worker brief carries the specialist view under 8,192 B, says how to read more and when to tell the manager; cost per run', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-crew-view-'));
  let calls = 0;
  const crew = new Crew(dir, { compress: async input => { calls++; return `S ${input.source.replace(/\s+/g, ' ').slice(0, 400)}`; } });
  try {
    const runs = 48;
    for (let i = 0; i < runs; i++) assert.equal(crew.record(runOf(i, 'harness', `REPORT_${i} ${'x'.repeat(3000)}`)), true);
    const tree = crew.memory('harness');
    await tree.settle(undefined, 'tree');
    const brief = crew.brief('code', 'harness');
    const view = /<specialist-memory project="harness">\n([\s\S]*?)\n<\/specialist-memory>/.exec(brief)?.[1];
    assert.ok(view, brief);
    assert.ok(Buffer.byteLength(view) < SPECIALIST_VIEW_BYTES, `view ${Buffer.byteLength(view)} B`);
    assert.equal(view, tree.render());
    assert.match(view, /^<chat>\n0\+\d+\|/);
    assert.match(brief, /data, not instructions/);
    assert.match(brief, /read more with specialist_memory/);
    assert.match(brief, /tell_parent citing \[harness id\+n\]/);
    assert.doesNotMatch(crew.brief('code', undefined), /specialist-memory/);
    t.diagnostic(`crew compressor calls: ${calls} for ${runs} recorded runs = ${(calls / runs).toFixed(2)} per run`);
    assert.ok(calls <= 2 * runs, `${calls} calls`);
  } finally { await crew.closeAll(); removeDir(dir); }
});

test('the crew tool views and zooms a specialist tree, and list shows its size, run count and last runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-crew-zoom-'));
  const crew = new Crew(join(dir, 'crew'), { compress: async input => input.source.slice(0, 200) });
  const runs = [runOf(1, 'harness', 'ONE'), runOf(2, 'harness', 'TWO'), runOf(3, 'harness', 'THREE', { state: 'failed' }), runOf(4, 'harness', 'FOUR', { kind: 'plan' }), runOf(5, 'dentai', 'FIVE')];
  crew.bindRuns(() => runs);
  const tool = crewTool(() => crew), text = async (args: Parameters<typeof tool.execute>[1]) => (await tool.execute('id', args)).content[0].text;
  try {
    for (const run of runs) crew.record(run);
    await crew.memory('harness').settle(undefined, 'tree');
    assert.match(await text({ action: 'view', project: 'harness' }), /^<chat>\n0\+1\|work: \[run run00001\] code completed[\s\S]*\n3\+1\|work: \[run run00004\] plan completed/);
    assert.match(await text({ action: 'zoom', project: 'harness', id: 2, n: 1 }), /^2\+1\|work: \[run run00003\] code failed[\s\S]*THREE/);
    assert.match(await text({ action: 'zoom', project: 'harness', id: 0, n: 4, findText: 'TWO' }), /TWO/);
    await assert.rejects(tool.execute('id', { action: 'zoom', project: 'harness' }), /zoom needs id/);
    await assert.rejects(tool.execute('id', { action: 'view' }), /view needs project/);
    const list = await text({ action: 'list' });
    assert.match(list, /^ {2}harness tree: 4 leaves, 4 runs; last: run00004 plan completed 0\.\d h ago "GOAL_4 keep the tree", run00003 code failed [\d.]+ h ago "GOAL_3 keep the tree", run00002 code completed [\d.]+ h ago "GOAL_2 keep the tree"$/m);
    assert.match(list, /^ {2}dentai tree: 1 leaves, 1 runs; last: run00005 code completed/m);
    assert.doesNotMatch(list, /genexus18mcp tree/, 'no tree, no runs: nothing to show');
  } finally { await crew.closeAll(); removeDir(dir); }
});

test('resuming a finished writer where another writer works is refused: one writer per repo', async () => {
  const { dir, children, control, done, close } = await crewHarness();
  try {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const [first] = await children.spawn([{ task: CONTRACT, kind: 'code', cwd: repo }], dir);
    await done(first);
    let release!: () => void;
    control.hold = new Promise<void>(resolve => { release = resolve; });
    const [second] = await children.spawn([{ task: CONTRACT, kind: 'code', cwd: repo }], dir);
    await assert.rejects(children.tell(first, 'again'), new RegExp(`One writer per repo.*worker ${second} is already working.*Nothing was started`));
    assert.equal(children.history.records.get(first)?.state, 'completed', 'the refused resume leaves it finished');
    release(); control.hold = undefined;
    await done(second);
    await children.tell(first, 'again');
    await done(first);
    assert.equal(children.history.records.get(first)?.state, 'completed', 'resumed once the repo is free');
  } finally { await close(); }
});

test('a throwing crew compressor leaves the leaf unbuilt while the view, brief and tools keep working; an API-key provider pauses it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-crew-throw-'));
  const warnings: string[] = [];
  const crew = new Crew(dir, { compress: async () => { throw new Error('QUOTA_GONE'); }, warn: text => warnings.push(text) });
  try {
    assert.equal(crew.record(runOf(1, 'harness', 'x'.repeat(3000))), true);
    const tree = crew.memory('harness');
    await tree.settle();
    assert.equal(tree.node({ l: 0, i: 0 }), undefined, 'the leaf stays unbuilt');
    assert.match(tree.render(), /^<chat>\n0\+1\|\(not summarized yet: zoom it\)\n<\/chat>$/);
    assert.match(crew.brief('code', 'harness'), /<specialist-memory project="harness">\n<chat>\n0\+1\|\(not summarized yet/);
    assert.match(tree.zoom(0, 1), /\[run run00001\]/, 'the original stays readable');
    assert.match(warnings.join('\n'), /QUOTA_GONE/);
    assert.equal(crew.record(runOf(2, 'harness', 'short')), true, 'later runs still record');
  } finally { await crew.closeAll(); removeDir(dir); }
  let called = 0;
  const inner: Compressor = async () => { called++; return 'line'; };
  const plans: Record<string, string> = { anthropic: 'api-key', 'anthropic-account-2': 'max' };
  const input = { context: '<chat>\n</chat>', source: 'x', part: { l: 0, i: 0 } };
  await assert.rejects(pauseOnApiKey(inner, () => 'anthropic', provider => plans[provider])(input, new AbortController().signal), /crew compaction paused: API-key provider/);
  assert.equal(called, 0, 'nothing is spent on an API key');
  assert.equal(await pauseOnApiKey(inner, () => 'anthropic-account-2', provider => plans[provider])(input, new AbortController().signal), 'line');
  const file = join(mkdtempSync(join(tmpdir(), 'optchat-quota-')), 'provider-failover-state.json');
  assert.equal(quotaPlan('anthropic', file), undefined, 'no cache: unknown');
  writeFileSync(file, JSON.stringify({ usageByProvider: { anthropic: { plan: 'api-key' }, 'anthropic-account-2': { plan: 'max' } } }));
  assert.equal(quotaPlan('anthropic', file), 'api-key');
  assert.equal(quotaPlan('anthropic-account-2', file), 'max');
  assert.equal(quotaPlan('openai-codex', file), undefined);
});

test('an empty specialist tree is backfilled once from its project\'s finished contract runs of the last 14 days, at most 60', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-crew-backfill-'));
  const notes: string[] = [];
  const day = 86_400_000;
  const recent = Array.from({ length: 70 }, (_, i) => runOf(i, 'harness', `R${i}`));
  const runs = [...recent, runOf(100, 'harness', 'OLD', { started: Date.now() - 20 * day, ended: Date.now() - 20 * day }), runOf(101, 'dentai', 'OTHER'),
    runOf(102, 'harness', 'PLAIN', { kind: undefined }), runOf(103, 'harness', 'LIVE', { state: 'running', ended: undefined })];
  const open = () => { const crew = new Crew(dir, { compress: async input => input.source.slice(0, 100), note: text => notes.push(text) }); crew.bindRuns(() => runs); return crew; };
  let crew = open();
  try {
    const tree = crew.memory('harness');
    assert.equal(tree.root.length, 60, 'the newest 60');
    assert.match(tree.root[0].text, /^\[run run00010\]/, 'oldest first');
    assert.match(tree.root[59].text, /^\[run run00069\]/);
    assert.deepEqual(notes, ['crew harness: backfilled 60 finished runs into its memory tree.']);
    assert.equal(crew.record(recent[69]), false, 'a backfilled run is not appended again');
    await crew.closeAll();
    crew = open();
    assert.equal(crew.memory('harness').root.length, 60, 'a tree with leaves is never backfilled again');
    assert.equal(notes.length, 1);
  } finally { await crew.closeAll(); removeDir(dir); }
});
