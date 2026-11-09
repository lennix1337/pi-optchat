import assert from 'node:assert/strict';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { MCP_NOTICE_TYPE, McpFileSync, registerLiveResources, watchFile } from '../src/live-resources.ts';
import { tempDir } from './support.ts';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (done: () => boolean) => { for (let i = 0; i < 100 && !done(); i++) await wait(20); };
const servers = (value: Record<string, unknown>) => JSON.stringify({ mcpServers: value });
const stdio = (command: string, extra: Record<string, unknown> = {}) => ({ command, args: ['-y', 'pkg'], ...extra });

function syncOf(initial: Record<string, unknown> | string) {
  const t = tempDir('live-mcp-');
  const file = join(t.dir, 'mcp.json');
  writeFileSync(file, typeof initial === 'string' ? initial : servers(initial));
  const calls: string[] = [], notes: string[] = [];
  const sync = new McpFileSync(file, {
    register: (name, config) => { if (config.broken) throw new Error('command must be a string'); calls.push(`register ${name} ${JSON.stringify(config)}`); },
    unregister: name => calls.push(`unregister ${name}`),
  }, line => notes.push(line));
  sync.baseline();
  return { ...t, file, sync, calls, notes, write: (value: Record<string, unknown> | string) => writeFileSync(file, typeof value === 'string' ? value : servers(value)) };
}

test('a server added to mcp.json is registered, once, and announced by name only', () => {
  const t = syncOf({ plane: stdio('npx') });
  t.write({ plane: stdio('npx'), tavily: stdio('npx', { env: { KEY: 'sk-secret-value' } }) });
  t.sync.check(); t.sync.check();
  assert.deepEqual(t.calls, [`register tavily ${JSON.stringify(stdio('npx', { env: { KEY: 'sk-secret-value' } }))}`], 'the startup server is left to Pi, and a second look changes nothing');
  assert.deepEqual(t.notes, ['MCP servers in mcp.json: added tavily.']);
  assert.doesNotMatch(t.notes.join(), /secret|npx|KEY/);
  t.close();
});

test('a server this session registered is replaced when its config changes and unregistered when it is removed', () => {
  const t = syncOf({});
  t.write({ a: stdio('one') }); t.sync.check();
  t.write({ a: stdio('two') }); t.sync.check();
  t.write({ a: { args: ['-y', 'pkg'], command: 'two' } }); t.sync.check();
  t.write({}); t.sync.check();
  assert.deepEqual(t.calls, [`register a ${JSON.stringify(stdio('one'))}`, `register a ${JSON.stringify(stdio('two'))}`, 'unregister a'], 'reordered keys are no change');
  assert.deepEqual(t.notes, ['MCP servers in mcp.json: added a.', 'MCP servers in mcp.json: changed a.', 'MCP servers in mcp.json: removed a.']);
  t.close();
});

test('a server Pi loaded at startup cannot be changed or dropped by an extension, so the notice says /reload', () => {
  const t = syncOf({ plane: stdio('npx'), sentry: stdio('npx') });
  t.write({ plane: stdio('other') }); t.sync.check();
  assert.deepEqual(t.calls, [], 'registering over mcp.json is ignored by Pi, and unregistering a name it does not own does nothing');
  assert.match(t.notes[0]!, /plane, sentry changed but was loaded at session start, so \/reload applies it/);
  t.write({ plane: stdio('npx'), sentry: stdio('npx') }); t.sync.check();
  assert.equal(t.notes.length, 1, 'back to the loaded config: nothing to apply');
  t.close();
});

test('invalid, empty or missing mcp.json is ignored, and the next valid write is applied', () => {
  const t = syncOf({ plane: stdio('npx') });
  for (const bad of ['', '{"mcpServers": {"x": {"comm', '[]', '{"mcpServers": []}', 'null']) { t.write(bad); assert.doesNotThrow(() => t.sync.check()); }
  renameSync(t.file, `${t.file}.old`);
  assert.doesNotThrow(() => t.sync.check());
  assert.deepEqual([t.calls, t.notes], [[], []], 'a half-written file must not drop the servers it had');
  t.write({ plane: stdio('npx'), extra: stdio('node') }); t.sync.check();
  assert.deepEqual(t.calls, [`register extra ${JSON.stringify(stdio('node'))}`]);
  t.close();
});

test('a config Pi rejects is reported without stopping the others, and not retried until it changes', () => {
  const t = syncOf({});
  t.write({ bad: { broken: true }, good: stdio('node') });
  t.sync.check(); t.sync.check();
  assert.deepEqual(t.calls, [`register good ${JSON.stringify(stdio('node'))}`]);
  assert.deepEqual(t.notes, ['MCP servers in mcp.json: added good; rejected bad (command must be a string).']);
  t.write({ good: stdio('node') }); t.sync.check();
  assert.equal(t.notes.length, 1, 'removing a server that never registered says nothing and unregisters nothing');
  t.close();
});

