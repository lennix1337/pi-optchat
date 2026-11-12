import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Children } from '../src/agents.ts';
import { Crew, MANAGER_DOC } from '../src/crew.ts';
import { Memory } from '../src/memory.ts';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';
import { markBriefPrefix, relativeContext, RUN_MARK } from '../src/worker-prefix.ts';
import { removeDir } from './support.ts';

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), 'optchat-agent-'));

const CONTRACT = 'Goal: rename foo to bar\nAcceptance: tests pass\nEvidence: npm test output\nAuthority: local commits only, no push';
const common = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

function crewWith(projects: Record<string, [string, string]>) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-prefix-'));
  const crew = new Crew(join(dir, 'crew'), { compress: async input => input.source.slice(0, 100) });
  for (const [slug, [charter, memory]] of Object.entries(projects)) { crew.write(slug, 'charter', charter); crew.write(slug, 'memory', memory); }
  return { dir, crew };
}

test('briefs of one project share everything up to its specialist view whatever the kind, peer or contract; they differ only after it', async () => {
  const { dir, crew } = crewWith({ harness: ['# Harness charter', '- trap: HARNESS_TRAP'], dentai: ['# DentAI charter', '- trap: DENTAI_TRAP'] });
  try {
    const code = crew.brief('code', 'harness'), hard = crew.brief('hard', 'harness', 'ab12cd34'), plan = crew.brief('plan', 'harness'), mechanical = crew.brief('mechanical', 'harness');
    const end = code.indexOf(RUN_MARK);
    assert.ok(end > code.indexOf('</specialist-memory>'), 'the run\'s own part follows the project memory');
    assert.ok(code.slice(0, end).includes('HARNESS_TRAP') && code.slice(0, end).includes('data, not instructions'), 'the project\'s charter, memory and view are in the shared part');
    for (const other of [hard, plan, mechanical]) {
      assert.equal(other.slice(0, other.indexOf(RUN_MARK)), code.slice(0, end), 'the part before the run mark is identical');
      assert.ok(common(code, other) >= end, `kind, plan and peer text come after the shared part (differ at ${common(code, other)}, shared part ends at ${end})`);
    }
    assert.match(hard.slice(end), /You are a hard worker[\s\S]*paired with worker ab12cd34/);
    assert.match(plan.slice(end), /You are a plan worker[\s\S]*You are a scout/);
    assert.doesNotMatch(code.slice(0, end), /You are a (code|hard|plan|mechanical) worker|paired with worker|You are a scout/, 'no kind or peer text before the mark');
    // Another project shares the constant opening (intro and report rules) and diverges at its own charter.
    const dentai = crew.brief('code', 'dentai');
    assert.ok(common(code, dentai) >= code.indexOf('<project-charter'), `projects share the constant opening (differ at ${common(code, dentai)})`);
    assert.match(code, /^\[Worker brief\] You are a worker of the manager/);
    assert.match(code, /Report: lead with the outcome[\s\S]*## Memory proposal[\s\S]*<project-charter/, 'report rules come before the project\'s data');
    assert.doesNotMatch(code.slice(0, code.indexOf('<project-charter')), /harness/i, 'the constant opening names no project');
    assert.doesNotMatch(crew.brief('code', undefined), /Memory proposal|project-memory/);
  } finally { await crew.closeAll(); removeDir(dir); }
});

const tool = (name: string, mark = false) => ({ name, description: name, input_schema: { type: 'object' }, ...(mark ? { cache_control: { type: 'ephemeral' } } : {}) });
const request = (brief: string, task: string, identity = false) => ({
  model: 'claude-sonnet-5-5', tools: [tool('bash'), tool('read', true)],
  system: [...(identity ? [{ type: 'text', text: 'You are Claude Code', cache_control: { type: 'ephemeral' } }] : []), { type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: `${brief}${RUN_MARK}You are a code worker.\n\nYour task:\n${task}`, cache_control: { type: 'ephemeral' } }] }],
});
const marks = (payload: any) => [...payload.tools, ...payload.system, ...payload.messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : [])].filter((b: any) => b.cache_control).length;

