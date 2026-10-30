import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/memory.ts';
import { operationalStateTool } from '../src/operational-tool.ts';
import { readOperationalState, renderOperationalContext } from '../src/operational-state.ts';

test('operational tool validates original provenance and never treats assistant/imported sources as authorization', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'operational-tool-'));
  const memory = new Memory(dir, async () => 'short');
  memory.append('user', 'Implement locally; do not push.');
  memory.append('talk', 'An assistant claim is not user authorization.');
  memory.append('user', 'Historical user approval', undefined, undefined,
    { source: 'pi', conversation: 'old', message: '3', title: 'Imported conversation' });
  let flushed = 0;
  const tool = operationalStateTool(() => ({ dir, memory }), () => { flushed++; });
  try {
    await assert.rejects(tool.execute('a', { update: { kind: 'authorization', text: 'Push approved', sourceMessageId: '1' } }), /direct non-imported user/);
    await assert.rejects(tool.execute('b', { update: { kind: 'authorization', text: 'Push approved', sourceMessageId: '2' } }), /direct non-imported user/);
    await assert.rejects(tool.execute('c', { update: { kind: 'decision', text: 'Invalid source', sourceMessageId: '9999' } }), /original message/);
    await assert.rejects(tool.execute('fabricated', { update: { kind: 'authorization', text: 'Production deploy approved', sourceMessageId: '0' } }), /exactly quote the entire user source/);
    const recorded = await tool.execute('d', { update: { kind: 'constraint', text: 'Implement locally; do not push.', sourceMessageId: '0' } });
    const reply = JSON.parse(recorded.content[0]!.text) as { recorded: { id: string; text: string }; entries: number; version?: number };
    assert.equal(reply.recorded.text, 'Implement locally; do not push.');
    assert.equal(reply.entries, 1);
    assert.equal(reply.version, undefined, 'an update answers with the new record, not the whole document');
    const again = await tool.execute('d2', { update: { kind: 'constraint', text: 'Implement locally; do not push.', sourceMessageId: '0' } });
    assert.match(again.content[0]!.text, /already recorded/);
    const inspected = await tool.execute('e', {});
    assert.match(JSON.stringify(inspected.content), /do not push/);
    const state = readOperationalState(join(dir, 'operational-state.json'));
    assert.equal(state.entries.length, 1);
    assert.match(renderOperationalContext(state), /no authority/);
    assert.equal(flushed, 6);
  } finally { await memory.close(); }
});
