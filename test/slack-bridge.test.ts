import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { HttpError } from '../src/assistant-client.ts';
import { SLACK_PREFIX, SlackBridge, wakeChannel } from '../src/slack-bridge.ts';

function fixture(inbox: { seq: number; ts: string; thread: string | null; text: string; channelName?: string | null }[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-bridge-'));
  const owner = { dir, name: 'p' };
  const sent: { text: string; options: unknown }[] = [];
  const requests: { path: string; body?: unknown }[] = [];
  let now = 1_000_000;
  let fail: Error | undefined;
  const bridge = new SlackBridge({ sendUserMessage: ((text: string, options: unknown) => { sent.push({ text, options }); }) as never }, () => owner, {
    now: () => now,
    request: async (_owner, path, body) => {
      requests.push({ path, body });
      if (fail) throw fail;
      if (path.startsWith('/v1/slack/inbox')) {
        const after = Number(new URLSearchParams(path.split('?')[1]).get('after'));
        return { messages: inbox.filter(m => m.seq > after) };
      }
      return { parts: 1, ts: '1.1' };
    },
  });
  return { dir, owner, bridge, sent, requests, inbox, advance: (ms: number) => { now += ms; }, fail: (error?: Error) => { fail = error; }, close: () => rmSync(dir, { recursive: true, force: true }) };
}
/** A run's messages: one assistant message per reply text. */
const replies = (...texts: string[]) => texts.map(text => ({ role: 'assistant', content: [{ type: 'text', text }] }) as unknown as AgentMessage);

test('operator DMs become [Slack] user messages in order, once, across restarts', async () => {
  const f = fixture([{ seq: 1, ts: '1.0', thread: null, text: 'como ta o deploy?' }, { seq: 2, ts: '2.0', thread: null, text: 'e o CI?' }]);
  try {
    assert.equal(await f.bridge.poll(), 2);
    assert.deepEqual(f.sent.map(s => s.text), [`${SLACK_PREFIX}como ta o deploy?`, `${SLACK_PREFIX}e o CI?`]);
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'slack-cursor.json'), 'utf8')), { seq: 2 });
    assert.equal(await f.bridge.poll(), 0, 'the cursor keeps a message from arriving twice');
    f.inbox.push({ seq: 3, ts: '3.0', thread: null, text: 'oi' });
    assert.equal(await f.bridge.poll(), 1);
  } finally { f.close(); }
});

test('the final answer of a run that received a Slack message goes back to the DM, in its thread', async () => {
  const f = fixture([{ seq: 1, ts: '5.0', thread: '4.0', text: 'status?' }]);
  try {
    await f.bridge.poll();
    f.bridge.sawUserMessage(`${SLACK_PREFIX}status?`);
    await f.bridge.runEnded(replies('rodando', 'Tudo verde.'));
    const reply = f.requests.find(r => r.path === '/v1/slack/send');
    assert.deepEqual(reply?.body, { text: 'Tudo verde.', threadTs: '4.0' });
  } finally { f.close(); }
});

test('a project channel message is marked with its channel and the run answers in that channel', async () => {
  const f = fixture([{ seq: 1, ts: '7.0', thread: null, text: 'como ta a release?', channelName: 'genexus18mcp' }]);
  try {
    await f.bridge.poll();
    assert.equal(f.sent[0].text, '[Slack #genexus18mcp] como ta a release?');
    f.bridge.sawUserMessage(f.sent[0].text);
    await f.bridge.runEnded(replies('v4.0.5 publicada.'));
    assert.deepEqual(f.requests.find(r => r.path === '/v1/slack/send')?.body, { text: 'v4.0.5 publicada.', threadTs: null, channel: 'genexus18mcp' });
  } finally { f.close(); }
});

test('a DM that arrives mid-run tells the agent to answer with slack_send and keep working, not end the run', async () => {
  const f = fixture([{ seq: 1, ts: '1.0', thread: null, text: 'que horas são?' }, { seq: 2, ts: '2.0', thread: null, text: 'e agora?' }]);
  try {
    await f.bridge.poll();
    assert.equal(f.sent[0].text, `${SLACK_PREFIX}que horas são?`, 'an idle session gets the plain message: the run exists to answer it');
    f.bridge.runStarted();
    await f.bridge.poll();
    f.bridge.runStarted();
    f.inbox.push({ seq: 3, ts: '3.0', thread: null, text: 'status?' });
    await f.bridge.poll();
    const busy = f.sent.at(-1)!.text;
    assert.ok(busy.startsWith(`${SLACK_PREFIX}status?`));
    assert.match(busy, /slack_send/);
    assert.match(busy, /continue/i);
    f.bridge.sawUserMessage(busy);
    await f.bridge.runEnded(replies('feito'));
    f.inbox.push({ seq: 4, ts: '4.0', thread: null, text: 'oi' });
    await f.bridge.poll();
    assert.equal(f.sent.at(-1)!.text, `${SLACK_PREFIX}oi`, 'after the run ends the session is idle again');
  } finally { f.close(); }
});

