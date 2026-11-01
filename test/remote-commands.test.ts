import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMOTE_COMMANDS, homeStatus, remoteCommand, resolveModel, type CommandState, type ModelRef } from '../src/remote-commands.ts';
import { SlackBridge } from '../src/slack-bridge.ts';

const NOW = Date.UTC(2026, 10, 1, 18, 0);
const FAILOVER = {
  usageByProvider: {
    'anthropic-account-2': { primary: { usedPercent: 42, resetAt: NOW + 3_600_000 } },
    'openai-codex': { primary: { usedPercent: 100, resetAt: NOW + 7_200_000 } },
    anthropic: { plan: 'api-key' },
  },
  lastSwitches: [{ from: 'anthropic/claude-opus-5-5', to: 'anthropic-account-2/claude-sonnet-5-5', at: NOW - 60_000 }],
};
const MODELS: ModelRef[] = [
  { provider: 'anthropic-account-2', id: 'claude-sonnet-5-5' }, { provider: 'anthropic-account-2', id: 'claude-opus-5-5' },
  { provider: 'anthropic-account-2', id: 'claude-haiku-5-5' }, { provider: 'anthropic', id: 'claude-opus-5-5' },
  { provider: 'openai-codex', id: 'gpt-6.1-sol' },
];
const state = (over: Partial<CommandState> = {}): CommandState => ({
  model: () => 'anthropic-account-2/claude-sonnet-5-5', activity: () => '\u2705 *Livre*', failover: () => FAILOVER, now: () => NOW,
  models: () => MODELS, select: async () => true, ...over,
});
const run = async (text: string, s = state()) => { const c = remoteCommand(text)!; return c.command.run(s, c.arg); };

test('only a whole-word message is a command; a question or a sentence stays with the agent', () => {
  for (const text of ['status', 'Status', ' /cota ', '!modelo', 'Jarvis status', 'jarvis, comandos', 'ajuda', 'modelo opus', 'modelos']) assert.ok(remoteCommand(text), text);
  for (const text of ['status?', 'qual o status do deploy', 'cota da openai', 'status agora', '', 'statuss']) assert.equal(remoteCommand(text), undefined, text);
});

test('cota lists each account from the cached pi-multi-account state, including exhausted and unmeasured ones', async () => {
  const { text } = await run('cota');
  assert.match(text, /anthropic-account-2: 42% usado/);
  assert.match(text, /openai-codex: \*esgotada\*/);
  assert.match(text, /anthropic: sem medição/);
  assert.match((await run('cota', state({ failover: () => ({}) }))).text, /sem leitura de cota/);
});

test('status and modelo name the selected model, i.e. the account, and the last switch', async () => {
  const { text } = await run('status');
  assert.match(text, /Livre/);
  assert.match(text, /anthropic-account-2\/claude-sonnet-5-5/);
  assert.match(text, /última troca: anthropic-account-2\/claude-sonnet-5-5/);
  assert.match((await run('modelo', state({ model: () => undefined }))).text, /nenhum selecionado/);
  assert.equal(REMOTE_COMMANDS.filter(c => remoteCommand(c.name)?.command === c).length, REMOTE_COMMANDS.length);
  assert.match(homeStatus(state()), /42% usado/);
  assert.match((await run('modelos')).text, /\*openai-codex\*: gpt-6\.1-sol/);
});

test('a model name resolves on the current account first, then anywhere; ambiguity is said, never guessed', () => {
  const cur = 'anthropic-account-2/claude-sonnet-5-5';
  assert.deepEqual(resolveModel('opus', MODELS, cur), { provider: 'anthropic-account-2', id: 'claude-opus-5-5' });
  assert.deepEqual(resolveModel('anthropic/claude-opus-5-5', MODELS, cur), { provider: 'anthropic', id: 'claude-opus-5-5' });
  assert.deepEqual(resolveModel('gpt', MODELS, cur), { provider: 'openai-codex', id: 'gpt-6.1-sol' });
  assert.match(resolveModel('claude', MODELS, cur) as string, /vários modelos desta conta/);
  assert.match(resolveModel('gemini', MODELS, cur) as string, /Nenhum modelo/);
});

test('a model on the same account switches at once; another account only after approval', async () => {
  const selected: ModelRef[] = [];
  const s = state({ select: async m => { selected.push(m); return true; } });
  const same = await run('modelo opus', s);
  assert.match(same.text, /trocado para \*anthropic-account-2\/claude-opus-5-5\*/);
  assert.equal(same.confirm, undefined);
  const other = await run('modelo gpt', s);
  assert.ok(other.confirm, 'an account switch waits for the operator');
  assert.equal(selected.length, 1, 'nothing switched before approval');
  assert.match(await other.confirm!.apply(), /gpt-6\.1-sol/);
  assert.equal(selected.length, 2);
  assert.match((await run('modelo sonnet', s)).text, /Já estou/);
});

