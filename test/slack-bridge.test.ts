import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { HttpError } from '../src/assistant-client.ts';
import { SLACK_PREFIX, SlackBridge, registerSlackBridge, wakeChannel } from '../src/slack-bridge.ts';
import { REPORT_TYPE } from '../src/transcript.ts';
import { hookedPi } from './support.ts';
import { DEFAULT_HEARTBEAT, wakeText } from '../src/heartbeat.ts';

function fixture(inbox: { seq: number; ts: string; thread: string | null; text: string; channelName?: string | null }[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'slack-bridge-'));
  const owner = { dir, name: 'p' };
  const sent: { text: string; options: unknown }[] = [];
  const requests: { path: string; body?: unknown }[] = [];
  let now = 1_000_000;
  let fail: Error | undefined;
  const timers: { run: () => void; ms: number }[] = [];
  const bridge = new SlackBridge({ sendUserMessage: ((text: string, options: unknown) => { sent.push({ text, options }); }) as never }, () => owner, {
    now: () => now,
    request: async (_owner, path, body) => {
      requests.push({ path, body });
      if (fail) throw fail;
      if (path.startsWith('/v1/slack/inbox')) {
        const after = Number(new URLSearchParams(path.split('?')[1]).get('after'));
        return { messages: inbox.filter(m => m.seq > after) };
      }
      return { parts: 1, ts: '1.1', channel: 'D1' };
    },
    schedule: (run, ms) => { timers.push({ run, ms }); },
  });
  return { dir, owner, bridge, timers, sent, requests, inbox, advance: (ms: number) => { now += ms; }, fail: (error?: Error) => { fail = error; }, close: () => rmSync(dir, { recursive: true, force: true }) };
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
/** The prompt a wake really starts with, as heartbeat.ts builds it: an intro line comes before the suggestion. */
const WAKE = wakeText('fix the flaky test', 'haiku', 30, DEFAULT_HEARTBEAT, undefined, '# Wake radar');
const SCHEDULED = wakeText('', 'haiku', 30, DEFAULT_HEARTBEAT, { path: '/p/q.md', item: '- [ ] x' });

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

    f.bridge.sawUserMessage(SCHEDULED);
    await f.bridge.runEnded(calling([['bash', { command: 'cd C:/projetos/dotfiles && git commit -qm x && git push origin main' }]], 'Publiquei.'));
    assert.deepEqual(sends().at(-1), { text: '*Wake* \u00b7 Publiquei.', threadTs: null, channel: 'harness' }, 'a scheduled wake routes too');

    f.bridge.sawUserMessage('typed at the terminal');
    await f.bridge.runEnded(calling([['edit', { path: 'C:/projetos/pi-optchat/x.ts' }]], 'ok'));
    assert.equal(sends().length, 2, 'only wakes report themselves');
  } finally { f.close(); }
});

