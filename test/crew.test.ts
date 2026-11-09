import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
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
async function crewHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-crew-agents-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  memory.append('user', 'CHAT_SENTINEL_42');
  const prompts = new Map<string, string>(), reports: string[] = [], control: { reply: string; hold?: Promise<void> } = { reply: 'done' };
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const model = (id: string) => ({ id, name: id, reasoning: false, input: ['text' as const], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 100000, maxTokens: 1000 });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions', models: [model('child'), model('worker')],
    streamSimple(m, context) {
      const stream = createAssistantMessageEventStream();
      const initial = textContent(context.messages.find(x => x.role === 'user')?.content);
      prompts.set(`${m.id}:${initial.split('Your task:\n').at(-1)}`, initial);
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: control.reply }], api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      void (control.hold ?? Promise.resolve()).then(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  const crew = new Crew(join(dir, 'crew'));
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async text => { reports.push(text); }, () => {}, dir,
    { route: () => ({ provider: 'optchat-test', model: 'worker', thinking: 'minimal' }), crew, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  const done = async (...ids: string[]) => { for (const id of ids) await (children as any).running.get(id)?.completion; };
  return { dir, memory, prompts, reports, control, crew, children, done, close: async () => { await children.close(); await memory.close(); removeDir(dir); } };
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
  } finally { await children.close(); await memory.close(); removeDir(dir); }
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
    assert.deepEqual(crew.auditDue(), [], 'a specialist without a memory is not due');
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
    assert.deepEqual(crew.pendingCounts(), [{ specialist: 'harness', count: 1 }], 'writing the memory clears that specialist\'s proposals only');
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