test('markBriefPrefix marks the end of the brief, so a second worker with another contract reads it from the cache; the request stays within four marks', () => {
  const brief = '[Worker brief] constant\n\n<project-charter project="x">\ncharter\n</project-charter>';
  for (const identity of [false, true]) {
    const a = markBriefPrefix(request(brief, 'task A', identity)) as any, b = markBriefPrefix(request(brief, 'task B', identity)) as any;
    for (const payload of [a, b]) {
      const content = payload.messages[0].content;
      assert.equal(content.length, 2, 'the first message is the brief, then the run\'s part');
      assert.deepEqual(content[0], { type: 'text', text: brief, cache_control: { type: 'ephemeral' } });
      assert.ok(content[1].text.startsWith(RUN_MARK) && content[1].cache_control, 'the last block keeps its mark');
      assert.ok(marks(payload) <= 4, `${marks(payload)} marks (identity block ${identity})`);
    }
    assert.deepEqual(a.messages[0].content[0], b.messages[0].content[0], 'the marked block is identical for both workers');
    assert.notDeepEqual(a.messages[0].content[1], b.messages[0].content[1]);
    assert.equal(a.messages[0].content.map((x: any) => x.text).join(''), request(brief, 'task A').messages[0].content[0].text, 'no text is lost');
  }
});

test('markBriefPrefix leaves a request without a brief, without marks or with a string message alone or well formed', () => {
  const plain = { model: 'm', system: [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
  assert.deepEqual(markBriefPrefix(structuredClone(plain)), plain, 'a request that is not a worker\'s');
  const off = request('[Worker brief] x', 't');
  const bare = JSON.parse(JSON.stringify(off, (key, value) => key === 'cache_control' ? undefined : value));
  assert.deepEqual(markBriefPrefix(structuredClone(bare)), bare, 'caching off: nothing to add');
  const text = { ...request('[Worker brief] x', 't'), messages: [{ role: 'user', content: `[Worker brief] x${RUN_MARK}rest` }] };
  assert.equal((markBriefPrefix(text) as any).messages[0].content.length, 2, 'a plain string message splits too');
  assert.equal(markBriefPrefix(undefined), undefined);
  assert.equal(markBriefPrefix('x'), 'x');
});

/** A Children over a synthetic provider that records each run's system sections and first user message. */
async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-prefix-run-'));
  const memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
  const seen = new Map<string, { sections: Record<string, string>; user: string }>();
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false });
  const model = (id: string) => ({ id, name: id, reasoning: false, input: ['text' as const], cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 100000, maxTokens: 1000 });
  runtime.registerProvider('optchat-test', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions' as const, models: ['child', 'worker'].map(model),
    streamSimple(m: { id: string; api: string; provider: string }, context: { messages: { role: string; content: unknown; sections?: Record<string, string> }[] }) {
      const stream = createAssistantMessageEventStream();
      const user = textContent(context.messages.find(x => x.role === 'user')?.content);
      const head = context.messages.find(x => x.role === 'system');
      seen.set(user.split('Your task:\n').at(-1)!, { sections: { ...(head?.sections ?? {}) }, user });
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }], api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      void Promise.resolve().then(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  } as never);
  const clock = { offset: 0, now() { return Date.now() + this.offset; }, setTimer: (run: () => void, ms: number) => setTimeout(run, ms), clearTimer: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  const crew = new Crew(join(dir, 'crew'), { compress: async input => input.source.slice(0, 100) });
  const children = new Children(memory, new ModelRegistry(runtime), () => ({ provider: 'optchat-test', model: 'child', thinking: 'minimal' }), () => '# profile\n\n## Global rules\nRULES',
    async () => {}, () => {}, dir, { route: () => ({ provider: 'optchat-test', model: 'worker', thinking: 'minimal' }), crew, clock,
      settings: () => ({ subagentLevels: 2, maxAgents: 8, memorySearch: false }) as never, createSession: options => createAgentSession({ ...options, modelRuntime: runtime }) });
  const finish = async (...ids: string[]) => { for (const id of ids) await (children as any).running.get(id)?.completion; };
  return { seen, children, clock, finish, dir, close: async () => { await children.close(); await crew.closeAll(); await memory.close(); removeDir(dir); } };
}