function bridgeFixture(inbox: { seq: number; ts: string; thread: string | null; text: string; channelName?: string }[], selected: ModelRef[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'remote-commands-'));
  const agent: string[] = [], posts: { path: string; body: any }[] = [];
  let ts = 0;
  const bridge = new SlackBridge({ sendUserMessage: ((text: string) => { agent.push(text); }) as never }, () => ({ dir, name: 'p' }), {
    now: () => NOW, model: () => 'anthropic-account-2/claude-sonnet-5-5', failover: () => FAILOVER, models: () => MODELS,
    select: async m => { selected.push(m); return true; }, schedule: () => {},
    request: async (_o, path, body) => {
      posts.push({ path, body });
      if (path.startsWith('/v1/slack/inbox')) { const after = Number(new URLSearchParams(path.split('?')[1]).get('after')); return { messages: inbox.filter(m => m.seq > after) }; }
      return { parts: 1, ts: `9.${++ts}`, channel: 'D1' };
    },
  });
  return { dir, agent, posts, bridge, inbox, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a command DM is answered by the bridge without reaching the agent; other DMs still do', async () => {
  const f = bridgeFixture([
    { seq: 1, ts: '1.0', thread: null, text: 'cota' },
    { seq: 2, ts: '2.0', thread: null, text: 'cota da openai acabou?' },
    { seq: 3, ts: '3.0', thread: null, text: 'status', channelName: 'harness' },
  ]);
  try {
    await f.bridge.poll();
    assert.deepEqual(f.agent.map(t => t.split('\n')[0]), ['[Slack] cota da openai acabou?', '[Slack #harness] status'], 'a channel message is never taken as a command');
    const reply = f.posts.find(p => p.path === '/v1/slack/send')!;
    assert.match(reply.body.text, /anthropic-account-2: 42% usado/);
    assert.equal(reply.body.channel, undefined, 'the answer goes to the DM');
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'slack-cursor.json'), 'utf8')), { seq: 3 });
    f.bridge.sawUserMessage('[Slack] cota da openai acabou?');
    const home = f.posts.findLast(p => p.path === '/v1/slack/home')!;
    assert.match(home.body.text, /Trabalhando/);
    assert.match(home.body.text, /Modelo:\* anthropic-account-2\/claude-sonnet-5-5/);
    assert.match(home.body.text, /42% usado/);
  } finally { f.close(); }
});

test('an account switch from Slack posts Aprovar/Negar and switches only on approval, without telling the agent to rerun anything', async () => {
  const selected: ModelRef[] = [];
  const f = bridgeFixture([{ seq: 1, ts: '1.0', thread: null, text: 'modelo gpt' }], selected);
  try {
    await f.bridge.poll();
    const ask = f.posts.find(p => p.path === '/v1/slack/send')!;
    assert.equal(ask.body.approval, true);
    assert.match(ask.body.text, /muda a conta/);
    assert.equal(selected.length, 0);
    f.inbox.push({ seq: 2, ts: '2.0', thread: '9.1', text: 'aprovar' });
    await f.bridge.poll();
    assert.deepEqual(selected, [{ provider: 'openai-codex', id: 'gpt-6.1-sol' }]);
    assert.ok(f.posts.some(p => p.path === '/v1/slack/send' && /trocado para \*openai-codex\/gpt-6\.1-sol\*/.test(p.body.text)));
    assert.deepEqual(f.agent, [], 'the agent gets no "rerun the call" note for a command');
    f.inbox.push({ seq: 3, ts: '3.0', thread: '9.1', text: 'aprovar' });
    await f.bridge.poll();
    assert.equal(selected.length, 1, 'one approval switches once');
  } finally { f.close(); }
});

test('when the Aprovar post cannot go out, the operator is told nothing changed instead of silence', async () => {
  const selected: ModelRef[] = [];
  const f = bridgeFixture([{ seq: 1, ts: '1.0', thread: null, text: 'modelo gpt' }], selected);
  const request = (f.bridge as any).options.request;
  (f.bridge as any).options.request = async (o: unknown, path: string, body: any) => {
    if (path === '/v1/slack/send' && body?.approval) throw new Error('HTTP 500');
    return request(o, path, body);
  };
  try {
    await f.bridge.poll();
    const replies = f.posts.filter(p => p.path === '/v1/slack/send');
    assert.equal(replies.length, 1);
    assert.match(replies[0]!.body.text, /Não consegui postar o Aprovar/);
    assert.equal(selected.length, 0);
  } finally { f.close(); }
});
