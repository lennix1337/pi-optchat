import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { HttpError } from '../src/assistant-client.ts';
import { SLACK_PREFIX, SlackBridge, clipWords, registerSlackBridge, wakeChannel } from '../src/slack-bridge.ts';
import { budgetNote, words } from '../src/slack-policy.ts';
import { readDay } from '../src/home-day.ts';
import { REPORT_TYPE } from '../src/transcript.ts';
import { hookedPi } from './support.ts';
import { DEFAULT_HEARTBEAT, wakeText } from '../src/heartbeat.ts';

function fixture(inbox: { seq: number; ts: string; thread: string | null; text: string; channelName?: string | null; channel?: string }[] = [], extra: Record<string, unknown> = {}) {
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
    ...extra,
  });
  return { dir, owner, bridge, timers, sent, requests, inbox, advance: (ms: number) => { now += ms; }, fail: (error?: Error) => { fail = error; }, close: () => rmSync(dir, { recursive: true, force: true }) };
}
/** A run's messages: one assistant message per reply text. */
const replies = (...texts: string[]) => texts.map(text => ({ role: 'assistant', content: [{ type: 'text', text }] }) as unknown as AgentMessage);

test('operator DMs become [Slack] user messages in order, once, across restarts', async () => {
  const f = fixture([{ seq: 1, ts: '1.0', thread: null, text: 'como ta o deploy?' }, { seq: 2, ts: '2.0', thread: null, text: 'e o CI?' }]);
  try {
    assert.equal(await f.bridge.poll(), 2);
    assert.deepEqual(f.sent.map(s => s.text), [`${SLACK_PREFIX}como ta o deploy?\n\n${budgetNote(100)}`, `${SLACK_PREFIX}e o CI?\n\n${budgetNote(100)}`]);
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
    f.bridge.sawUserMessage(f.sent[0]!.text);
    await f.bridge.runEnded(replies('rodando', 'Tudo verde.'));
    const reply = f.requests.find(r => r.path === '/v1/slack/send');
    assert.deepEqual(reply?.body, { text: 'Tudo verde.', threadTs: '4.0' });
  } finally { f.close(); }
});

test('a notice steering a Slack run does not swallow the answer the operator was waiting for', async () => {
  const f = fixture([{ seq: 1, ts: '5.0', thread: null, text: 'pode revisar no meu nome?' }]);
  try {
    await f.bridge.poll();
    f.bridge.sawUserMessage(`${SLACK_PREFIX}pode revisar no meu nome?`);
    f.bridge.assistantSaid(replies('Fechado. Regra registrada.')[0]!);
    f.bridge.sawUserMessage('[gitwatch] lennix1337/pi-optchat #56 ready to merge');
    f.bridge.assistantSaid(replies('O #56 espera o #57.')[0]!);
    await f.bridge.runEnded(replies('Fechado. Regra registrada.', 'O #56 espera o #57.'));
    await new Promise(resolve => setImmediate(resolve));
    const sent = f.requests.filter(r => r.path === '/v1/slack/send').map(r => (r.body as { text: string }).text);
    assert.deepEqual(sent.sort(), ['Fechado. Regra registrada.', 'O #56 espera o #57.']);
  } finally { f.close(); }
});

test('a project channel message is marked with its channel and the run answers in that channel', async () => {
  const f = fixture([{ seq: 1, ts: '7.0', thread: null, text: 'como ta a release?', channelName: 'genexus18mcp' }]);
  try {
    await f.bridge.poll();
    assert.equal(f.sent[0].text, `[Slack #genexus18mcp] como ta a release?\n\n${budgetNote(100)}`);
    f.bridge.sawUserMessage(f.sent[0].text);
    await f.bridge.runEnded(replies('v4.0.5 publicada.'));
    assert.deepEqual(f.requests.find(r => r.path === '/v1/slack/send')?.body, { text: 'v4.0.5 publicada.', threadTs: null, channel: 'genexus18mcp' });
  } finally { f.close(); }
});

