import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHARTER_BYTES, Crew, MEMORY_BYTES, crewTool } from '../src/crew.ts';
import { removeDir } from './support.ts';

type Args = Parameters<ReturnType<typeof crewTool>['execute']>[1];
function setup(memory: string) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-crew-edit-'));
  const crew = new Crew(dir), tool = crewTool(() => crew);
  crew.write('harness', 'memory', memory);
  const run = async (args: Args) => (await tool.execute('id', args)).content[0].text;
  const edit = (edits: { oldText: string; newText: string }[], append?: string) => run({ action: 'edit', project: 'harness', part: 'memory', edits, ...append === undefined ? {} : { append } });
  return { crew, run, edit, done: () => removeDir(dir) };
}
const refused = async (call: Promise<string>) => { try { await call; } catch (error) { return (error as Error).message; } assert.fail('expected a refusal'); };

test('crew edit replaces one unique text, deletes a whole line with an empty newText and appends a line', async () => {
  const { crew, edit, done } = setup('- alpha: one\n- beta: two\n- gamma: three');
  try {
    assert.equal(await edit([{ oldText: 'beta: two', newText: 'beta: 2' }]), `Wrote harness memory: ${Buffer.byteLength('- alpha: one\n- beta: 2\n- gamma: three')}/${MEMORY_BYTES} B.`);
    assert.equal(crew.read('harness', 'memory'), '- alpha: one\n- beta: 2\n- gamma: three\n');
    await edit([{ oldText: '- alpha: one', newText: '' }]);
    assert.equal(crew.read('harness', 'memory'), '- beta: 2\n- gamma: three\n', 'an emptied line leaves no blank line');
    await edit([], '- delta: four');
    assert.equal(crew.read('harness', 'memory'), '- beta: 2\n- gamma: three\n- delta: four\n');
    await edit([{ oldText: 'three', newText: '3' }, { oldText: 'four', newText: '4' }], '- epsilon: 5');
    assert.equal(crew.read('harness', 'memory'), '- beta: 2\n- gamma: 3\n- delta: 4\n- epsilon: 5\n', 'several edits and an append in one call');
  } finally { done(); }
});

test('crew edit refuses a missing or repeated oldText, an overlap and an empty call, and writes nothing', async () => {
  const { crew, edit, run, done } = setup('- a: x\n- b: x\n- c: y');
  const before = crew.read('harness', 'memory');
  try {
    assert.match(await refused(edit([{ oldText: 'nowhere', newText: 'z' }])), /edit 1: oldText not found.*Nothing was written/s);
    assert.match(await refused(edit([{ oldText: ': x', newText: ': z' }])), /edit 1: oldText matches 2 times.*Nothing was written/s);
    assert.match(await refused(edit([{ oldText: '', newText: 'z' }])), /edit 1: oldText is empty/);
    assert.match(await refused(edit([{ oldText: '- a: x\n- b', newText: 'q' }, { oldText: 'b: x', newText: 'r' }])), /edit 2: overlaps edit 1/);
    assert.match(await refused(edit([])), /edit needs edits or append/);
    assert.match(await refused(run({ action: 'edit', project: 'harness', part: 'proposals', edits: [{ oldText: 'a', newText: 'b' }] })), /read-only/);
    assert.equal(crew.read('harness', 'memory'), before, 'a refused edit leaves the memory untouched');
  } finally { done(); }
});

test('crew edit is all or none: a bad edit after good ones writes nothing', async () => {
  const { crew, edit, done } = setup('- a: 1\n- b: 2');
  const before = crew.read('harness', 'memory');
  try {
    assert.match(await refused(edit([{ oldText: 'a: 1', newText: 'a: 9' }, { oldText: 'missing', newText: 'x' }], '- c: 3')), /edit 2: oldText not found/);
    assert.equal(crew.read('harness', 'memory'), before);
  } finally { done(); }
});

test('an edit whose edits all match the original even when an earlier newText contains a later oldText', async () => {
  const { crew, edit, done } = setup('- a: 1\n- b: 2');
  try {
    await edit([{ oldText: 'a: 1', newText: 'b: 2 copy' }, { oldText: '- b: 2', newText: '- b: 3' }]);
    assert.equal(crew.read('harness', 'memory'), '- b: 2 copy\n- b: 3\n', 'oldText is matched against the text as it was');
  } finally { done(); }
});

test('an edit or write over the cap names current, resulting and excess bytes and the 3 longest lines, so one retry fits', async () => {
  const { crew, edit, run, done } = setup(`- keep\n- ação: ${'é'.repeat(100)}\n- long: ${'l'.repeat(300)}\n- short`);
  const current = Buffer.byteLength(crew.read('harness', 'memory').trimEnd());
  try {
    const fill = 'f'.repeat(MEMORY_BYTES);
    const message = await refused(edit([{ oldText: '- short', newText: `- fill: ${fill}` }]));
    const after = Buffer.byteLength(crew.read('harness', 'memory').trimEnd().replace('- short', `- fill: ${fill}`));
    assert.ok(message.startsWith(`harness memory would be ${after} B (now ${current} B): ${after - MEMORY_BYTES} B over its ${MEMORY_BYTES} B cap.`), message);
    assert.match(message, /Nothing was written/);
    const listed = message.split('\n').filter(line => line.startsWith('line '));
    assert.equal(listed.length, 3);
    assert.equal(listed[0], `line 4: ${Buffer.byteLength(`- fill: ${fill}`)} B: - fill: ${'f'.repeat(52)}`, 'line numbers start at 1, bytes counted, the excerpt cut at 60 characters');
    assert.equal(listed[1], `line 3: ${Buffer.byteLength(`- long: ${'l'.repeat(300)}`)} B: - long: ${'l'.repeat(52)}`);
    assert.equal(listed[2].slice(0, 7), 'line 2:');
    assert.equal(crew.read('harness', 'memory').includes('fill'), false);
    const whole = await refused(run({ action: 'write', project: 'harness', part: 'memory', text: 'x'.repeat(MEMORY_BYTES + 5) }));
    assert.match(whole, new RegExp(`would be ${MEMORY_BYTES + 5} B \\(now ${current} B\\): 5 B over its ${MEMORY_BYTES} B cap`));
  } finally { done(); }
});

test('a successful write reports its bytes over the cap, for a memory, a charter and the missions', async () => {
  const { run, done } = setup('- a');
  try {
    assert.equal(await run({ action: 'write', project: 'harness', part: 'memory', text: '- ação' }), `Wrote harness memory: 8/${MEMORY_BYTES} B.`);
    assert.equal(await run({ action: 'write', project: 'harness', part: 'charter', text: '# h' }), `Wrote harness charter: 3/${CHARTER_BYTES} B.`);
    assert.equal(await run({ action: 'write', part: 'missions', text: '- [harness] m' }), `Wrote missions.md: 13/${MEMORY_BYTES} B.`);
    assert.equal(await run({ action: 'edit', part: 'missions', edits: [{ oldText: 'm', newText: 'mm' }], append: '- two' }), `Wrote missions.md: 20/${MEMORY_BYTES} B.`);
  } finally { done(); }
});
