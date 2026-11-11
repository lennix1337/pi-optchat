import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { addCommitment, readCommitments } from '../src/commitments.ts';
import { checkContract } from '../src/crew.ts';
import { PATROL_TOOLS } from '../src/lean-worker.ts';
import { Memory } from '../src/memory.ts';
import { createPatrol, escalationNote, patrolBashRefusal, patrolContract, patrolTool } from '../src/patrol.ts';
import { invalidPatrol } from '../src/patrol-divert.ts';
import { defaults, loadConfig, saveConfig } from '../src/profiles.ts';
import { lastRunsOf } from '../src/wake-signals.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));
const temp = () => mkdtempSync(join(tmpdir(), 'patrol-'));
const T0 = Date.parse('2026-11-10T18:00:00Z');
const HOUR = 3_600_000;
const text = async (call: Promise<{ content: { type: string; text?: string }[] }>) => (await call).content.map(part => part.text ?? '').join(' ');

function store() {
  const dir = temp();
  const mine = addCommitment(dir, { text: 'Land the login fix', source: '1', project: 'dentai', due: new Date(T0 - 30 * HOUR).toISOString(), links: { prs: ['o/r#5'] } }, T0 - 40 * HOUR);
  const other = addCommitment(dir, { text: 'Rotate the keys', source: '2', project: 'harness' }, T0 - 40 * HOUR);
  const plain = addCommitment(dir, { text: 'No owner project', source: '3' }, T0 - 40 * HOUR);
  const operators = addCommitment(dir, { text: 'His own', source: '4', owner: 'operator', project: 'dentai' }, T0 - 40 * HOUR);
  const escalated: string[] = [];
  const tool = patrolTool({ dir, project: 'dentai', run: 'r1', escalated: id => escalated.push(id), now: () => T0 });
  return { dir, mine, other, plain, operators, escalated, tool };
}

test('the patrol tool lists only the items of its own project', async () => {
  const s = store();
  try {
    const listed = await text(s.tool.execute('t', { action: 'list' }));
    assert.match(listed, new RegExp(s.mine.id));
    for (const hidden of [s.other, s.plain, s.operators]) assert.doesNotMatch(listed, new RegExp(hidden.id));
  } finally { removeDir(s.dir); }
});

