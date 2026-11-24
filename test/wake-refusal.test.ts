import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { DEFAULT_HEARTBEAT, Heartbeat, beatSnapshot, wakeText } from '../src/heartbeat.ts';
import { SlackBridge } from '../src/slack-bridge.ts';
import { remoteCommand } from '../src/remote-commands.ts';

const DAY = 86_400_000;
const proposal = 'revisar alertas do projeto mercurio';
const replies = (text: string) => [{ role: 'assistant', content: [{ type: 'text', text }] }] as unknown as AgentMessage[];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'wake-refusal-'));
  let now = 2_000_000;
  const inbox: Record<string, unknown>[] = [], delivered: string[] = [];
  const bridge = new SlackBridge({ sendUserMessage: ((text: string) => { delivered.push(text); }) as never }, () => ({ dir, name: 'test' }), {
    now: () => now,
    transcribe: async () => 'não quero',
    request: async (_owner, path) => path.startsWith('/v1/slack/inbox') ? { messages: inbox }
      : path === '/v1/slack/fetch' ? { user: 'UOTHER', text: 'não precisa' }
      : path === '/v1/slack/download' ? { path: '/tmp/audio.ogg' }
      : { parts: 1, ts: '100.1', channel: 'CWAKE' },
  });
  async function postWake(topic = proposal, report = `Proponho ${topic}.`) {
    bridge.sawUserMessage(wakeText(topic, 'fixture', 30, DEFAULT_HEARTBEAT));
    await bridge.runEnded(replies(report));
  }
  const state = () => {
    const path = join(dir, 'wake-suppressions.json');
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { rules: { text: string; origin: string; ts: string; expiresAt: number; topic: string }[] } : { rules: [] };
  };
  async function receive(text: string, operatorText?: { text: string; ts: string }, thread = '100.1', files?: object[]) {
    inbox.push({ seq: inbox.length + 1, ts: '101.2', thread, text, channel: 'CWAKE', channelName: 'wakes', ...(operatorText ? { operatorText } : {}), ...(files ? { files } : {}) });
    await bridge.poll();
  }
  const suppressed: string[] = [];
  async function candidate(text: string) {
    let timer: (() => void) | undefined;
    const wakes: string[] = [];
    const heartbeat = new Heartbeat({ dir, now: () => now, minutes: () => 1, maxWakes: () => 9, always: () => false,
      busy: () => undefined, setTimer: run => { timer = run; return run; }, clearTimer: () => { timer = undefined; },
      check: async () => ({ wake: true, text }), wake: b => wakes.push(b.text), note: () => {},
      onSuppressed: (reason: string) => suppressed.push(reason) });
    heartbeat.arm(); timer!(); await heartbeat.settled();
    return wakes;
  }
  return { dir, bridge, postWake, receive, state, candidate, delivered, suppressed, advance: (ms: number) => { now += ms; }, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('direct refusal of a wake suppresses its subject for seven days but not another', async () => {
  const f = setup();
  try {
    await f.postWake();
    await f.receive('não', { text: 'não', ts: '101.2' });
    assert.deepEqual(f.state().rules.map(r => [r.text, r.origin, r.ts, r.expiresAt]), [['não', 'slack', '101.2', 2_000_000 + 7 * DAY]]);
    assert.deepEqual(await f.candidate(proposal), []);
    assert.match(f.suppressed[0]!, /101\.2/);
    assert.deepEqual(await f.candidate('atualizar documentação do projeto venus'), ['atualizar documentação do projeto venus']);
  } finally { f.close(); }
});

test('the refused subject comes from the posted proposal, not a different radar suggestion', async () => {
  const f = setup();
  try {
    await f.postWake(proposal, 'Proponho atualizar documentação do projeto venus.');
    await f.receive('não', { text: 'não', ts: '101.2' });
    assert.deepEqual(await f.candidate('atualizar documentação do projeto venus'), []);
    assert.deepEqual(await f.candidate(proposal), [proposal]);
  } finally { f.close(); }
});

test('an exact short topic is suppressed too', async () => {
  const f = setup();
  try {
    await f.postWake('API');
    await f.receive('não', { text: 'não', ts: '101.2' });
    assert.deepEqual(await f.candidate('API'), []);
    assert.deepEqual(await f.candidate('CI'), ['CI']);
  } finally { f.close(); }
});

test('a forwarded refusal cannot create a rule, unlike a direct refusal', async () => {
  const f = setup();
  try {
    await f.postWake();
    await f.receive('↪ Encaminhada por você\n> não quero', undefined);
    assert.equal(f.state().rules.length, 0);
    await f.receive('não', { text: 'não', ts: '101.2' });
    assert.equal(f.state().rules.length, 1);
  } finally { f.close(); }
});

test('quoted or attached words do not create a refusal when the original message is not a refusal', async () => {
  const f = setup();
  try {
    await f.postWake();
    const original = 'pode ver https://example.slack.com/archives/CWAKE/p1234567890123456';
    await f.receive(original, { text: original, ts: '101.2' }, '100.1', [{ id: 'F1', name: 'audio.ogg', mimetype: 'audio/ogg', url: 'https://files.slack.com/audio' }]);
    assert.match(f.delivered[0]!, /Transcrição: "não quero"/);
    assert.match(f.delivered[0]!, /> não precisa/);
    assert.equal(f.state().rules.length, 0);
    await f.receive('> não quero', { text: '> não quero', ts: '101.2' });
    assert.equal(f.state().rules.length, 0);
    await f.receive('não', { text: 'não', ts: '101.2' });
    assert.equal(f.state().rules.length, 1);
  } finally { f.close(); }
});

test('heartbeat snapshot exposes active refused topics', () => {
  const snapshot = beatSnapshot({ view: '', state: '', idleMinutes: 10, agents: [], shells: [], refusals: [proposal] } as never);
  assert.match(snapshot, /refused[\s\S]*mercurio/i);
});

test('the operator can list and revoke a refusal', async () => {
  const f = setup();
  try {
    await f.postWake();
    await f.receive('não', { text: 'não', ts: '101.2' });
    const list = remoteCommand('recusas')!;
    assert.match((await list.command.run(f.bridge.commandState(), list.arg)).text, /mercurio/);
    const revoke = remoteCommand('recusas CWAKE:101.2')!;
    assert.match((await revoke.command.run(f.bridge.commandState(), revoke.arg)).text, /liberad/i);
    assert.deepEqual(await f.candidate(proposal), [proposal]);
  } finally { f.close(); }
});

test('the wake is allowed again after the seven-day refusal expires', async () => {
  const f = setup();
  try {
    await f.postWake();
    await f.receive('não', { text: 'não', ts: '101.2' });
    assert.deepEqual(await f.candidate(proposal), []);
    f.advance(7 * DAY);
    assert.deepEqual(await f.candidate(proposal), [proposal]);
  } finally { f.close(); }
});
