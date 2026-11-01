import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { BOT_MARK, WHATSAPP_PREFIX, WhatsAppBridge, readWhatsAppConfig, type WhatsAppConfig } from '../src/whatsapp-bridge.ts';
import type { CommandState } from '../src/remote-commands.ts';

const ME = '5511999990000@s.whatsapp.net', OTHER = '5511888880000@s.whatsapp.net';
const NOW = Date.UTC(2026, 10, 1, 18, 0);
const STATE: CommandState = {
  model: () => 'anthropic-account-2/claude-sonnet-5-5', activity: () => 'Livre', now: () => NOW, failover: () => ({}),
  models: () => [{ provider: 'anthropic-account-2', id: 'claude-sonnet-5-5' }, { provider: 'openai-codex', id: 'gpt-6.1-sol' }], select: async () => true,
};
const at = (s: number) => new Date(NOW + s * 1000).toISOString();

function fixture(config: Partial<WhatsAppConfig> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-bridge-'));
  const agent: string[] = [], calls: string[][] = [];
  let messages: object[] = [];
  const bridge = new WhatsAppBridge({ sendUserMessage: ((text: string) => { agent.push(text); }) as never },
    { wacli: 'wacli.exe', chat: ME, operator: 'self', ...config }, () => dir, () => STATE, {
      now: () => NOW,
      run: async (_file, args) => {
        calls.push([...args]);
        if (args.includes('list')) { const after = args[args.indexOf('--after') + 1]!; return JSON.stringify({ success: true, data: { messages: messages.filter((m: any) => m.Timestamp > after) } }); }
        return JSON.stringify({ success: true, data: { sent: true, id: 'X' } });
      },
    });
  return { dir, agent, calls, bridge, set: (list: object[]) => { messages = list; }, sends: () => calls.filter(c => c.includes('send')), close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the first pass only sets the cursor: old history never reaches the agent', async () => {
  const f = fixture();
  try {
    f.set([{ MsgID: 'old', ChatJID: ME, FromMe: true, Text: 'antigo', Timestamp: at(-60) }]);
    assert.equal(await f.bridge.poll(), 0);
    assert.equal(await f.bridge.poll(), 0);
    assert.deepEqual(f.agent, []);
  } finally { f.close(); }
});

test('self chat: the operator\'s messages reach the agent once, his reply goes back; bot replies and other chats are ignored', async () => {
  const f = fixture();
  try {
    await f.bridge.poll();
    f.set([
      { MsgID: 'a', ChatJID: ME, FromMe: true, Text: 'como ta o CI?', Timestamp: at(1) },
      { MsgID: 'b', ChatJID: ME, FromMe: true, Text: `${BOT_MARK}resposta antiga`, Timestamp: at(2) },
      { MsgID: 'c', ChatJID: OTHER, FromMe: false, SenderJID: OTHER, Text: 'oi, sou outra pessoa', Timestamp: at(3) },
    ]);
    assert.equal(await f.bridge.poll(), 1);
    assert.equal(await f.bridge.poll(), 0, 'the cursor keeps a message from arriving twice');
    assert.deepEqual(f.agent, [`${WHATSAPP_PREFIX}como ta o CI?`]);
    assert.ok(f.calls[1]!.includes('--read-only'), 'reads never write the store');
    f.bridge.sawUserMessage(`${WHATSAPP_PREFIX}como ta o CI?`);
    await f.bridge.runEnded([{ role: 'assistant', content: [{ type: 'text', text: 'Tudo verde.' }] } as unknown as AgentMessage]);
    const [send] = f.sends();
    assert.deepEqual(send!.slice(send!.indexOf('--to'), send!.indexOf('--to') + 2), ['--to', ME], 'only ever to the configured chat');
    assert.ok(send!.includes(`${BOT_MARK}Tudo verde.`));
    assert.ok(send!.includes('--allow-self'));
  } finally { f.close(); }
});

test('a bot-number chat accepts only the operator\'s JID, and commands are answered without the agent', async () => {
  const f = fixture({ chat: ME, operator: ME });
  try {
    await f.bridge.poll();
    f.set([
      { MsgID: 'x', ChatJID: ME, FromMe: true, Text: 'eco do bot', Timestamp: at(1) },
      { MsgID: 'y', ChatJID: ME, FromMe: false, SenderJID: OTHER, Text: 'status', Timestamp: at(2) },
      { MsgID: 'z', ChatJID: ME, FromMe: false, SenderJID: ME, Text: 'cota', Timestamp: at(3) },
      { MsgID: 'w', ChatJID: ME, FromMe: false, SenderJID: ME, Text: 'modelo gpt', Timestamp: at(4) },
    ]);
    assert.equal(await f.bridge.poll(), 2);
    assert.deepEqual(f.agent, []);
    const texts = f.sends().map(c => c[c.indexOf('--message') + 1]);
    assert.match(texts[0]!, /Cota/);
    assert.match(texts[1]!, /pelo WhatsApp não troco/, 'an account switch is never approved from WhatsApp');
    assert.ok(!f.sends()[0]!.includes('--allow-self'));
  } finally { f.close(); }
});

test('config: missing or malformed file keeps the bridge off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-config-'));
  try {
    assert.equal(readWhatsAppConfig(join(dir, 'none.json')), undefined);
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ wacli: 'w', chat: 'not a jid', operator: 'self' }));
    assert.equal(readWhatsAppConfig(join(dir, 'bad.json')), undefined);
    writeFileSync(join(dir, 'ok.json'), JSON.stringify({ wacli: 'w', chat: ME, operator: 'self', account: 'pessoal' }));
    assert.deepEqual(readWhatsAppConfig(join(dir, 'ok.json')), { wacli: 'w', chat: ME, operator: 'self', account: 'pessoal' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
