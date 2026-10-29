import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { HttpError } from '../src/assistant-client.ts';
import { SLACK_PREFIX, SlackBridge } from '../src/slack-bridge.ts';

function fixture(inbox: { seq: number; ts: string; thread: string | null; text: string }[] = []) {
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
