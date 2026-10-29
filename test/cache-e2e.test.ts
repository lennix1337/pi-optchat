import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import optchat from '../src/index.ts';
import { createProfile, loadConfig, profilePath, saveConfig } from '../src/profiles.ts';
import { emptyUsage } from '../src/usage.ts';
import { removeDir } from './support.ts';

// End to end: a real Pi session with OptChat, Pi's own Anthropic transport, and a local server that keeps Anthropic's prompt
// cache rules (entries at marked blocks, a 20-block lookback, at most 4 marks, 1-hour marks before 5-minute ones).
const root = mkdtempSync(join(tmpdir(), 'oc-cache-'));
const oldHome = process.env.OPTCHAT_HOME;
process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
process.env.OPTCHAT_HOME = join(root, 'home');
after(() => {
  if (oldHome === undefined) delete process.env.OPTCHAT_HOME; else process.env.OPTCHAT_HOME = oldHome;
  removeDir(root);
});

type Block = Record<string, unknown>;
interface Usage { read: number; write: number; input: number; marks: number; tools: string; status: number; error?: string; body?: string }
const tokens = (block: Block) => Math.ceil(JSON.stringify(block).length / 4);
/** Anthropic's prompt cache as documented: tools, then system, then messages, block by block. */
class SimulatedCache {
  private readonly entries = new Set<string>();
  readonly requests: Usage[] = [];
  answer(body: Record<string, unknown>): Usage {
    const blocks: { block: Block; mark?: { ttl?: string } }[] = [];
    const add = (block: Block) => {
      const { cache_control, ...rest } = block as Block & { cache_control?: { ttl?: string } };
      blocks.push({ block: rest, ...(cache_control ? { mark: cache_control } : {}) });
    };
    for (const tool of (body.tools ?? []) as Block[]) add(tool);
    for (const block of (body.system ?? []) as Block[]) add(block);
    for (const message of body.messages as { role: string; content: string | Block[] }[])
      for (const block of typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content) add({ role: message.role, ...block });
    if (body.cache_control) blocks.at(-1)!.mark = body.cache_control as { ttl?: string };
    const marks = blocks.flatMap((b, j) => b.mark ? [j] : []);
    const tools = createHash('sha256').update(JSON.stringify(body.tools ?? [])).digest('hex').slice(0, 8);
    const ttls = marks.map(j => blocks[j].mark!.ttl ?? '5m');
    // A rejected request is kept too, so `status !== 200` checks see it and the log says why.
    const fail = (error: string) => {
      const usage = { read: 0, write: 0, input: 0, marks: marks.length, tools, status: 400, error };
      this.requests.push(usage);
      console.error(`simulated Anthropic rejected request ${this.requests.length}: ${error} (marks ${marks.join(',')}, ttls ${ttls.join(',')})`);
      return usage;
    };
    if (marks.length > 4) return fail(`${marks.length} cache_control blocks, limit 4`);
    if (ttls.some((ttl, j) => ttl === '1h' && ttls.slice(0, j).includes('5m'))) return fail('a 1h mark after a 5m mark');
    const chain: string[] = [];
    let digest = String(body.model);
    for (const { block } of blocks) chain.push(digest = createHash('sha256').update(digest).update(JSON.stringify(block)).digest('hex'));
    let found = -1;
    for (const mark of marks) for (let j = mark; j >= Math.max(0, mark - 20); j--) if (this.entries.has(chain[j])) { found = Math.max(found, j); break; }
    for (const mark of marks) this.entries.add(chain[mark]);
    const size = (from: number, to: number) => { let sum = 0; for (const b of blocks.slice(from, to)) sum += tokens(b.block); return sum; };
    const end = marks.length ? marks.at(-1)! + 1 : 0;
    const usage = { read: size(0, found + 1), write: size(found + 1, end), input: size(Math.max(end, found + 1), blocks.length), marks: marks.length, tools, status: 200,
      body: JSON.stringify(body.messages) };
    this.requests.push(usage);
    return usage;
  }
}

/** The scripted model behind the server: one call to `enable_web` when asked, `n` calls to `noop` for "busy n",
 * one `bash` call sleeping `n` seconds for "wait n", one `operational_state` record for "record state", else text. */
