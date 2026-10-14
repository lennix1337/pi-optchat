import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { Memory, CAP, PAGE, type Compression } from '../src/memory.ts';
import { boundedMessage, logMessage } from '../src/transcript.ts';
import { removeDir } from './support.ts';

const toolResult = (toolCallId: string, toolName: string, text: string): AgentMessage => ({
  role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError: false, timestamp: 3,
});

test('full tool outputs stay durable and pageable while request previews remain bounded and paired', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-tool-original-'));
  const compressions: Compression[] = [];
  const first = `${'HEAD-'.repeat(PAGE / 5)}MIDDLE-FIRST-${'m'.repeat(PAGE)}TAIL-FIRST`;
  const second = `HEAD-SECOND-${'s'.repeat(PAGE)}MIDDLE-SECOND-${'t'.repeat(PAGE)}TAIL-SECOND`;
  let memory = new Memory(dir, async input => {
    compressions.push(input);
    return `${input.source.slice(0, 100)} summary`;
  }, () => {});
  try {
    const calls: AgentMessage = { role: 'assistant', content: [
      { type: 'toolCall', id: 'first', name: 'bash', arguments: { command: `first-${'a'.repeat(600)}` } },
      { type: 'toolCall', id: 'second', name: 'read', arguments: { path: `second-${'b'.repeat(600)}` } },
    ], api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    logMessage(memory, calls);
    const rawFirst = toolResult('first', 'bash', first);
    const preview = boundedMessage(rawFirst);
    assert.equal(preview.role, 'toolResult');
    if (preview.role !== 'toolResult') throw new Error('unexpected role');
    const previewText = preview.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    assert.ok(previewText.length <= CAP, 'the live request preview remains bounded');
    assert.ok(!previewText.includes('MIDDLE-FIRST-'), 'the live request does not contain the full large output');

    logMessage(memory, preview, undefined, rawFirst);
    const rawSecond = toolResult('second', 'read', second);
    logMessage(memory, boundedMessage(rawSecond), undefined, rawSecond);
    await memory.settle(AbortSignal.timeout(5000), 'tree');
    assert.equal(memory.root.length, 4, 'each result stays one memory message so parallel result pairing is unchanged');
    assert.equal(memory.root[2].text, `bash: ${first}`);
    assert.equal(memory.root[3].text, `read: ${second}`);
    const resultInputs = compressions.filter(item => item.part.l === 0 && [2, 3].includes(item.part.i));
    assert.equal(resultInputs.length, 2);
    assert.ok(resultInputs.every(item => item.source.length <= CAP), 'memory previews sent to the compressor stay bounded');
    assert.ok(!resultInputs[0].source.includes('MIDDLE-FIRST-'), 'the compressor does not receive the omitted middle');
    const callSummaries = compressions.filter(item => item.part.l === 0 && [0, 1].includes(item.part.i));
    assert.match(callSummaries.find(item => item.part.i === 0)?.result ?? '', /^bash: HEAD-/);
    assert.match(callSummaries.find(item => item.part.i === 1)?.result ?? '', /^read: HEAD-SECOND-/);
    const resultSummaries = compressions.filter(item => item.part.l === 0 && [2, 3].includes(item.part.i));
    assert.deepEqual(resultSummaries.map(item => item.call?.i), [0, 1], 'results remain paired with their matching calls');

    await memory.close();
    memory = new Memory(dir, async input => input.source.slice(0, 100), () => {});
    assert.equal(memory.root[2].text, `bash: ${first}`, 'the complete output is restored from the durable store');
    assert.equal(memory.root[3].text, `read: ${second}`, 'the second paired result is restored too');
    for (const [id, expected] of [[2, `bash: ${first}`], [3, `read: ${second}`]] as const) {
      let recovered = '', offset = 0;
      while (offset < expected.length) {
        const page = memory.zoom(id, 1, offset);
        const match = new RegExp(`^${id}\\+1\\|echo: ([\\s\\S]*?)\\n\\[showing characters (\\d+)-(\\d+) of ${expected.length}`).exec(page);
        assert.ok(match, `page at ${offset} has a continuation marker`);
        assert.equal(Number(match[2]), offset);
        recovered += match[1];
        offset = Number(match[3]);
      }
      assert.equal(recovered, expected, 'head, middle and tail are available by paging after restart');
    }
  } finally { await memory.close(); removeDir(dir); }
});
