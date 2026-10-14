import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Memory, PAGE } from '../src/memory.ts';
import { memoryTools } from '../src/tools.ts';
import { runTranscript } from '../src/transcript.ts';
import { reportParts } from '../src/report-message.ts';
import { removeDir } from './support.ts';

const at = { timestamp: 0 };
const assistant = (content: Extract<AgentMessage, { role: 'assistant' }>['content']): AgentMessage => ({ role: 'assistant', content, api: 'anthropic-messages', provider: 'p', model: 'm',
  stopReason: 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...at });
const chat: AgentMessage[] = [
  { role: 'user', content: '<chat>\n0+1|a long memory view\n</chat>\n\nYour task:\nRun the tests.', ...at },
  assistant([{ type: 'text', text: 'Running them.' }, { type: 'toolCall', id: 't1', name: 'bash', arguments: { command: 'npm test' } }]),
  { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: 'ok '.repeat(2_000) + 'fail 1' }], isError: false, ...at },
  { role: 'user', content: 'Parent says: fix it.', ...at },
  { role: 'user', content: '<chat>\npasted by the parent', ...at },
];

test('a run transcript keeps complete tool results and omits only the memory view', () => {
  const text = runTranscript(chat), output = 'ok '.repeat(2_000) + 'fail 1';
  assert.ok(text.startsWith('user|Your task:\nRun the tests.\ntalk|Running them.\ntool|bash {"command":"npm test"}\necho|bash: ok ok'));
  assert.ok(!text.includes('a long memory view'));
  assert.ok(text.includes(`echo|bash: ${output}\nuser|Parent says: fix it.`), 'the complete result is retained for zoom paging');
  assert.ok(!text.includes('characters omitted'));
});

test('zoom takes a run id: the transcript in pages that say where to go on; an unknown run says so', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-runs-'));
  const memory = new Memory(dir, async () => 'summary', () => {});
  const largeOutput = `HEAD-${'m'.repeat(PAGE)}MIDDLE-${'x'.repeat(PAGE)}TAIL`;
  const largeChat: AgentMessage[] = chat.map(message => message.role === 'toolResult'
    ? { ...message, content: [{ type: 'text', text: largeOutput }] } : message);
  const long = [...largeChat, ...Array.from({ length: 300 }, (_, i) => assistant([{ type: 'text', text: `step ${i} `.repeat(30) }]))];
  const runs = (id: string) => id === 'abcd1234' ? chat : id === 'feed0000' ? long : id === '12345678' ? [] : undefined;
  const zoom = memoryTools(() => memory, runs)[0];
  const text = async (args: Parameters<typeof zoom.execute>[1]) => (await zoom.execute('call', args)).content.flatMap(c => c.type === 'text' ? [c.text] : []).join('');
  try {
    memory.append('user', 'hello');
    const whole = runTranscript(chat);
    assert.equal(await text({ id: 'abcd1234' }), `${whole}\n[characters 0-${whole.length} of ${whole.length}]`);
    const all = runTranscript(long), first = await text({ agent: 'feed0000' });
    assert.equal(first, `${all.slice(0, PAGE)}\n[characters 0-${PAGE} of ${all.length}; go on with offset ${PAGE}]`);
    assert.equal(await text({ agent: 'feed0000', offset: PAGE, limit: 10 }), `${all.slice(PAGE, PAGE + 10)}\n[characters ${PAGE}-${PAGE + 10} of ${all.length}; go on with offset ${PAGE + 10}]`);
    let recovered = '', offset = 0;
    while (offset < all.length) {
      const page = await text({ agent: 'feed0000', offset, limit: PAGE });
      const marker = /\n\[characters (\d+)-(\d+) of (\d+)(?:; go on with offset \d+)?\]$/.exec(page);
      assert.ok(marker, `page ${offset} states its bounds`);
      assert.equal(Number(marker[1]), offset);
      assert.equal(Number(marker[3]), all.length);
      recovered += page.slice(0, marker.index);
      offset = Number(marker[2]);
    }
    assert.equal(recovered, all, 'paging zoom(agent) recovers the complete child transcript');
    assert.ok(recovered.includes(`echo|bash: ${largeOutput}`), 'the child tool result retains its complete middle');
    assert.ok(!recovered.includes('characters omitted'), 'child tool results are not irreversibly capped before paging');
    assert.equal(await text({ id: '12345678' }), '\n[characters 0-0 of 0]', 'an all-digit run id is a run, even before it has said anything');
    await assert.rejects(zoom.execute('call', { id: 'gone0000' }), /^Error: No run gone0000\.$/);
    await assert.rejects(zoom.execute('call', { id: '87654321' }), /^Error: No run 87654321\.$/, 'eight digits is a run id, even one that is gone');
    assert.equal(await text({ id: '0', n: 1 }), '0+1|user: hello', 'a message id sent as a string still opens the message');
    assert.equal(await text({ id: 0 }), '0+1|user: hello', 'n defaults to 1');
  } finally { await memory.close(); removeDir(dir); }
});

test('the report box leaves out the Full chat trailer', () => {
  assert.equal(reportParts('[abcd1234] Done.\n\nFull chat: zoom("abcd1234")').body, 'Done.');
  assert.equal(reportParts('[abcd1234] A.\n\nFull chat: zoom("abcd1234")\n\n[feed0000] B.\n\nFull chat: zoom("feed0000")', 2).body, '[abcd1234] A.\n\n[feed0000] B.');
});