function reply(body: { messages: { role: string; content: string | Block[] }[] }): { tool?: string; input?: Record<string, unknown>; text?: string } {
  const blocks = (m: { content: string | Block[] }) => typeof m.content === 'string' ? [{ type: 'text', text: m.content }] as Block[] : m.content;
  const asked = body.messages.findLastIndex(m => m.role === 'user' && blocks(m).some(b => b.type === 'text' && /(enable web|busy \d+|wait \d+|record state|question)\s*$/.test(String(b.text))));
  const prompt = asked < 0 ? '' : blocks(body.messages[asked]).map(b => String(b.text ?? '')).join('');
  const results = body.messages.slice(asked + 1).flatMap(m => blocks(m).filter(b => b.type === 'tool_result')).length;
  if (/enable web\s*$/.test(prompt) && !results) return { tool: 'enable_web' };
  const busy = /busy (\d+)\s*$/.exec(prompt);
  if (busy && results < Number(busy[1])) return { tool: 'noop' };
  const wait = /wait (\d+)\s*$/.exec(prompt);
  if (wait && !results) return { tool: 'bash', input: { command: `sleep ${wait[1]}; echo waited` } };
  if (/record state\s*$/.test(prompt) && !results)
    return { tool: 'operational_state', input: { update: { kind: 'decision', text: 'Recorded mid-turn: keep the cached run.', sourceMessageId: '0' } } };
  return { text: 'OK' };
}