test('a DM that arrives mid-run tells the agent to answer with slack_send and keep working, not end the run', async () => {
  const f = fixture([{ seq: 1, ts: '1.0', thread: null, text: 'que horas são?' }, { seq: 2, ts: '2.0', thread: null, text: 'e agora?' }]);
  try {
    await f.bridge.poll();
    assert.equal(f.sent[0].text, `${SLACK_PREFIX}que horas são?\n\n${budgetNote(100)}`, 'an idle session gets the plain message: the run exists to answer it');
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
    assert.equal(f.sent.at(-1)!.text, `${SLACK_PREFIX}oi\n\n${budgetNote(100)}`, 'after the run ends the session is idle again');
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
  registerSlackBridge(pi, () => ({ dir, name: 'p' }), undefined, { request: async (_o, path, body) => { if (path === '/v1/slack/send') bodies.push(body); return { parts: 1, ts: '1.0' }; } });
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
    assert.deepEqual(sent, [`${SLACK_PREFIX}ainda aí?\n\n${budgetNote(100)}`]);
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
    assert.deepEqual(sent, [`${SLACK_PREFIX}oi\n\n${budgetNote(100)}`], 'the next pass delivers it');
  } finally { bridge.stop(); rmSync(dir, { recursive: true, force: true }); }
});


test('a DM gets 👀 when it reaches the chat and ✅ when the answer goes out; the App Home shows working, then free', async () => {
  const f = fixture([{ seq: 1, ts: '1793000000.000100', thread: null, text: 'faz o deploy', channel: 'D0OWNER' } as never]);
  try {
    await f.bridge.poll();
    f.bridge.runStarted();
    f.bridge.sawUserMessage(f.sent[0]!.text);
    await f.bridge.runEnded(replies('Feito.'));
    await new Promise(done => setImmediate(done));
    const reacts = f.requests.filter(r => r.path === '/v1/slack/react').map(r => r.body);
    assert.deepEqual(reacts, [
      { channel: 'D0OWNER', ts: '1793000000.000100', name: 'eyes', remove: false },
      { channel: 'D0OWNER', ts: '1793000000.000100', name: 'eyes', remove: true },
      { channel: 'D0OWNER', ts: '1793000000.000100', name: 'white_check_mark', remove: false },
    ]);
    const homes = f.requests.filter(r => r.path === '/v1/slack/home').map(r => (r.body as { text: string }).text);
    assert.match(homes[0]!, /Trabalhando[\s\S]*faz o deploy/);
    assert.match(homes.at(-1)!, /Livre[\s\S]*Feito\./);
  } finally { f.close(); }
});

test('progress posted with slack_send during a Slack-started run goes in the thread of his message; the answer closes it, broadcast', async () => {
  const f = fixture([{ seq: 1, ts: '1793000000.000100', thread: null, text: 'migra o banco', channel: 'D0OWNER' } as never]);
  try {
    await f.bridge.poll();
    f.bridge.sawUserMessage(f.sent[0]!.text);
    await f.bridge.post('Etapa 1 de 3 feita.', null);
    await f.bridge.runEnded(replies('Migração concluída.'));
    const sends = f.requests.filter(r => r.path === '/v1/slack/send').map(r => r.body);
    assert.deepEqual(sends, [
      { text: 'Etapa 1 de 3 feita.', threadTs: '1793000000.000100' },
      { text: 'Migração concluída.', threadTs: '1793000000.000100', broadcast: true },
    ]);
  } finally { f.close(); }
});

