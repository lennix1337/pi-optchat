import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { Memory, type Compressor, type Compression } from '../src/memory.ts';

function fixture(t: TestContext, compress: Compressor, budget = 128_000) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-undo-'));
  let memory = new Memory(dir, compress, undefined, budget);
  t.after(async () => { await memory.close(); rmSync(dir, { recursive: true, force: true }); });
  return { memory, reopen: async () => { await memory.close(); return memory = await Memory.open(dir, compress, undefined, budget); } };
}

const identity: Compressor = async ({ source }) => source;

test('undo N hides exactly N raw entries, and redo restores only the last batch after reopen', async t => {
  const f = fixture(t, identity);
  const m = f.memory;
  for (const text of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo']) m.append('talk', text);
  assert.deepEqual(m.undo(2), { from: 3, to: 5 });
  assert.match(m.render(), /Charlie/);
  assert.doesNotMatch(m.render(), /Delta|Echo/);
  assert.equal(m.root[4].text, 'Echo');
  assert.deepEqual(m.undo(2), { from: 1, to: 3 });
  const reopened = await f.reopen();
  reopened.append('talk', 'Foxtrot');
  assert.doesNotMatch(reopened.render(), /Bravo|Charlie|Delta|Echo/);
  assert.deepEqual(reopened.redo(), { from: 1, to: 3 });
  assert.match(reopened.render(), /Charlie/);
  assert.doesNotMatch(reopened.render(), /Delta|Echo/);
  assert.match(reopened.render(), /Foxtrot/);
  assert.deepEqual(reopened.redo(), { from: 3, to: 5 });
  assert.match(reopened.render(), /Echo/);
});

test('default undo and targeted undo select one exchange, not a newer exchange', async t => {
  const { memory: m } = fixture(t, identity);
  m.append('user', 'Alpha', undefined, undefined, undefined, 'slack:DFAKE:100.1');
  m.append('tool', 'alpha {}');
  m.append('echo', 'alpha: finished');
  m.append('talk', 'Reply to Alpha');
  m.append('user', 'Bravo');
  m.append('talk', 'Reply to Bravo');
  assert.deepEqual(m.undo(1, 'slack:DFAKE:100.1'), { from: 0, to: 4 });
  assert.equal(m.undo(1, 'slack:DFAKE:100.1'), undefined);
  assert.match(m.render(), /Reply to Bravo/);
  assert.doesNotMatch(m.render(), /Alpha|alpha/);
  assert.deepEqual(m.undo(), { from: 4, to: 6 });
  assert.doesNotMatch(m.render(), /Bravo/);
});

test('one exchange skips synthetic user notices when finding its operator input', async t => {
  const { memory: m } = fixture(t, identity);
  m.append('user', 'Operator request');
  m.append('talk', 'Operator reply');
  m.append('user', '[gitwatch] Synthetic notice');
  m.append('talk', 'Notice response');
  assert.deepEqual(m.undo(), { from: 0, to: 4 });
});

test('undo masks old cross-range and contextual summaries, zoom, search and future compactor inputs', async t => {
  const inputs: Compression[] = [];
  const secret = 'hidden-marker';
  const f = fixture(t, async input => {
    inputs.push(input);
    return `${input.source}${input.context.includes(secret) ? ` recalled:${secret}` : ''}`.slice(0, 660);
  }, 800);
  const m = f.memory;
  m.append('user', `${secret} ${'x'.repeat(640)}`, undefined, undefined, undefined, 'slack:DFAKE:100.1');
  await m.settle(undefined, 'tree');
  m.append('user', `visible ${'y'.repeat(640)}`);
  await m.settle(undefined, 'tree');
  assert.ok(inputs.some(i => JSON.stringify(i).includes(secret)));
  assert.ok(m.search(secret).length);
  inputs.length = 0;
  m.undo(1, 'slack:DFAKE:100.1');
  assert.doesNotMatch(m.render(), /hidden-marker/);
  assert.throws(() => m.zoom(0, 1), /ocult|hidden/i);
  assert.throws(() => m.zoom(0, 2), /ocult|hidden/i);
  assert.deepEqual(m.search(secret), []);
  const reopened = await f.reopen();
  reopened.append('talk', `new ${'z'.repeat(640)}`);
  await reopened.settle(undefined, 'tree');
  assert.ok(inputs.some(i => i.source.includes('new')));
  assert.ok(inputs.every(i => !JSON.stringify(i).includes(secret)));
  assert.doesNotMatch(reopened.render(), /hidden-marker/);
});