function sse(response: ServerResponse, usage: Usage, answer: ReturnType<typeof reply>, id: number) {
  const send = (event: Record<string, unknown>) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  send({ type: 'message_start', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'claude-sim', content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: usage.input, cache_read_input_tokens: usage.read, cache_creation_input_tokens: usage.write, output_tokens: 1 } } });
  if (answer.tool) {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${id}`, name: answer.tool, input: {} } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(answer.input ?? {}) } });
  } else {
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer.text } });
  }
  send({ type: 'content_block_stop', index: 0 });
  send({ type: 'message_delta', delta: { stop_reason: answer.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
  send({ type: 'message_stop' });
  response.end();
}

async function simulatedAnthropic() {
  const cache = new SimulatedCache();
  let id = 0;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const usage = cache.answer(body);
    if (usage.status !== 200) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: usage.error } }));
      return;
    }
    sse(response, usage, reply(body), ++id);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { cache, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

/** `enable_web` turns on a tool that was registered inactive, as pi-web-access's web_enable does. */
const webTools = (pi: ExtensionAPI) => {
  pi.registerTool({ name: 'web_x', label: 'web', description: 'Search the web. '.repeat(20), parameters: Type.Object({}), defaultActive: false,
    async execute() { return { content: [{ type: 'text', text: 'results' }], details: {} }; } });
  pi.registerTool({ name: 'enable_web', label: 'enable', description: 'Enable web tools.', parameters: Type.Object({}),
    async execute() { pi.setActiveTools([...pi.getActiveTools(), 'web_x']); return { content: [{ type: 'text', text: 'Enabled: web_x' }], details: {} }; } });
  pi.registerTool({ name: 'noop', label: 'noop', description: 'Does nothing.', parameters: Type.Object({}),
    async execute() { return { content: [{ type: 'text', text: 'done' }], details: {} }; } });
};

/** Pi with OptChat and `extra`, talking to `anthropic`; a fixture compactor keeps memory offline. */
async function piSession(anthropic: { url: string }, name: string, extra: (pi: ExtensionAPI) => void) {
  createProfile(name);
  const choice = { provider: 'fixture', model: 'fixture', thinking: 'off' as const };
  saveConfig(profilePath(name), { ...loadConfig(profilePath(name)), compactor: choice, subagent: choice });
  const dir = mkdtempSync(join(root, 's-'));
  const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models.json'), refreshOnCreate: false });
  runtime.registerProvider('fixture', {
    baseUrl: 'https://invalid.local', apiKey: 'synthetic', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
    streamSimple(model) {
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'talk: OK' }], api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), stopReason: 'stop', usage: emptyUsage() };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end(); });
      return stream;
    },
  });
  runtime.registerProvider('anthropic', {
    baseUrl: anthropic.url, apiKey: 'sk-ant-simulated', api: 'anthropic-messages',
    models: [{ id: 'claude-sim', name: 'Claude (simulated)', reasoning: false, input: ['text'], cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000, maxTokens: 1000, compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } }],
  });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: 'off', retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager,
    noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, extensionFactories: [optchat, extra] });
  await loader.reload();
  const manager = SessionManager.create(dir, join(dir, 'sessions'));
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModel('anthropic', 'claude-sim'), resourceLoader: loader, settingsManager, sessionManager: manager });
  session.extensionRunner.setFlagValue('optchat-profile', name);
  const errors: string[] = [];
  await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), notify: () => {} }, mode: 'print', onError: error => { errors.push(error.error); } });
  return { session, errors };
}

test('real Pi + OptChat: /reload with a tool redefined reads the cached head and sends the change after the view', { timeout: 120_000 }, async () => {
  const anthropic = await simulatedAnthropic();
  let version = 'v1';
  // A tool whose definition changes across the reload, as an extension update or an edited AGENTS.md does.
  const docs = (pi: ExtensionAPI) => pi.registerTool({ name: 'docs', label: 'docs', description: `Project docs ${version}. `.repeat(40), parameters: Type.Object({}),
    async execute() { return { content: [{ type: 'text', text: 'docs' }], details: {} }; } });
  const { session, errors } = await piSession(anthropic, 'cache-reload', docs);
  const requests = anthropic.cache.requests;
  try {
    await session.prompt('first question');
    await session.prompt('second question');
    const last = requests.at(-1)!;
    version = 'v2';
    await session.reload();
    assert.ok(session.getActiveToolNames().includes('docs'));
    const from = requests.length;
    await session.prompt('third question');
    const first = requests[from];
    assert.equal(first.tools, last.tools, 'the request keeps the tool list its cache entry was written with');
    assert.ok(first.read > 0, `the first request after /reload read ${first.read} and wrote ${first.write}; the one before it read ${last.read} and wrote ${last.write}`);
    assert.deepEqual(requests.filter(r => r.status !== 200), []);
    assert.deepEqual(errors, []);
    // Every request leaves one line saying how its view compares with the last one's, so a miss in usage.jsonl can be explained.
    const diagnostics = readFileSync(join(profilePath('cache-reload'), 'cache-diagnostics.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(diagnostics.length, requests.length);
    assert.ok(diagnostics.every(d => d.blocks > 0 && Array.isArray(d.marks) && d.model === 'claude-sim' && Number.isFinite(Date.parse(d.date))),
      JSON.stringify(diagnostics));
    assert.ok(diagnostics.some(d => d.changedAt === null), `a later request whose view only grew says so: ${JSON.stringify(diagnostics)}`);
    console.log(JSON.stringify({ e2e: 'reload', before: [last.read, last.write], after: [first.read, first.write] }));
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    await anthropic.close();
  }
});

test('real Pi + OptChat: /reload keeps the view entries, so a turn that grew the view past the marks\' lookback still reads the view cached before it', { timeout: 300_000 }, async () => {
  const anthropic = await simulatedAnthropic();
  const { session, errors } = await piSession(anthropic, 'cache-reload-view', webTools);
  const requests = anthropic.cache.requests;
  try {
    await session.prompt('first question');
    // The first busy turn makes the view long; the second adds its 320 messages as about 80 blocks of lines, past the 20-block
    // lookback of every default mark.
    await session.prompt('now get busy 160');
    const from = requests.length;
    await session.prompt('again get busy 160');
    const start = requests[from];
    await session.reload();
    const after = requests.length;
    await session.prompt('next question');
    const next = requests[after];
    const diagnostics = readFileSync(join(profilePath('cache-reload-view'), 'cache-diagnostics.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    // Side calls (compaction) leave no line: the last two are the busy turn's last call and the one after /reload.
    assert.equal(requests.length, after + 1);
    const [busyView, reloaded] = diagnostics.slice(-2);
    // The view entries the busy turn's start left live for minutes. /reload used to forget them with the rest of OptChat's
    // state, so the next call marked only its last 20 blocks, out of reach of those entries, read tools + system alone and wrote
    // the whole view again (session 01a1704e, 2026-10-26 12:17: read 33022, wrote 78664, marks [91, 111] with the last at 69).
    // Here a side call happens to cache the longer view, so the read alone would not show it: the marks do.
    assert.ok(reloaded.gapMs !== undefined, `the first call after /reload compares its view with the last one: ${JSON.stringify(reloaded)}`);
    assert.ok(reloaded.marks.some((block: number) => block <= Math.max(...busyView.marks)),
      `the first call after /reload marks an entry the busy turn left (${busyView.marks}): ${JSON.stringify(reloaded.marks)}`);
    assert.ok(next.read > start.read + start.write / 2, `after /reload the next turn read ${next.read} and wrote ${next.write}; the busy turn had cached ${start.read} + ${start.write} at its start ` +
      `(diagnostics before /reload ${JSON.stringify(busyView)}, after ${JSON.stringify(reloaded)})`);
    assert.deepEqual(requests.filter(r => r.status !== 200), []);
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    await anthropic.close();
  }
});

test('real Pi + OptChat: an operational_state record mid-turn keeps the cached run; the next turn shows it with the view', { timeout: 120_000 }, async () => {
  const anthropic = await simulatedAnthropic();
  const { session, errors } = await piSession(anthropic, 'cache-state', () => {});
  const requests = anthropic.cache.requests;
  try {
    assert.ok(session.getActiveToolNames().includes('operational_state'));
    await session.prompt('first question');
    let from = requests.length;
    await session.prompt('please record state');
    const turn = requests.slice(from);
    assert.equal(turn.length, 2, 'the operational_state call, then the answer after it');
    const result = session.messages.find(m => m.role === 'toolResult' && m.toolName === 'operational_state');
    assert.ok(result && result.role === 'toolResult' && !result.isError, JSON.stringify(result));
    assert.match(JSON.stringify(result.content), /Recorded mid-turn/, 'the tool result carries the new record into this turn');
    // The record used to be rendered into the message that holds the view, so the turn's whole run after it was written again.
    assert.ok(turn[1].read >= turn[0].read + turn[0].write,
      `after the record the request read ${turn[1].read} of the ${turn[0].read + turn[0].write} tokens cached before it`);
    from = requests.length;
    await session.prompt('next question');
    const messages = JSON.parse(requests[from].body!) as { role: string; content: string | Block[] }[];
    const withView = messages.map(m => typeof m.content === 'string' ? m.content : m.content.map(b => String(b.text ?? '')).join(''))
      .find(text => text.includes('<chat>'));
    assert.match(withView ?? '', /Operational state \(records[\s\S]*Recorded mid-turn/, 'the next turn shows the record after the view');
    assert.deepEqual(requests.filter(r => r.status !== 200), []);
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    await anthropic.close();
  }
});

test('real Pi + OptChat: a foreground sleep in bash is refused before it runs, pointing to shell_start', { timeout: 60_000 }, async () => {
  const anthropic = await simulatedAnthropic();
  const { session, errors } = await piSession(anthropic, 'foreground-wait', () => {});
  try {
    assert.ok(session.getActiveToolNames().includes('shell_start'));
    const started = Date.now();
    await session.prompt('wait 30');
    const result = session.messages.find(m => m.role === 'toolResult' && m.toolName === 'bash');
    assert.ok(result && result.role === 'toolResult' && result.isError, 'the bash call comes back as an error');
    const text = JSON.stringify(result.content);
    assert.match(text, /sleeps 30 s/);
    assert.match(text, /shell_start/);
    assert.doesNotMatch(text, /waited/, 'the command never ran');
    assert.ok(Date.now() - started < 20_000, 'the turn did not wait');
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    await anthropic.close();
  }
});

test('real Pi + OptChat on Anthropic\'s wire: a tool enabled mid-turn and a turn that grows the view by 300+ lines both read the cached prefix', { timeout: 300_000 }, async () => {
  const anthropic = await simulatedAnthropic();
  const { session, errors } = await piSession(anthropic, 'cache-e2e', webTools);
  const requests = anthropic.cache.requests;
  try {
    await session.prompt('first question');
    await session.prompt('second question');
    let from = requests.length;
    await session.prompt('please enable web');
    const enable = requests.slice(from);
    assert.equal(enable.length, 2, 'the tool call, then the answer after it');
    assert.equal(enable[1].tools, enable[0].tools, 'the request\'s tool list stays as it was');
    assert.ok(enable[1].read >= enable[0].read + enable[0].write, `after enable_web the request read ${enable[1].read} of the ${enable[0].read + enable[0].write} tokens cached before it`);
    assert.ok(session.getActiveToolNames().includes('web_x'));
    // Two busy turns of 160 tool calls each (plus the compaction-view calls OptChat makes on the side): the first makes the view
    // long, the second adds its 320 messages to it as 80 blocks of lines, far past a mark's 20-block lookback.
    await session.prompt('now get busy 160');
    from = requests.length;
    await session.prompt('again get busy 160');
    const busy = requests.slice(from);
    assert.ok(busy.length >= 161, `160 tool calls and the answer, plus OptChat's side calls: ${busy.length}`);
    from = requests.length;
    await session.prompt('next question');
    const next = requests[from], start = busy[0];
    // The busy turn's start cached tools, system prompt and the long view. Its 80 new blocks push every mark of the next turn past
    // the 20-block lookback, so without a mark on the remembered entry the next turn reads only tools + system and rewrites the view.
    const cached = start.read + start.write;
    assert.ok(next.read > cached / 2 + start.read / 2, `the next turn read ${next.read} and wrote ${next.write} of the ${cached} the busy turn had cached at its start`);
    assert.deepEqual(requests.filter(r => r.status !== 200), [], 'every request was valid under Anthropic\'s mark rules');
    assert.deepEqual(errors, []);
    const total = requests.reduce((sum, r) => ({ read: sum.read + r.read, write: sum.write + r.write }), { read: 0, write: 0 });
    console.log(JSON.stringify({ e2e: 'cache', requests: requests.length, ...total, enable: enable.map(r => [r.read, r.write]), busyStart: [start.read, start.write], nextTurn: [next.read, next.write] }));
  } finally {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose();
    await anthropic.close();
  }
});