test('files he sends are saved and pointed to; Slack links he pastes are read and quoted; failures are said, not hidden', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-bridge-'));
  const sent: string[] = [];
  const inbox = [{ seq: 1, ts: '1793000000.000100', thread: null, channel: 'D0OWNER', text: 've isso https://lennix.slack.com/archives/C0GERAL/p1793000000123456 e https://lennix.slack.com/archives/C0PRIV/p1793000000999999',
    files: [{ id: 'F1', name: 'audio.m4a', mimetype: 'audio/mp4', url: 'https://files.slack.com/a' }, { id: 'F2', name: 'tela.png', mimetype: 'image/png', url: 'https://files.slack.com/b' }] }];
  const bridge = new SlackBridge({ sendUserMessage: ((text: string) => { sent.push(text); }) as never }, () => ({ dir, name: 'p' }), {
    request: async (_o, path, body: any) => {
      if (path.startsWith('/v1/slack/inbox')) return { messages: inbox };
      if (path === '/v1/slack/download') { if (body.name === 'tela.png') throw new Error('slack_file_forbidden'); return { path: `C:/x/${body.name}` }; }
      if (path === '/v1/slack/fetch') { if (body.channel === 'C0PRIV') throw new Error('not_in_channel'); return { user: 'U0ALICE', text: 'o servidor caiu' }; }
      return { ok: true };
    },
  });
  try {
    await bridge.poll();
    const text = sent[0]!;
    assert.match(text, /audio\.m4a \[audio\/mp4\]: C:\/x\/audio\.m4a \(transcreva com transcribe_file\)/);
    assert.match(text, /tela\.png \[image\/png\]: não baixou \(slack_file_forbidden\)/);
    assert.match(text, /Mensagem linkada \(<@U0ALICE> em <#C0GERAL>\):\n> o servidor caiu/);
    assert.match(text, /<#C0PRIV>: não consegui ler \(not_in_channel/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('App Home: a run typed in the terminal shows working too, with the live step, elapsed time and what waits for him', async () => {
  const f = fixture();
  const homes = () => bodiesFor<{ text: string }>('/v1/slack/home')(f).map(body => body.text);
  try {
    f.bridge.setWaiting(() => ['Rotacionar a chave rk_live do DentAI']);
    f.bridge.runStarted();
    f.bridge.sawUserMessage('melhora a home do optchat');
    assert.match(homes().at(-1)!, /Trabalhando[\s\S]*terminal[\s\S]*melhora a home/);
    f.bridge.toolStarted('bash', { command: 'cd C:/projetos/pi-optchat && git push -u origin HEAD' });
    assert.match(homes().at(-1)!, /Agora: .*git push[\s\S]*1 passo/);
    f.advance(5_000);
    f.bridge.toolStarted('read', { path: 'C:/projetos/pi-optchat/src/slack-bridge.ts' });
    assert.equal(homes().length, 2, 'steps closer than the throttle are not published');
    f.advance(30_000);
    f.bridge.toolStarted('edit', { path: 'C:/projetos/pi-optchat/src/slack-bridge.ts' });
    assert.match(homes().at(-1)!, /há 0 min[\s\S]*Agora: editando slack-bridge\.ts · 3 passos/);
    assert.match(homes().at(-1)!, /Esperando você[\s\S]*rk_live/);
    await f.bridge.runEnded(replies('Pronto.'));
    assert.match(homes().at(-1)!, /Livre[\s\S]*Pronto\.[\s\S]*Esperando você/);
  } finally { f.close(); }
});

/** The bodies the bridge posted to one service path, in order: `bodiesFor<T>(path)(f)`. */
const bodiesFor = <T,>(path: string) => (f: ReturnType<typeof fixture>) => f.requests.filter(r => r.path === path).map(r => r.body as T);
const homeBodies = bodiesFor<{ text: string; working?: boolean; approval?: string }>('/v1/slack/home');

test('App Home buttons: Parar while working, Aprovar naming the waiting post, and its tap decides that call', async () => {
  const f = fixture([{ seq: 1, ts: '9.0', thread: '1.1', text: 'aprovar', channelName: null }]);
  let ran = 0;
  try {
    f.bridge.runStarted();
    f.bridge.sawUserMessage('faz o deploy');
    assert.equal(homeBodies(f).at(-1)!.working, true);
    assert.equal(homeBodies(f).at(-1)!.approval, undefined);
    await f.bridge.askApproval({ token: 't1', label: 'bash', summary: 'git push --force', expires: 1_000_000 + 600_000, decide: () => (ran++, true) });
    assert.equal(homeBodies(f).at(-1)!.approval, '1.1', 'the Home offers Aprovar for the waiting post');
    assert.equal(await f.bridge.poll(), 0, 'a Home tap arrives as aprovar in the thread of that post');
    assert.equal(ran, 1);
    assert.equal(homeBodies(f).at(-1)!.approval, undefined, 'decided: the button goes away');
    await f.bridge.runEnded(replies('ok'));
    assert.equal(homeBodies(f).at(-1)!.working, false, 'free: no Parar');
  } finally { f.close(); }
});

test('parar from the DM or the Home stops the run in progress; idle says there was nothing', async () => {
  let running = true, stopped = 0;
  const f = fixture([{ seq: 1, ts: '1.0', thread: null, text: 'parar' }, { seq: 2, ts: '2.0', thread: null, text: 'parar' }],
    { abort: () => { if (!running) return false; running = false; stopped++; return true; } });
  try {
    await f.bridge.poll();
    assert.equal(stopped, 1);
    const replies$ = f.requests.filter(r => r.path === '/v1/slack/send').map(r => (r.body as { text: string }).text);
    assert.match(replies$[0]!, /Parei/);
    assert.match(replies$[1]!, /Nada rodando/);
    assert.equal(f.sent.length, 0, 'the agent never sees it');
  } finally { f.close(); }
});

test('App Home "Hoje": finished runs survive in home-day.json with totals, an hour bar and the next wake check', async () => {
  const base = Date.parse('2026-11-02T12:00:00Z'); // 09:00 in Brasilia
  let now = base;
  const f = fixture([], { now: () => now, nextWake: () => now + 45 * 60_000 });
  try {
    f.bridge.runStarted();
    f.bridge.sawUserMessage('arruma o CI');
    f.bridge.toolStarted('bash', { command: 'npm test' });
    now += 25 * 60_000;
    await f.bridge.runEnded(replies('CI verde.'));
    const text = homeBodies(f).at(-1)!.text;
    assert.match(text, /\*Hoje\* · 1 trabalho · 25 min trabalhando · 1 passo\b/);
    assert.match(text, /`09h [▁-█] 09h`/);
    assert.doesNotMatch(text, /• 09:00/, 'the Home shows work items, not one row per chat run');
    assert.match(text, /Próxima checagem de wake às 10:10/);
    assert.equal(readDay(f.dir, now).length, 1, 'a reload reads the day back');
    assert.equal(readDay(f.dir, now + 86_400_000).length, 0, 'tomorrow starts empty');
  } finally { f.close(); }
});

test('App Home: a service from before the buttons refuses the new fields; the text alone still goes out', async () => {
  // The refusal as the real client reports it: HttpError, whose message never says "HTTP 400" (03/11: the Home froze for hours).
  const calls: Record<string, unknown>[] = [], warnings: string[] = [];
  const f = fixture([], { warn: (m: string) => warnings.push(m), request: async (_o: unknown, path: string, body: Record<string, unknown>) => {
    if (path !== '/v1/slack/home') return { parts: 1, ts: '1.1', channel: 'D1' };
    calls.push(body);
    if ('working' in body) throw new HttpError(400);
    return { ok: true };
  } });
  try {
    f.bridge.runStarted();
    f.bridge.sawUserMessage('oi');
    await new Promise(done => setTimeout(done, 10));
    assert.equal(calls.length, 2);
    assert.deepEqual(Object.keys(calls[1]!), ['text']);
    f.bridge.sawUserMessage('[Slack] de novo');
    await new Promise(done => setTimeout(done, 10));
    assert.equal(warnings.filter(w => /Restart the service/.test(w)).length, 1, 'said once, with what to do');
  } finally { f.close(); }
});

test('App Home: a publish that fails for another reason is said once, not swallowed', async () => {
  const warnings: string[] = [];
  const f = fixture([], { warn: (m: string) => warnings.push(m), request: async (_o: unknown, path: string) => {
    if (path === '/v1/slack/home') throw new HttpError(502);
    return { parts: 1, ts: '1.1', channel: 'D1' };
  } });
  try {
    f.bridge.runStarted();
    f.bridge.sawUserMessage('oi');
    f.bridge.sawUserMessage('[Slack] de novo');
    await new Promise(done => setTimeout(done, 10));
    assert.equal(warnings.filter(w => /App Home not published/.test(w)).length, 1);
  } finally { f.close(); }
});

/** A request fake whose enrichment calls take `ms` each and record how many were in flight at once. */
function slowEnrichment(ms: number) {
  let inFlight = 0, peak = 0;
  const request = async (_o: unknown, path: string, body: any) => {
    if (path === '/v1/slack/react') return { ok: true };
    if (path.startsWith('/v1/slack/inbox')) return { messages: [] };
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, ms));
    inFlight--;
    if (path === '/v1/slack/download') return { path: `C:/x/${body.name}` };
    return { user: 'U0ALICE', text: `texto de ${body.ts}` };
  };
  return { request, peak: () => peak };
}

test('the files and linked messages of one Slack message are read at the same time, and listed in the order sent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-bridge-'));
  const sent: string[] = [];
  const slow = slowEnrichment(60);
  const files = ['a.png', 'b.png', 'c.png'].map((name, i) => ({ id: `F${i}`, name, mimetype: 'image/png', url: `https://files.slack.com/${name}` }));
  const inbox = [{ seq: 1, ts: '1793000000.000100', thread: null, channel: 'D0OWNER',
    text: 'veja https://lennix.slack.com/archives/C0GERAL/p1793000000123456 e https://lennix.slack.com/archives/C0GERAL/p1793000000999999', files }];
  const bridge = new SlackBridge({ sendUserMessage: ((text: string) => { sent.push(text); }) as never }, () => ({ dir, name: 'p' }), {
    request: async (o, path, body: any) => path.startsWith('/v1/slack/inbox') ? { messages: inbox } : slow.request(o, path, body),
  });
  try {
    await bridge.poll();
    assert.equal(slow.peak(), 5, 'three downloads and two fetches were in flight together');
    const text = sent[0]!;
    assert.ok(text.indexOf('a.png') < text.indexOf('b.png') && text.indexOf('b.png') < text.indexOf('c.png'), 'attachments keep the order he sent');
    assert.ok(text.indexOf('Anexos') < text.indexOf('Mensagem linkada'), 'attachments come before the quotes, as before');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a message with many files reads them a few at a time, not all at once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-bridge-'));
  const slow = slowEnrichment(40);
  const files = Array.from({ length: 9 }, (_, i) => ({ id: `F${i}`, name: `f${i}.png`, mimetype: 'image/png', url: `https://files.slack.com/f${i}` }));
  const inbox = [{ seq: 1, ts: '1793000000.000100', thread: null, channel: 'D0OWNER', text: 'nove prints', files }];
  const sent: string[] = [];
  const bridge = new SlackBridge({ sendUserMessage: ((text: string) => { sent.push(text); }) as never }, () => ({ dir, name: 'p' }), {
    request: async (o, path, body: any) => path.startsWith('/v1/slack/inbox') ? { messages: inbox } : slow.request(o, path, body),
  });
  try {
    await bridge.poll();
    assert.equal(slow.peak(), 4, 'at most four downloads at once');
    for (let i = 0; i < 9; i++) assert.ok(sent[0]!.includes(`- f${i}.png [image/png]: C:/x/f${i}.png`), `file ${i} is listed`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('long poll: an assistant that refuses wait= gets plain polls at once, with no back-off', async () => {
  const inbox = [{ seq: 1, ts: '1.1', thread: null, text: 'oi' }];
  const seen: string[] = [];
  const f = fixture(inbox, { request: async (_owner: unknown, path: string) => {
    seen.push(path);
    if (path.includes('wait=')) throw new HttpError(400);
    return { messages: inbox.filter(m => m.seq > Number(new URLSearchParams(path.split('?')[1]).get('after'))) };
  } });
  try {
    assert.equal(await f.bridge.poll(), 0, 'the refused read delivers nothing');
    assert.equal(await f.bridge.poll(), 1, 'the next read is plain and is not held back by a back-off');
    assert.match(seen[0]!, /wait=\d+/);
    assert.doesNotMatch(seen[1]!, /wait=/);
  } finally { f.close(); }
});

test('long poll: a read the service held is followed at once; stop() ends the read in flight and nothing else', async () => {
  const reads: { path: string; signal?: AbortSignal }[] = [];
  const f = fixture([], {
    now: Date.now, intervalMs: 60_000, heldMs: 10,
    schedule: (run: () => void, ms: number) => { setTimeout(run, ms).unref(); },
    request: (_owner: unknown, path: string, _body: unknown, signal?: AbortSignal) => {
      reads.push({ path, signal });
      if (!path.includes('wait=')) return Promise.resolve({ messages: [] });
      return new Promise(resolve => setTimeout(() => resolve({ messages: [] }), 30));
    },
  });
  try {
    f.bridge.start();
    await new Promise(r => setTimeout(r, 200));
    const held = reads.filter(r => r.path.includes('wait=')).length;
    assert.ok(held >= 3, `held reads follow each other at once (${held} in 200 ms; the interval is 60 s)`);
    f.bridge.stop();
    assert.equal(reads.at(-1)!.signal?.aborted, true, 'stop() aborts the read in flight');
    const count = reads.length;
    await new Promise(r => setTimeout(r, 120));
    assert.equal(reads.length, count, 'nothing is read after stop()');
  } finally { f.close(); }
});

const WORK = { prs: [{ repo: 'lennix1337/pi-optchat', number: 13, title: 'Assistente', url: 'https://github.com/lennix1337/pi-optchat/pull/13', checks: 'verdes' as const }],
  commitments: [{ text: 'Revisar o #13', status: 'em aberto', url: 'https://github.com/lennix1337/pi-optchat/pull/13' }], jobs: ['bash-3 \u00b7 npm test'] };

test('App Home shows the work as items: open PRs and commitments with links, running jobs; the Home is the only write', async () => {
  const f = fixture([], { items: () => WORK });
  try {
    f.bridge.runStarted();
    f.bridge.sawUserMessage('arruma o CI');
    await f.bridge.runEnded(replies('CI verde.'));
    const text = homeBodies(f).at(-1)!.text;
    assert.match(text, /\*PRs abertas\* \(1\)/);
    assert.match(text, /<https:\/\/github\.com\/lennix1337\/pi-optchat\/pull\/13\|pi-optchat#13 Assistente> \u00b7 checks verdes/);
    assert.match(text, /\*Compromissos abertos\* \(1\)\n\u2022 <https:\/\/github\.com\/lennix1337\/pi-optchat\/pull\/13\|Revisar o #13> \u00b7 em aberto/);
    assert.match(text, /\*Rodando agora\* \(1\)\n\u2022 bash-3 \u00b7 npm test/);
    assert.deepEqual([...new Set(f.requests.map(r => r.path))], ['/v1/slack/home'], 'reads only; nothing is sent to Slack for the items');
  } finally { f.close(); }
});

test('App Home: a work reader that throws leaves the Home to go out without the items', async () => {
  const f = fixture([], { items: () => { throw new Error('pr-watch unreadable'); } });
  try {
    f.bridge.runStarted();
    f.bridge.sawUserMessage('arruma o CI');
    await f.bridge.runEnded(replies('CI verde.'));
    const text = homeBodies(f).at(-1)!.text;
    assert.match(text, /\u2705 \*Livre\*/);
    assert.doesNotMatch(text, /PRs abertas/);
  } finally { f.close(); }
});

const sendsOf = bodiesFor<{ text: string; threadTs: string | null; channel?: string }>('/v1/slack/send');
const paragraphs = (n: number) => Array.from({ length: n }, (_, i) => `Parágrafo ${i + 1}: ${Array.from({ length: 30 }, () => 'palavra').join(' ')}.`).join('\n\n');

test('a final answer over the DM budget goes out as a short head, then the full text in a thread reply', async () => {
  const f = fixture([{ seq: 1, ts: '5.0', thread: null, text: 'resume o dia' }]);
  try {
    await f.bridge.poll();
    f.bridge.sawUserMessage(f.sent[0]!.text);
    const long = paragraphs(6);
    await f.bridge.runEnded(replies(long));
    const sends = sendsOf(f);
    assert.equal(sends.length, 2, 'a head, then the full text');
    assert.ok(words(sends[0]!.text) <= 100, `head has ${words(sends[0]!.text)} words`);
    assert.match(sends[0]!.text, /texto completo na thread/);
    assert.equal(sends[0]!.threadTs, null, 'the head is the answer, in the DM as before');
    assert.equal(sends[1]!.text, long, 'the full text is kept whole');
    assert.equal(sends[1]!.threadTs, '1.1', "the full text replies in the head's thread");
  } finally { f.close(); }
});

test('a final answer within the budget is one post, as before', async () => {
  const f = fixture([{ seq: 1, ts: '5.0', thread: null, text: 'status?' }]);
  try {
    await f.bridge.poll();
    f.bridge.sawUserMessage(f.sent[0]!.text);
    await f.bridge.runEnded(replies('Tudo verde.'));
    assert.deepEqual(sendsOf(f), [{ text: 'Tudo verde.', threadTs: null }]);
  } finally { f.close(); }
});

test('slack_send over the channel budget posts a head in the channel and the full text in its thread', async () => {
  const f = fixture();
  try {
    const long = Array.from({ length: 150 }, (_, i) => `item${i}`).join(' ');
    await f.bridge.post(long, 'dentai');
    const sends = sendsOf(f);
    assert.deepEqual(sends.map(s => s.channel), ['dentai', 'dentai']);
    assert.ok(words(sends[0]!.text) <= 100);
    assert.equal(sends[1]!.text, long);
    assert.equal(sends[1]!.threadTs, '1.1');
  } finally { f.close(); }
});

test('a topic post over the budget keeps its topic thread, and the full text goes in that thread too', async () => {
  const f = fixture();
  try {
    const long = Array.from({ length: 150 }, (_, i) => `t${i}`).join(' ');
    await f.bridge.post('primeiro post', 'harness', 'denta-1');
    f.requests.length = 0;
    await f.bridge.post(long, 'harness', 'denta-1');
    const sends = sendsOf(f);
    assert.equal(sends.length, 2);
    assert.equal(sends[0]!.threadTs, '1.1', 'the topic reply goes in the topic thread');
    assert.equal(sends[1]!.threadTs, '1.1', 'and so does the full text');
    assert.equal(sends[1]!.text, long);
  } finally { f.close(); }
});

test('the word budget is per channel: a project channel can set its own, the DM keeps the default', async () => {
  const f = fixture([], { wordBudgets: { dentai: 60 } });
  try {
    const eighty = Array.from({ length: 80 }, (_, i) => `p${i}`).join(' ');
    await f.bridge.post(eighty, 'dentai');
    assert.equal(sendsOf(f).length, 2, 'over the dentai budget of 60: split');
    f.requests.length = 0;
    await f.bridge.post(eighty, null);
    assert.deepEqual(sendsOf(f), [{ text: eighty, threadTs: null }], 'within the DM budget of 100: whole');
  } finally { f.close(); }
});

test('a wake report over the budget is split the same way, in the repo channel', async () => {
  const f = fixture();
  try {
    f.bridge.sawUserMessage(WAKE);
    await f.bridge.runEnded(calling([['bash', { command: 'cd C:/projetos/Genexus18MCP && git commit -m fix && git push' }]], paragraphs(5)));
    const sends = sendsOf(f);
    assert.equal(sends.length, 2, JSON.stringify(sends.map(s => s.text.slice(0, 40))));
    assert.ok(words(sends[0]!.text) <= 100);
    assert.equal(sends[1]!.text, `*Wake* · ${paragraphs(5)}`);
  } finally { f.close(); }
});

test('a Slack message tells the model the reply budget of its own channel', async () => {
  const f = fixture([{ seq: 1, ts: '7.0', thread: null, text: 'oi do dentai', channelName: 'dentai' }, { seq: 2, ts: '8.0', thread: null, text: 'oi da DM' }], { wordBudgets: { dentai: 60 } });
  try {
    await f.bridge.poll();
    assert.match(f.sent[0]!.text, /até 60 palavras/);
    assert.match(f.sent[1]!.text, /até 100 palavras/);
  } finally { f.close(); }
});

type HomeBody = { text: string; working?: boolean; choices?: { label: string; options: string[] }[]; fold?: string };
const homes$ = bodiesFor<HomeBody>('/v1/slack/home');
const MANY = { ...WORK, prs: Array.from({ length: 7 }, (_, i) => ({ ...WORK.prs[0]!, number: i + 1 })) };

test('App Home: idle in the chat with a shell or a subagent still running says so instead of "Livre"', async () => {
  const f = fixture([], { items: () => ({ ...WORK, agents: ['subagente a1 \u00b7 revisar #830'] }) });
  try {
    f.bridge.runStarted();
    f.bridge.sawUserMessage('arruma o CI');
    await f.bridge.runEnded(replies('Rodando os testes.'));
    const text = homes$(f).at(-1)!.text;
    assert.match(text, /^\u23f3 \*Em segundo plano\* \(1 subagente e 1 comando rodando\) \u00b7 chat livre desde/);
    assert.doesNotMatch(text, /Livre\*/);
    assert.match(text, /\*Rodando agora\* \(2\)/);
  } finally { f.close(); }
});

test('App Home: idle with a PR whose CI is pending says what it waits for, not "Livre"', async () => {
  const pending = { ...WORK, jobs: [], prs: [{ ...WORK.prs[0]!, repo: 'lennix1337/Genexus18MCP', number: 840, checks: 'pendentes' as const }] };
  const f = fixture([], { items: () => pending });
  try {
    f.bridge.runStarted();
    f.bridge.sawUserMessage('faz a release');
    await f.bridge.runEnded(replies('Esperando o CI da #840.'));
    const text = homes$(f).at(-1)!.text;
    assert.match(text, /^\u23f3 \*Esperando CI de Genexus18MCP#840\* \u00b7 chat livre desde/);
    assert.doesNotMatch(text, /Livre\*/);
  } finally { f.close(); }
});

test('App Home: idle with nothing running nor pending CI still says "Livre"', async () => {
  const f = fixture([], { items: () => ({ ...WORK, jobs: [] }) });
  try {
    f.bridge.runStarted();
    f.bridge.sawUserMessage('oi');
    await f.bridge.runEnded(replies('Pronto.'));
    assert.match(homes$(f).at(-1)!.text, /^\u2705 \*Livre\* desde/);
  } finally { f.close(); }
});

test('App Home: what waits on him shows what is asked, its answers as buttons, and Ver tudo when items were folded', async () => {
  const f = fixture([], { items: () => MANY });
  try {
    f.bridge.setWaiting(() => ['Aprovação pendente: git push', { text: 'Resumo das 07:00 v2', ask: 'Confirmar se o DM chegou', choices: ['chegou', 'não chegou'] }]);
    f.bridge.runStarted();
    f.bridge.sawUserMessage('oi');
    await f.bridge.runEnded(replies('ok'));
    const body = homes$(f).at(-1)!;
    assert.match(body.text, /\u2022 Resumo das 07:00 v2\n   \u21b3 _Confirmar se o DM chegou_/);
    assert.deepEqual(body.choices, [{ label: 'Resumo das 07:00 v2', options: ['chegou', 'não chegou'] }]);
    assert.equal(body.fold, 'more');
  } finally { f.close(); }
});

test('App Home: Ver tudo / Ver menos from the Home change the Home only: no DM, no message to the chat', async () => {
  const f = fixture([{ seq: 1, ts: '1.0', thread: null, text: 'tudo', channel: 'home' }, { seq: 2, ts: '2.0', thread: null, text: 'menos', channel: 'home' }], { items: () => MANY });
  try {
    f.bridge.runStarted();
    f.bridge.sawUserMessage('oi');
    await f.bridge.runEnded(replies('ok'));
    f.inbox.splice(1);
    assert.equal(await f.bridge.poll(), 0);
    let body = homes$(f).at(-1)!;
    assert.equal(body.fold, 'less');
    assert.equal((body.text.match(/pi-optchat#\d/g) ?? []).length, 7, 'every PR listed');
    f.inbox.push({ seq: 2, ts: '2.0', thread: null, text: 'menos', channel: 'home' });
    await f.bridge.poll();
    body = homes$(f).at(-1)!;
    assert.equal(body.fold, 'more');
    assert.equal(f.sent.length, 0, 'the chat never sees the taps');
    assert.equal(f.requests.filter(r => r.path === '/v1/slack/send').length, 0);
  } finally { f.close(); }
});

test('clipWords: cuts at a word with an ellipsis, never mid-word', () => {
  assert.equal(clipWords('curto', 10), 'curto');
  assert.equal(clipWords('o vigia marcava como "loop" sem motivo', 24), 'o vigia marcava como\u2026');
  assert.equal(clipWords('x'.repeat(30), 10), `${'x'.repeat(9)}\u2026`);
});
