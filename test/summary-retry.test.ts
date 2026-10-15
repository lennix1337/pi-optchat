import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/memory.ts';
import { retrySummary, summaryPart } from '../src/summary-retry.ts';

test('summary retry requires a valid aligned original range', () => {
  assert.deepEqual(summaryPart('4+4'), { l: 2, i: 1 });
  for (const value of ['0+0', '1+2', '0+3', '-1+1', '0+1 trailing', '01+1', '0+9007199254740992'])
    assert.throws(() => summaryPart(value));
});

test('explicit retry resets only the named refused summary with the same compressor', async () => {
  let calls = 0, refuse = true;
  const memory = new Memory(mkdtempSync(join(tmpdir(), 'summary-retry-')), async () => {
    calls++;
    if (refuse) throw Object.assign(new Error('Provider refusal private contents'), { code: 'OPTCHAT_POLICY_REFUSAL' });
    return 'talk: preserved';
  }, () => {});
  const notes: string[] = [];
  const context = { isIdle: () => true, ui: { notify: (text: string) => { notes.push(text); } } };
  try {
    memory.append('talk', 'a'.repeat(1000));
    await memory.settle(AbortSignal.timeout(2000));
    assert.equal(calls, 1);
    await assert.rejects(retrySummary(memory, '0+1', { ...context, isIdle: () => false }), /current turn/);
    assert.equal(calls, 1);
    await retrySummary(memory, '1+1', context);
    assert.match(notes.at(-1) ?? '', /not policy-blocked/);
    refuse = false;
    await retrySummary(memory, '0+1', context);
    await memory.settle(AbortSignal.timeout(2000), 'tree');
    assert.equal(calls, 2);
    assert.equal(memory.root.length, 1);
    assert.equal(memory.node({ l: 0, i: 0 })?.text, 'talk: preserved');
    assert.ok(notes.some(note => note.includes('does not retry the main request or change providers')));
  } finally { await memory.close(); }
});