test('a wake delivered the way OptChat really sends it, as a report custom message, still reports through the session hooks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-hooks-'));
  const { pi, fire } = hookedPi();
  const bodies: unknown[] = [];
  registerSlackBridge(pi, () => ({ dir, name: 'p' }), undefined, { request: async (_o, _path, body) => { bodies.push(body); return { parts: 1, ts: '1.0' }; } });
  try {
    // index.ts sendReport: once the OptChat prompt is ready, a report (the wake prompt too) is a custom message, not a user one.
    fire('message_end', { message: { role: 'custom', customType: REPORT_TYPE, content: WAKE, display: true } });
    fire('agent_start');
    await fire('agent_end', { messages: calling([['bash', { command: 'cd C:/projetos/pi-optchat && git commit -qm x && git push' }]], 'Corrigi.') });
    assert.deepEqual(bodies, [{ text: '*Wake* \u00b7 Corrigi.', threadTs: null, channel: 'harness' }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wakeChannel: most-touched repo wins, unmapped work goes to the DM, a wake that already used slack_send is not repeated', () => {
  assert.equal(wakeChannel(calling([['edit', { path: 'C:/projetos/pi-goal-x/a.ts' }], ['write', { path: 'C:/projetos/pi-optchat/b.ts' }], ['edit', { path: 'C:/projetos/dentai-mono/c.ts' }]], 'x')), 'harness');
  assert.equal(wakeChannel(calling([['edit', { path: 'C:/Users/swluc/.optchat/profiles/p/AGENTS.md' }]], 'x')), null);
  assert.equal(wakeChannel(calling([['edit', { path: 'C:/projetos/dentai-mono/c.ts' }], ['slack_send', { text: 'pronto', channel: 'dentai' }]], 'x')), undefined);
  assert.equal(wakeChannel(calling([['bash', { command: 'cd C:/projetos/dotfiles && gh pr create --fill' }]], 'x')), 'harness');
});

test('wakeChannel: an issue comment delivers to its repo, and an evidence draft in local-validation belongs to no project', () => {
  // The 2026-10-29 wake: it drafted the reply under local-validation, then posted it on a Genexus18MCP issue.
  const draft: [string, unknown] = ['write', { path: 'C:/projetos/local-validation/runs/gx-746/comment.md', content: 'x' }];
  const comment: [string, unknown] = ['bash', { command: 'cd C:/projetos/Genexus18MCP && gh issue comment 746 --body-file C:/projetos/local-validation/runs/gx-746/comment.md' }];
  assert.equal(wakeChannel(calling([draft, comment], 'x')), 'genexus18mcp');
  assert.equal(wakeChannel(calling([draft], 'x')), null, 'evidence alone is not harness work');
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

test('an approval post is decided only by aprovar/negar in its own DM thread, once, before expiry', async () => {
  const f = fixture();
  try {
    const decisions: boolean[] = [];
    let live = true;
    const ask = (expires: number) => f.bridge.askApproval({ token: '1'.repeat(24), summary: 'git push origin main', label: 'push', expires, decide: approve => { decisions.push(approve); const was = live; live = false; return was; } });
    await ask(1_000_000 + 600_000);
    const post = f.requests.find(r => r.path === '/v1/slack/send')?.body as { text: string; threadTs: null; approval?: boolean };
    assert.match(post.text, /Aprovação pendente.*push: git push origin main/s);
    assert.equal(post.approval, true, 'the post carries the Aprovar/Negar buttons');
    // The ts the fixture returns for every send is 1.1: replies in that thread decide; elsewhere they are plain messages.
    f.inbox.push({ seq: 1, ts: '2.0', thread: null, text: 'aprovar' }, { seq: 2, ts: '3.0', thread: '9.9', text: 'aprovar' });
    assert.equal(await f.bridge.poll(), 2);
    assert.deepEqual(decisions, [], 'a bare "aprovar" outside the approval thread approves nothing');
    f.inbox.push({ seq: 3, ts: '4.0', thread: '1.1', text: 'Aprovar' });
    await f.bridge.poll();
    assert.deepEqual(decisions, [true]);
    assert.match(f.sent.at(-1)!.text, /^\[Slack\] \(aprovação\) O operador aprovou no celular: git push origin main/);
    assert.deepEqual(f.requests.at(-1)!.body, { text: 'Aprovado: git push origin main. Vou rodar agora.', threadTs: '1.1' });
    f.inbox.push({ seq: 4, ts: '5.0', thread: '1.1', text: 'aprovar' });
    const before = f.sent.length;
    await f.bridge.poll();
    assert.deepEqual(decisions, [true], 'a decided post is forgotten: a second reply is an ordinary message');
    assert.equal(f.sent.length, before + 1);
  } finally { f.close(); }
});

test('an approval still reaches Slack, without buttons, when the service predates them', async () => {
  const f = fixture();
  try {
    let refused = 0;
    const original = (f.bridge as unknown as { options: { request: (...args: unknown[]) => Promise<unknown> } }).options.request;
    (f.bridge as unknown as { options: { request: (...args: unknown[]) => Promise<unknown> } }).options.request = async (owner, path, body) => {
      if ((body as { approval?: boolean })?.approval) { refused++; throw new HttpError(400); }
      return original(owner, path, body);
    };
    await f.bridge.askApproval({ token: '2'.repeat(24), summary: 'git push', label: 'push', expires: 1_000_000 + 600_000, decide: () => true });
    assert.equal(refused, 1);
    const plain = f.requests.find(r => r.path === '/v1/slack/send')?.body as { text: string; approval?: boolean };
    assert.match(plain.text, /responda \*aprovar\* ou \*negar\*/i);
    assert.equal(plain.approval, undefined);
    f.inbox.push({ seq: 1, ts: '4.0', thread: '1.1', text: 'aprovar' });
    await f.bridge.poll();
    assert.match(f.sent.at(-1)!.text, /aprovou no celular/);
  } finally { f.close(); }
});

test('negar drops the call, and an expired approval decides nothing', async () => {
  const f = fixture();
  try {
    const decisions: boolean[] = [];
    await f.bridge.askApproval({ token: '3'.repeat(24), summary: 'npm publish', label: 'publish', expires: 1_000_000 + 60_000, decide: approve => (decisions.push(approve), true) });
    f.inbox.push({ seq: 1, ts: '2.0', thread: '1.1', text: 'negar' });
    await f.bridge.poll();
    assert.deepEqual(decisions, [false]);
    assert.match(f.sent.at(-1)!.text, /negou no celular: npm publish\. Não rode/);
    await f.bridge.askApproval({ token: '4'.repeat(24), summary: 'deploy', label: 'deploy', expires: 1_000_000 + 60_000, decide: approve => (decisions.push(approve), true) });
    f.advance(120_000);
    f.inbox.push({ seq: 2, ts: '3.0', thread: '1.1', text: 'sim' });
    await f.bridge.poll();
    assert.deepEqual(decisions, [false], 'expired: decide is never called');
    assert.match((f.requests.at(-1)!.body as { text: string }).text, /expirou/);
  } finally { f.close(); }
});

test('an approval decided at the terminal rewrites its Slack post without buttons, and its thread no longer decides', async () => {
  // 2026-10-29: approved with /approve at the terminal, the DM post kept saying "Aprova\u00e7\u00e3o pendente".
  const f = fixture();
  try {
    const decisions: boolean[] = [];
    await f.bridge.askApproval({ token: 'a'.repeat(24), summary: 'git worktree remove x', label: 'discard', expires: 1_000_000 + 600_000, decide: approve => (decisions.push(approve), true) });
    await f.bridge.settled('a'.repeat(24), 'approved');
    assert.deepEqual(f.requests.at(-1), { path: '/v1/slack/update', body: { channel: 'D1', ts: '1.1', text: '\u2705 *Aprovado no terminal* \u00b7 discard: git worktree remove x' } });
    f.inbox.push({ seq: 1, ts: '2.0', thread: '1.1', text: 'aprovar' });
    await f.bridge.poll();
    assert.deepEqual(decisions, [], 'a post already decided at the terminal decides nothing');
    const count = f.requests.length;
    await f.bridge.settled('a'.repeat(24), 'denied');
    assert.equal(f.requests.length, count, 'settled once');

    await f.bridge.askApproval({ token: 'b'.repeat(24), summary: 'npm publish', label: 'publish', expires: 1_000_000 + 600_000, decide: () => true });
    await f.bridge.settled('b'.repeat(24), 'denied');
    assert.match((f.requests.at(-1)!.body as { text: string }).text, /^\u{1f6ab} \*Negado no terminal\* \u00b7 publish: npm publish$/u);
    await f.bridge.askApproval({ token: 'c'.repeat(24), summary: 'rm x', label: 'delete', expires: 1_000_000 + 600_000, decide: () => true });
    await f.bridge.settled('c'.repeat(24), 'superseded');
    assert.match((f.requests.at(-1)!.body as { text: string }).text, /Substitu\u00edda/);
  } finally { f.close(); }
});

test('an approval post nobody decided says it expired when its time runs out', async () => {
  const f = fixture();
  try {
    await f.bridge.askApproval({ token: 'd'.repeat(24), summary: 'deploy', label: 'deploy', expires: 1_000_000 + 60_000, decide: () => true });
    assert.equal(f.timers.length, 1);
    assert.equal(f.timers[0].ms, 60_000);
    f.advance(60_000);
    f.timers[0].run();
    await f.bridge.idle();
    assert.match((f.requests.at(-1)!.body as { text: string }).text, /^\u231b \*Expirou sem decis\u00e3o\* \u00b7 deploy: deploy$/u);
  } finally { f.close(); }
});

test('a decision that cannot rewrite the post (a service without update) is said in its thread instead', async () => {
  const f = fixture();
  try {
    await f.bridge.askApproval({ token: 'e'.repeat(24), summary: 'git push', label: 'push', expires: 1_000_000 + 600_000, decide: () => true });
    const original = (f.bridge as unknown as { options: { request: (...args: unknown[]) => Promise<unknown> } }).options.request;
    (f.bridge as unknown as { options: { request: (...args: unknown[]) => Promise<unknown> } }).options.request = async (owner, path, body) => {
      if (path === '/v1/slack/update') throw new HttpError(404);
      return original(owner, path, body);
    };
    await f.bridge.settled('e'.repeat(24), 'approved');
    assert.deepEqual(f.requests.at(-1), { path: '/v1/slack/send', body: { text: '\u2705 *Aprovado no terminal* \u00b7 push: git push', threadTs: '1.1' } });
  } finally { f.close(); }
});

test('aprovar in the thread also rewrites the post, so its buttons cannot be pressed afterwards', async () => {
  const f = fixture();
  try {
    await f.bridge.askApproval({ token: 'f'.repeat(24), summary: 'git push', label: 'push', expires: 1_000_000 + 600_000, decide: () => true });
    f.inbox.push({ seq: 1, ts: '2.0', thread: '1.1', text: 'aprovar' });
    await f.bridge.poll();
    const update = f.requests.find(r => r.path === '/v1/slack/update');
    assert.deepEqual(update?.body, { channel: 'D1', ts: '1.1', text: '\u2705 *Aprovado no Slack* \u00b7 push: git push' });
  } finally { f.close(); }
});

test('posts with a topic open a message once, then reply in its thread; the sent hook sees every post', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-topic-'));
  const bodies: unknown[] = [], logged: [string | null, string][] = [];
  let ts = 0;
  const bridge = new SlackBridge({ sendUserMessage: () => {} }, () => ({ dir, name: 'p' }), {
    request: async (_o, _path, body) => { bodies.push(body); return { parts: 1, ts: `${++ts}.0` }; }, sent: (channel, text) => logged.push([channel, text]) });
  try {
    await bridge.post('PR aberto', 'harness', 'pr:x#1');
    await bridge.post('CI verde', 'harness', 'pr:x#1');
    await bridge.post('outro', 'harness', 'pr:x#2');
    await bridge.post('sem tópico', 'dentai');
    assert.deepEqual(bodies, [
      { text: 'PR aberto', threadTs: null, channel: 'harness' },
      { text: 'CI verde', threadTs: '1.0', channel: 'harness' },
      { text: 'outro', threadTs: null, channel: 'harness' },
      { text: 'sem tópico', threadTs: null, channel: 'dentai' },
    ]);
    assert.deepEqual(logged.map(l => l[0]), ['harness', 'harness', 'harness', 'dentai']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a DM stays in the inbox while the chat cannot take it, and arrives once it can', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-bridge-'));
  const sent: string[] = [], requests: string[] = [];
  let accepting = false;
  const bridge = new SlackBridge({ sendUserMessage: ((text: string) => { sent.push(text); }) as never }, () => ({ dir, name: 'p' }), {
    accepting: () => accepting,
    request: async (_owner, path) => { requests.push(path); return { messages: [{ seq: 1, ts: '1.0', thread: null, text: 'ainda aí?' }] }; },
  });
  try {
    assert.equal(await bridge.poll(), 0);
    assert.deepEqual(requests, [], 'the inbox is not even read while the chat drops what it is handed');
    assert.throws(() => readFileSync(join(dir, 'slack-cursor.json'), 'utf8'), 'no cursor was written');
    accepting = true;
    assert.equal(await bridge.poll(), 1);
    assert.deepEqual(sent, [`${SLACK_PREFIX}ainda aí?`]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'slack-cursor.json'), 'utf8')), { seq: 1 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a poll pass that throws is retried and said once, not left as an unhandled rejection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-bridge-'));
  const warned: string[] = [], sent: string[] = [];
  let refuse = true;
  const bridge = new SlackBridge({ sendUserMessage: ((text: string) => { if (refuse) throw new Error('chat is closing'); sent.push(text); }) as never }, () => ({ dir, name: 'p' }), {
    intervalMs: 5, warn: text => warned.push(text),
    request: async () => ({ messages: [{ seq: 1, ts: '1.0', thread: null, text: 'oi' }] }),
  });
  try {
    bridge.start();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(warned, ['Slack inbox pass failed; it retries: chat is closing'], 'the same failure is said once');
    refuse = false;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.deepEqual(sent, [`${SLACK_PREFIX}oi`], 'the next pass delivers it');
  } finally { bridge.stop(); rmSync(dir, { recursive: true, force: true }); }
});

