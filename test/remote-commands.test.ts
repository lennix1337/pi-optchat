import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REMOTE_COMMANDS, homeStatus, remoteCommand, type CommandState } from '../src/remote-commands.ts';
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
const state = (over: Partial<CommandState> = {}): CommandState => ({
  model: () => 'anthropic-account-2/claude-sonnet-5-5', activity: () => '\u2705 *Livre*', failover: () => FAILOVER, now: () => NOW, ...over,
});

test('only a whole-word message is a command; a question or a sentence stays with the agent', () => {
  for (const text of ['status', 'Status', ' /cota ', '!modelo', 'Jarvis status', 'jarvis, comandos', 'ajuda']) assert.ok(remoteCommand(text), text);
  for (const text of ['status?', 'qual o status do deploy', 'cota da openai', '', 'statuss']) assert.equal(remoteCommand(text), undefined, text);
});

test('cota lists each account from the cached pi-multi-account state, including exhausted and unmeasured ones', () => {
  const text = remoteCommand('cota')!.run(state());
  assert.match(text, /anthropic-account-2: 42% usado/);
  assert.match(text, /openai-codex: \*esgotada\*/);
  assert.match(text, /anthropic: sem medição/);
  assert.match(remoteCommand('cota')!.run(state({ failover: () => ({}) })), /sem leitura de cota/);
});

test('status and modelo name the selected model, i.e. the account, and the last switch', () => {
  const text = remoteCommand('status')!.run(state());
  assert.match(text, /Livre/);
  assert.match(text, /anthropic-account-2\/claude-sonnet-5-5/);
  assert.match(text, /última troca: anthropic-account-2\/claude-sonnet-5-5/);
  assert.match(remoteCommand('modelo')!.run(state({ model: () => undefined })), /nenhum selecionado/);
  assert.equal(REMOTE_COMMANDS.filter(c => remoteCommand(c.name) === c).length, REMOTE_COMMANDS.length);
  assert.match(homeStatus(state()), /42% usado/);
});

test('a command DM is answered by the bridge without reaching the agent; other DMs still do', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'remote-commands-'));
  const agent: string[] = [], posts: { path: string; body: any }[] = [];
  const inbox = [
    { seq: 1, ts: '1.0', thread: null, text: 'cota' },
    { seq: 2, ts: '2.0', thread: null, text: 'cota da openai acabou?' },
    { seq: 3, ts: '3.0', thread: null, text: 'status', channelName: 'harness' },
  ];
  const bridge = new SlackBridge({ sendUserMessage: ((text: string) => { agent.push(text); }) as never }, () => ({ dir, name: 'p' }), {
    now: () => NOW, model: () => 'anthropic-account-2/claude-sonnet-5-5', failover: () => FAILOVER,
    request: async (_o, path, body) => {
      posts.push({ path, body });
      if (path.startsWith('/v1/slack/inbox')) return { messages: inbox };
      return { parts: 1, ts: '9.9' };
    },
  });
  try {
    await bridge.poll();
    assert.deepEqual(agent.map(t => t.split('\n')[0]), ['[Slack] cota da openai acabou?', '[Slack #harness] status'], 'a channel message is never taken as a command');
    const reply = posts.find(p => p.path === '/v1/slack/send')!;
    assert.match(reply.body.text, /anthropic-account-2: 42% usado/);
    assert.equal(reply.body.channel, undefined, 'the answer goes to the DM');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'slack-cursor.json'), 'utf8')), { seq: 3 });
    bridge.sawUserMessage('[Slack] cota da openai acabou?');
    const home = posts.findLast(p => p.path === '/v1/slack/home')!;
    assert.match(home.body.text, /Trabalhando/);
    assert.match(home.body.text, /Modelo:\* anthropic-account-2\/claude-sonnet-5-5/);
    assert.match(home.body.text, /42% usado/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
