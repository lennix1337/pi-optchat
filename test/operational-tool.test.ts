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
    // The refusal shows where the text diverges and the source around it, so one retry can quote it exactly.
    await assert.rejects(tool.execute('hint', { update: { kind: 'constraint', text: 'Implement locally; do pull.', sourceMessageId: '0' } }),
      (e: Error) => /first difference at character 23/.test(e.message) && e.message.includes('do not push.'));
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
    assert.equal(flushed, 7);
  } finally { await memory.close(); }
});

test('sourceMessageId "latest" names the operator\'s latest own message, never a machine notice, and stores its real id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'operational-tool-'));
  const memory = new Memory(dir, async () => 'short');
  const tool = operationalStateTool(() => ({ dir, memory }), () => {});
  try {
    await assert.rejects(tool.execute('none', { update: { kind: 'decision', text: 'x', sourceMessageId: 'latest' } }), /no operator message yet/);
    memory.append('user', 'pode mergear o 12');
    memory.append('user', '[gitwatch] lennix1337/pi-optchat · #12 merged');
    memory.append('user', '[Slack] (aprovação) aprovar');
    memory.append('talk', 'Merged #12.');
    const decided = JSON.parse((await tool.execute('a', { update: { kind: 'decision', text: 'Merge #12 now', sourceMessageId: 'latest' } })).content[0]!.text);
    assert.equal(decided.recorded.sourceMessageId, '0');
    // The exact-quote rule still applies to the message "latest" resolves to.
    await assert.rejects(tool.execute('b', { update: { kind: 'authorization', text: 'merge everything', sourceMessageId: 'latest' } }), /exactly quote/);
    const authorized = JSON.parse((await tool.execute('c', { update: { kind: 'authorization', text: 'pode mergear o 12', sourceMessageId: 'latest' } })).content[0]!.text);
    assert.equal(authorized.recorded.sourceMessageId, '0');
    // A Slack message from him counts as his words.
    memory.append('user', '[Slack #harness] faz o 3');
    const slack = JSON.parse((await tool.execute('d', { update: { kind: 'decision', text: 'do item 3', sourceMessageId: 'latest' } })).content[0]!.text);
    assert.equal(slack.recorded.sourceMessageId, '4');
    // The Slack bridge appends its word-budget and mid-run notes to his message; they are not his words, so a quote of
    // what he wrote is exact (05/11 116250: the refusal left his PR order unrecorded, and memory called it UNRESOLVED for a day).
    memory.append('user', '[Slack #dentai] ok pode fazer um pacote de tudo isso no PR\n\n(Responda em até 100 palavras; o que passar disso vai para a thread.)\n\n(Arrived while you were working: answer it with slack_send, then continue the current work. Do not end the run just to reply.)');
    const quoted = JSON.parse((await tool.execute('g', { update: { kind: 'authorization', text: '[Slack #dentai] ok pode fazer um pacote de tudo isso no PR', sourceMessageId: 'latest' } })).content[0]!.text);
    assert.equal(quoted.recorded.sourceMessageId, '5');
    await assert.rejects(tool.execute('h', { update: { kind: 'authorization', text: '[Slack #dentai] ok pode fazer', sourceMessageId: 'latest' } }), /exactly quote/);
    // An imported conversation is history, not his latest word.
    memory.append('user', 'imported request', undefined, undefined, { source: 'pi', conversation: 'old', message: '3', title: 'Imported conversation' });
    const afterImport = JSON.parse((await tool.execute('f', { update: { kind: 'decision', text: 'still item 3', sourceMessageId: 'latest' } })).content[0]!.text);
    assert.equal(afterImport.recorded.sourceMessageId, '5');
    await assert.rejects(tool.execute('e', { update: { kind: 'decision', text: 'x', sourceMessageId: '9999' } }), /original message.*latest operator message is 5/);
  } finally { await memory.close(); }
});