test('the patrol tool refuses items of another project, items without one and the operator’s, and changes nothing', async () => {
  const s = store();
  try {
    const before = readFileSync(join(s.dir, 'commitments.json'), 'utf8');
    for (const item of [s.other, s.plain, s.operators]) await assert.rejects(s.tool.execute('t', { action: 'update', id: item.id, progress: 'seen' }), /not a dentai commitment|operator's/);
    await assert.rejects(s.tool.execute('t', { action: 'update', id: 'c_missing', progress: 'x' }), /No commitment/);
    assert.equal(readFileSync(join(s.dir, 'commitments.json'), 'utf8'), before);
  } finally { removeDir(s.dir); }
});

test('the patrol tool has no way to add, relink, reassign or edit text: its schema carries none of them', () => {
  const s = store();
  try {
    const keys = Object.keys((s.tool.parameters as { properties: object }).properties).sort();
    assert.deepEqual(keys, ['action', 'choices', 'dueInMinutes', 'due', 'evidence', 'id', 'next', 'progress', 'status'].sort());
    assert.deepEqual([...(s.tool.parameters as unknown as { properties: { action: { enum: string[] } } }).properties.action.enum], ['list', 'update']);
  } finally { removeDir(s.dir); }
});

test('the patrol tool records progress on a not-yet-overdue item, tagged with the run', async () => {
  const s = store();
  try {
    const fresh = addCommitment(s.dir, { text: 'Fresh one', source: '5', project: 'dentai' }, T0 - HOUR);
    await s.tool.execute('t', { action: 'update', id: fresh.id, progress: 'PR 5 is green', next: 'merge it' });
    const item = readCommitments(s.dir).find(c => c.id === fresh.id)!;
    assert.equal(item.next, 'merge it');
    assert.equal(item.notes.at(-1)!.text, 'patrol r1: PR 5 is green');
    assert.deepEqual(s.escalated, []);
  } finally { removeDir(s.dir); }
});

test('an item overdue 24 h+ takes only the three moves from a patrol: a note alone is refused', async () => {
  const s = store();
  try {
    await assert.rejects(s.tool.execute('t', { action: 'update', id: s.mine.id, progress: 'still looking' }), /close it with evidence, narrow it/);
    await s.tool.execute('t', { action: 'update', id: s.mine.id, progress: 'checked CI', due: new Date(T0 + 4 * HOUR).toISOString(), next: 'merge when green' });
    assert.equal(readCommitments(s.dir).find(c => c.id === s.mine.id)!.next, 'merge when green');
  } finally { removeDir(s.dir); }
});

test('a patrol closes with evidence, and cannot close without it', async () => {
  const s = store();
  try {
    await assert.rejects(s.tool.execute('t', { action: 'update', id: s.mine.id, status: 'done' }), /evidence/i);
    await s.tool.execute('t', { action: 'update', id: s.mine.id, status: 'done', evidence: 'PR o/r#5 merged abc1234' });
    assert.equal(readCommitments(s.dir).find(c => c.id === s.mine.id)!.status, 'done');
    assert.deepEqual(s.escalated, [], 'closing is not an escalation');
  } finally { removeDir(s.dir); }
});

test('waiting_operator with choices is the escalation: it is reported once, and needs choices', async () => {
  const s = store();
  try {
    await assert.rejects(s.tool.execute('t', { action: 'update', id: s.mine.id, status: 'waiting_operator' }), /needs choices/);
    await s.tool.execute('t', { action: 'update', id: s.mine.id, status: 'waiting_operator', choices: ['merge', 'drop'], progress: 'needs his call' });
    assert.deepEqual(s.escalated, [s.mine.id]);
    const item = readCommitments(s.dir).find(c => c.id === s.mine.id)!;
    assert.deepEqual([item.status, item.choices], ['waiting_operator', ['merge', 'drop']]);
    assert.match(escalationNote(item, 'dentai'), /patrol of dentai escalated .* \(waiting_operator with choices\): Land the login fix/);
    const listed = await text(s.tool.execute('t', { action: 'list' }));
    assert.doesNotMatch(listed, new RegExp(s.mine.id), 'a question already asked leaves the patrol list');
  } finally { removeDir(s.dir); }
});

test('the contract lists the project’s open items and their links, and passes the worker contract check', () => {
  const s = store();
  try {
    const contract = patrolContract('dentai', readCommitments(s.dir), T0);
    assert.doesNotThrow(() => checkContract(contract));
    assert.match(contract, new RegExp(s.mine.id));
    assert.match(contract, /linked: o\/r#5/);
    for (const hidden of [s.other, s.plain, s.operators]) assert.doesNotMatch(contract, new RegExp(hidden.id));
    assert.match(contract, /Authority: read-only/);
  } finally { removeDir(s.dir); }
});

test('patrol bash: reads pass; writes, redirections, substitutions and unknown programs are refused', () => {
  for (const ok of ['git status --short', 'git -C /x log --oneline -5', 'git diff main...HEAD | head -20', 'gh pr view 5 --json state', 'gh pr checks 5', 'gh run view 12 --log-failed', "gh api repos/o/r/pulls/5", 'ls -la && cat README.md', 'git branch --merged main', 'grep -rn "a > b" src', 'find . -name "*.ts"'])
    assert.equal(patrolBashRefusal(ok), undefined, ok);
  for (const bad of ['git push origin main', 'git commit -am x', 'git checkout -b x', 'git reset --hard', 'gh pr merge 5', 'gh pr comment 5 -b hi', 'gh api -X POST repos/o/r/issues', 'gh api repos/o/r/issues -f title=x', 'echo hi > file.txt', 'cat a >> b', 'echo $(rm -rf x)', 'echo `id`', 'rm -rf x', 'node script.js', 'npm test', 'sed -i s/a/b/ f', 'find . -delete', 'ls; git push', 'git status | tee out', 'git branch -D x', 'curl http://x', 'sh -c "git push"'])
    assert.match(patrolBashRefusal(bad) ?? '', /read-only/, bad);
});

test('a patrol worker has no edit, write or spawn tool', () => {
  for (const tool of ['edit', 'write', 'shell_start', 'spawn', 'tell', 'tell_parent', 'tell_peer']) assert.ok(!PATROL_TOOLS.includes(tool), tool);
  assert.ok(PATROL_TOOLS.includes('commitments') && PATROL_TOOLS.includes('bash') && PATROL_TOOLS.includes('read'));
});

test('specialistPatrol in config.json: valid, absent by default, and bad values are named', () => {
  assert.equal(invalidPatrol(undefined), undefined);
  assert.equal(invalidPatrol({ kind: 'mechanical', minHours: 6 }), undefined);
  for (const bad of [null, 'x', [], {}, { kind: 'hard', minHours: 6 }, { kind: 'code', minHours: 0 }, { kind: 'code', minHours: 'x' }]) assert.match(invalidPatrol(bad) ?? '', /specialistPatrol must be/, JSON.stringify(bad));
  const dir = temp();
  try {
    saveConfig(dir, defaults);
    assert.equal(loadConfig(dir).specialistPatrol, undefined);
    saveConfig(dir, { ...defaults, specialistPatrol: { kind: 'code', minHours: 12 } });
    assert.deepEqual(loadConfig(dir).specialistPatrol, { kind: 'code', minHours: 12 });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...defaults, specialistPatrol: { kind: 'bad', minHours: 1 } }));
    assert.throws(() => loadConfig(dir), /specialistPatrol must be/);
  } finally { removeDir(dir); }
});