test('a run without a Slack message posts nothing; an empty run still answers the DM', async () => {
  const f = fixture();
  try {
    f.bridge.sawUserMessage('typed at the terminal');
    await f.bridge.runEnded(replies('ok'));
    assert.equal(f.requests.filter(r => r.path === '/v1/slack/send').length, 0);
    f.bridge.sawUserMessage(`${SLACK_PREFIX}oi`);
    await f.bridge.runEnded([]);
    assert.match(String((f.requests.at(-1)?.body as { text: string }).text), /sem resposta/);
  } finally { f.close(); }
});

/** An assistant message with these tool calls, then the final answer. */
const calling = (calls: [string, unknown][], answer: string) => [
  { role: 'assistant', content: calls.map(([name, args], i) => ({ type: 'toolCall', id: `c${i}`, name, arguments: args })) },
  ...replies(answer),
] as unknown as AgentMessage[];
const WAKE = 'A cheap check (haiku) woke you and suggests: fix the flaky test';

test('a wake that delivered something reports it in the channel of the repo it changed; an empty wake posts nothing', async () => {
  const f = fixture();
  const sends = () => f.requests.filter(r => r.path === '/v1/slack/send').map(r => r.body);
  try {
    f.bridge.sawUserMessage(WAKE);
    await f.bridge.runEnded(calling([['read', { path: 'C:/projetos/dentai-mono/a.ts' }], ['bash', { command: 'git status' }]], 'Nada a fazer.'));
    assert.deepEqual(sends(), [], 'reads and checks deliver nothing');

    f.bridge.sawUserMessage(WAKE);
    await f.bridge.runEnded(calling([['read', { path: 'C:/projetos/dentai-mono/a.ts' }], ['edit', { path: 'C:\\projetos\\Genexus18MCP\\src\\x.cs' }],
      ['bash', { command: 'cd C:/projetos/Genexus18MCP && git commit -m fix && git push' }]], 'Corrigi o teste.'));
    assert.deepEqual(sends().at(-1), { text: '*Wake* \u00b7 Corrigi o teste.', threadTs: null, channel: 'genexus18mcp' });

    f.bridge.sawUserMessage('typed at the terminal');
    await f.bridge.runEnded(calling([['edit', { path: 'C:/projetos/pi-optchat/x.ts' }]], 'ok'));
    assert.equal(sends().length, 1, 'only wakes report themselves');
  } finally { f.close(); }
});

test('wakeChannel: most-touched repo wins, unmapped work goes to the DM, a wake that already used slack_send is not repeated', () => {
  assert.equal(wakeChannel(calling([['edit', { path: 'C:/projetos/pi-goal-x/a.ts' }], ['write', { path: 'C:/projetos/pi-optchat/b.ts' }], ['edit', { path: 'C:/projetos/dentai-mono/c.ts' }]], 'x')), 'harness');
  assert.equal(wakeChannel(calling([['edit', { path: 'C:/Users/swluc/.optchat/profiles/p/AGENTS.md' }]], 'x')), null);
  assert.equal(wakeChannel(calling([['edit', { path: 'C:/projetos/dentai-mono/c.ts' }], ['slack_send', { text: 'pronto', channel: 'dentai' }]], 'x')), undefined);
  assert.equal(wakeChannel(calling([['bash', { command: 'cd C:/projetos/dotfiles && gh pr create --fill' }]], 'x')), 'harness');
});

test('without a Slack chat in the service (404) the bridge backs off instead of polling every tick', async () => {
  const f = fixture();
  try {
    f.fail(new HttpError(404));
    await f.bridge.poll();
    const count = f.requests.length;
    f.advance(60_000);
    await f.bridge.poll();
    assert.equal(f.requests.length, count, 'still backing off');
    f.advance(5 * 60_000);
    f.fail();
    await f.bridge.poll();
    assert.equal(f.requests.length, count + 1);
    await assert.rejects(() => (f.fail(new HttpError(503)), f.bridge.send('x')), /bot token/);
  } finally { f.close(); }
});