test('a burst of writes is one look, and an atomic replace is noticed', async () => {
  const t = tempDir('live-watch-');
  const file = join(t.dir, 'mcp.json');
  writeFileSync(file, servers({}));
  let looks = 0;
  const stop = watchFile(file, () => { looks++; }, 80);
  try {
    await wait(50);
    for (let i = 0; i < 5; i++) { writeFileSync(file, servers({ [`s${i}`]: stdio('x') })); await wait(10); }
    writeFileSync(join(t.dir, 'other.json'), '{}');
    await until(() => looks > 0); await wait(250);
    assert.equal(looks, 1, 'five writes inside the debounce window make one look');
    writeFileSync(`${file}.tmp`, servers({ replaced: stdio('x') }));
    renameSync(`${file}.tmp`, file);
    await until(() => looks > 1); await wait(250);
    assert.equal(looks, 2, 'write-to-temp then rename is a change of mcp.json');
  } finally { stop(); }
  const before = looks;
  writeFileSync(file, servers({ late: stdio('x') })); await wait(250);
  assert.equal(looks, before, 'a stopped watcher stays quiet');
  t.close();
});

function fakeSession(agentDir: string, skills: { name: string; path: string }[] = []) {
  const handlers = new Map<string, Function>(), tools = new Map<string, any>(), calls: string[] = [], notes: string[] = [];
  const pi = {
    on: (event: string, fn: Function) => handlers.set(event, fn),
    registerTool: (definition: any) => tools.set(definition.name, definition),
    registerMcpServer: (name: string) => calls.push(`register ${name}`),
    unregisterMcpServer: (name: string) => calls.push(`unregister ${name}`),
    getCommands: () => skills.map(skill => ({ name: `skill:${skill.name}`, source: 'skill', sourceInfo: { path: skill.path } })),
  } as unknown as ExtensionAPI;
  const ctx = { cwd: agentDir, ui: { notify: (text: string) => notes.push(text) } } as unknown as ExtensionContext;
  return { handlers, tools, calls, notes, pi, ctx };
}

test('the session registers a server written after startup, tells the operator and the agent, and stops at shutdown', async () => {
  const t = tempDir('live-session-');
  const file = join(t.dir, 'mcp.json');
  writeFileSync(file, servers({}));
  const s = fakeSession(t.dir);
  registerLiveResources(s.pi, { agentDir: t.dir, debounceMs: 40 });
  await s.handlers.get('session_start')!({ reason: 'startup' }, s.ctx);
  assert.equal(s.handlers.get('before_agent_start')!(), undefined, 'nothing to say yet');
  writeFileSync(file, servers({ fresh: stdio('node') }));
  await until(() => s.calls.length > 0);
  assert.deepEqual(s.calls, ['register fresh']);
  assert.deepEqual(s.notes, ['MCP servers in mcp.json: added fresh.']);
  const message = s.handlers.get('before_agent_start')!();
  assert.deepEqual(message, { message: { customType: MCP_NOTICE_TYPE, content: 'MCP servers in mcp.json: added fresh.', display: false } });
  assert.equal(s.handlers.get('before_agent_start')!(), undefined, 'said once');
  s.handlers.get('session_shutdown')!();
  writeFileSync(file, servers({ fresh: stdio('node'), later: stdio('node') })); await wait(200);
  assert.deepEqual(s.calls, ['register fresh'], 'no watching after shutdown');
  t.close();
});

test('a skill created mid-session is listed, then loaded by name, without the system prompt', async () => {
  const t = tempDir('live-skills-');
  const agentDir = join(t.dir, 'agent'), skills = join(agentDir, 'skills');
  const write = (name: string, description: string, body: string) => {
    mkdirSync(join(skills, name), { recursive: true });
    writeFileSync(join(skills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  };
  write('old', 'Loaded at startup', 'old body');
  const s = fakeSession(agentDir, [{ name: 'old', path: join(skills, 'old', 'SKILL.md') }]);
  registerLiveResources(s.pi, { agentDir });
  const tool = s.tools.get('skills_on_disk');
  assert.equal(tool.exposure, 'deferred', 'costs nothing in the prompt until needed');
  const run = async (args: object) => tool.execute('id', args, undefined, undefined, s.ctx);
  assert.equal((await run({})).content[0].text, 'No skill on disk is missing from this session.');

  write('fresh', 'Made after startup', 'Do the fresh thing.\nSecond line.');
  const listed = (await run({})).content[0].text;
  assert.match(listed, /^- fresh: Made after startup \(.*SKILL\.md\)$/);
  assert.doesNotMatch(listed, /old/, 'a loaded skill is not listed');
  const loaded = await run({ name: 'fresh' });
  assert.match(loaded.content[0].text, /^<skill name="fresh" location=".*SKILL\.md">\nReferences are relative to .*fresh\.\n\nDo the fresh thing\.\nSecond line\.\n<\/skill>$/);
  assert.doesNotMatch(loaded.content[0].text, /description:/, 'frontmatter is not part of the body');
  const missing = await run({ name: 'nope' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /No skill named "nope"/);
  t.close();
});
