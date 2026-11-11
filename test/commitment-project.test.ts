import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addCommitment, commitmentsTool, describe, readCommitments, updateCommitment } from '../src/commitments.ts';
import { KNOWN_SPECIALISTS } from '../src/crew.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'commitment-project-'));
const T0 = Date.parse('2026-11-10T12:00:00Z');

test('a commitment takes a known specialist or any valid crew slug as its project, on add and on update, and describe shows it', () => {
  const dir = temp();
  try {
    for (const slug of KNOWN_SPECIALISTS) assert.equal(addCommitment(dir, { text: slug, source: '1', project: slug }, T0).project, slug);
    const c = addCommitment(dir, { text: 'new area', source: '1', project: 'pi-gitwatch' }, T0);
    assert.equal(readCommitments(dir).find(x => x.id === c.id)!.project, 'pi-gitwatch', 'stored');
    assert.match(describe(c, T0), /\[optchat · open · project pi-gitwatch · 0m old\]/);
    const plain = addCommitment(dir, { text: 'plain', source: '1' }, T0);
    assert.equal('project' in plain, false);
    assert.doesNotMatch(describe(plain, T0), /project/);
    assert.equal(updateCommitment(dir, { id: plain.id, project: 'dentai' }, T0).project, 'dentai');
    assert.equal(updateCommitment(dir, { id: plain.id, progress: 'x' }, T0).project, 'dentai', 'an update that leaves it out keeps it');
    assert.equal('project' in updateCommitment(dir, { id: plain.id, project: '' }, T0), false, 'an empty project clears it');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an invalid project is refused on add and on update, and nothing is written', () => {
  const dir = temp();
  try {
    for (const bad of ['Dentai', 'a b', '-x', 'x'.repeat(42), '../etc', 'dentai/x']) {
      assert.throws(() => addCommitment(dir, { text: 'x', source: '1', project: bad }, T0), /not a valid project/, bad);
    }
    assert.deepEqual(readCommitments(dir), []);
    const c = addCommitment(dir, { text: 'x', source: '1' }, T0);
    assert.throws(() => updateCommitment(dir, { id: c.id, project: 'No Good' }, T0), /not a valid project/);
    assert.equal(readCommitments(dir)[0]!.project, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the commitments tool sets and shows the project, and lists it', async () => {
  const dir = temp();
  try {
    const tool = commitmentsTool(() => ({ dir, sourceExists: () => true }));
    const added = await tool.execute('t', { action: 'add', text: 'watch CI', source: '1', project: 'harness' });
    assert.match(JSON.stringify(added), /project harness/);
    const listed = await tool.execute('t', { action: 'list' });
    assert.match(JSON.stringify(listed), /project harness/);
    await assert.rejects(tool.execute('t', { action: 'add', text: 'x', source: '1', project: 'BAD' }), /not a valid project/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stored item with a malformed project makes the file unreadable instead of reading as global', () => {
  const dir = temp();
  try {
    const c = addCommitment(dir, { text: 'x', source: '1', project: 'dentai' }, T0);
    assert.equal(c.project, 'dentai');
    const file = join(dir, 'commitments.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.items[0].project = 42;
    writeFileSync(file, JSON.stringify(raw));
    assert.throws(() => readCommitments(dir), /Unreadable commitments file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