test('createPatrol starts a read-only patrol of the project in its repo, and a start that fails later becomes an escalation line', async () => {
  const dir = temp(), repo = join(dir, 'projetos', 'dentai-mono');
  mkdirSync(repo, { recursive: true });
  addCommitment(dir, { text: 'Land the login fix', source: '1', project: 'dentai' }, T0);
  const spawned: { task: { kind?: string; project?: string; patrol?: boolean; task: string }; cwd: string }[] = [], lines: string[] = [];
  const runs = [{ id: 'r0', kind: 'code', project: 'dentai', cwd: repo, started: 1, state: 'completed' }] as never[];
  let fail = false;
  const patrol = createPatrol({ plan: { kind: 'mechanical', minHours: 6 }, dir, specialists: () => ['dentai'], runs: () => runs, now: () => T0,
    spawn: async (task, cwd) => { spawned.push({ task, cwd }); if (fail) throw new Error('Profile limit'); }, escalate: (project, line) => lines.push(`${project}: ${line}`) });
  try {
    assert.equal(patrol.handles('dentai'), true);
    assert.equal(patrol.handles('harness'), false);
    assert.equal(patrol.start('dentai', [{ id: 'c', project: 'dentai', kind: 'due', line: 'commitment due: c x' }]), true);
    assert.equal(spawned.length, 1);
    assert.deepEqual([spawned[0]!.task.kind, spawned[0]!.task.project, spawned[0]!.task.patrol, spawned[0]!.cwd], ['mechanical', 'dentai', true, repo]);
    assert.match(spawned[0]!.task.task, /Land the login fix/);
    assert.equal(patrol.start('harness', []), false, 'no run of that project to find its repo from');
    fail = true;
    assert.equal(patrol.start('dentai', [{ id: 'c', project: 'dentai', kind: 'due', line: 'commitment due: c x' }]), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.match(lines[0]!, /^dentai: patrol of dentai could not start \(Profile limit\); commitment due: c x$/);
  } finally { removeDir(dir); }
});

test('running(project) is true while any worker of the project is active, a patrol included', () => {
  const dir = temp();
  let state = 'running';
  const runs = [{ id: 'r1', kind: 'code', project: 'dentai', started: 1, state, cwd: dir }] as never[];
  const patrol = createPatrol({ plan: { kind: 'code', minHours: 1 }, dir, specialists: () => ['dentai'], runs: () => runs.map(run => ({ ...(run as object), state }) as never), spawn: async () => {}, escalate: () => {} });
  try {
    assert.equal(patrol.running('dentai'), true);
    assert.equal(patrol.running('harness'), false);
    state = 'completed';
    assert.equal(patrol.running('dentai'), false);
  } finally { removeDir(dir); }
});

test('a patrol run does not count as the specialist’s last work run, so it never clears a stall', () => {
  const runs = [{ id: 'a', kind: 'code', project: 'dentai', started: 100, ended: 200, state: 'completed' }, { id: 'p', kind: 'mechanical', project: 'dentai', patrol: true, started: 500, ended: 600, state: 'completed' }] as never[];
  assert.deepEqual(lastRunsOf(runs, 1000), { dentai: { id: 'a', at: 200 } });
});

/** One Children run on a synthetic model, ending with `reason`; returns what its report callback got and the session options. */
async function runPatrol(reason: 'stop' | 'error', dir: string, spec: { patrol: boolean }) {
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions' as const,
    models: [{ id: 'child', name: 'child', reasoning: false, input: ['text' as const], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(m: { id: string; api: string; provider: string }) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'checked every item' }], api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), stopReason: reason, usage: emptyUsage(), ...reason === 'error' ? { errorMessage: 'boom' } : {} };
      setImmediate(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  } as never);
  const reports: string[] = [], ended: string[] = [], created: { tools?: string[]; customTools?: { name: string }[] }[] = [];
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '',
    async text => { reports.push(text); }, () => {}, dir,
    { onRunEnd: run => { ended.push(`${run.id}:${run.state}`); }, appendix: async () => '',
      createSession: options => { created.push(options as never); return createAgentSession({ ...options, modelRuntime: runtime }); } });
  const contract = 'Goal: patrol.\nAcceptance: each item recorded.\nEvidence: quoted.\nAuthority: read-only.';
  const [id] = await children.spawn([{ task: contract, kind: 'mechanical', project: 'dentai', ...spec.patrol ? { patrol: true } : {} }], dir);
  await (children as any).running.get(id)?.completion;
  const run = children.runs().find(found => found.id === id);
  await children.close(); await memory.close();
  return { reports, ended, created: created[0]!, run };
}

test('a completed patrol run is recorded and not delivered; the same run without patrol is delivered', async () => {
  const quiet = temp(), loud = temp();
  try {
    const q = await runPatrol('stop', quiet, { patrol: true });
    assert.deepEqual(q.reports, [], 'no manager report');
    assert.equal(q.ended.length, 1);
    assert.equal(q.run?.state, 'completed');
    assert.equal(q.run?.patrol, true);
    assert.match(q.run?.report ?? '', /checked every item/);
    assert.deepEqual(q.created.tools, [...PATROL_TOOLS]);
    assert.ok(q.created.customTools?.some(tool => tool.name === 'commitments'));
    const l = await runPatrol('stop', loud, { patrol: false });
    assert.equal(l.reports.length, 1, 'an ordinary contract worker still reports');
    assert.ok(!l.created.customTools?.some(tool => tool.name === 'commitments'));
  } finally { removeDir(quiet); removeDir(loud); }
});

test('a failed patrol run is delivered: a broken patrol is news', async () => {
  const dir = temp();
  try {
    const f = await runPatrol('error', dir, { patrol: true });
    assert.equal(f.run?.state, 'failed');
    assert.equal(f.reports.length, 1);
  } finally { removeDir(dir); }
});