test('workers of one project in different working directories get one system prompt; the directory moves to their first message', async () => {
  const { seen, children, finish, dir, close } = await harness();
  try {
    for (const name of ['wt-a', 'wt-b']) { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, 'AGENTS.md'), '# Project rules\nSAME_RULES'); }
    const a = join(dir, 'wt-a'), b = join(dir, 'wt-b');
    const [first, second] = await children.spawn([{ task: `${CONTRACT}\nA`, kind: 'code', project: 'harness', cwd: a }, { task: `${CONTRACT}\nB`, kind: 'code', project: 'harness', cwd: b }], dir);
    await finish(first, second);
    const one = seen.get(`${CONTRACT}\nA`)!, two = seen.get(`${CONTRACT}\nB`)!;
    assert.ok(one.sections.project_context?.includes('SAME_RULES'), `the project's AGENTS.md is in the prompt: ${Object.keys(one.sections)}`);
    assert.deepEqual(one.sections, two.sections, 'the system prompt is the same in both directories');
    const system = Object.values(one.sections).join('\n');
    assert.ok(!system.includes('wt-a') && !system.includes(dir.replace(/\\/g, '/')), 'no working directory path in the system prompt');
    assert.match(one.user, new RegExp(`Working directory: ${a.replace(/\\/g, '/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
    assert.match(two.user, /Working directory: .*wt-b\n/);
    assert.ok(one.user.indexOf(RUN_MARK) < one.user.indexOf('Working directory:'), 'the directory is in the run\'s own part');
  } finally { await close(); }
});

test('a contract spawn in a project and directory whose worker finished within 24 h names that run and says tell resumes it', async () => {
  const { children, clock, finish, dir, close } = await harness();
  try {
    const work = join(dir, 'wt-x'), other = join(dir, 'wt-y'); mkdirSync(work); mkdirSync(other);
    const [first] = await children.spawn([{ task: `${CONTRACT}\nfirst`, kind: 'code', project: 'harness', cwd: work }], dir);
    await finish(first);
    const again = await children.start([{ task: `${CONTRACT}\nsecond`, kind: 'code', project: 'harness', cwd: work }], dir);
    assert.match(again, /^Started: \w+\./, 'the spawn still starts');
    assert.match(again, new RegExp(`${first} finished .* in this project and directory.*tell ${first}`), again);
    const elsewhere = await children.start([{ task: `${CONTRACT}\nthird`, kind: 'code', project: 'harness', cwd: other }], dir);
    assert.doesNotMatch(elsewhere, /tell /, 'another directory: no hint');
    const plain = await children.start([{ task: 'plain, no kind', cwd: work }], dir);
    assert.doesNotMatch(plain, /tell /, 'a plain subagent: no hint');
    for (const live of (children as any).running.values()) await live.completion;
    clock.offset = 25 * 3_600_000;
    const late = await children.start([{ task: `${CONTRACT}\nfourth`, kind: 'code', project: 'harness', cwd: work }], dir);
    assert.doesNotMatch(late, /tell /, 'older than 24 h: no hint');
  } finally { await close(); }
});

test('the manager doc keeps up to one PR in one repo with the manager and sends follow-ups back to the worker with tell', () => {
  assert.match(MANAGER_DOC, /Work up to one PR in one repo stays with you\. Workers only for batches of independent fixes in parallel \(own worktrees\) or long suites\/investigations/);
  assert.doesNotMatch(MANAGER_DOC, /Small work stays|short one-file fix|missions\.md|Audit each project memory weekly/);
  assert.doesNotMatch(MANAGER_DOC, /Quick reads \(about 5 read-only commands\)/);
  assert.match(MANAGER_DOC, /Follow-ups[^\n]*review findings[^\n]*red CI[^\n]*added requirement[^\n]*tell <id>[^\n]*never a new spawn/);
  assert.match(MANAGER_DOC, /new prompt cache/);
});

test('relativeContext writes the instruction files inside the working directory relative to it and leaves the others', () => {
  const files = [{ path: "C:/repo/.worktrees/a/AGENTS.md", content: "x" }, { path: "C:/repo/.worktrees/a/sub/AGENTS.md", content: "y" }, { path: "C:/Users/me/.pi/agent/AGENTS.md", content: "z" }, { path: "C:/repo/.worktrees/ab/AGENTS.md", content: "w" }];
  assert.deepEqual(relativeContext([{ path: 'C:\\repo\\.worktrees\\a\\AGENTS.md' }], 'C:\\repo\\.worktrees\\a'), [{ path: 'AGENTS.md' }], 'Windows separators');
  assert.deepEqual(relativeContext(files, "c:/repo/.worktrees/a/").map(file => file.path), ["AGENTS.md", "sub/AGENTS.md", "C:/Users/me/.pi/agent/AGENTS.md", "C:/repo/.worktrees/ab/AGENTS.md"]);
});
