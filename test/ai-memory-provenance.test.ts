import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/memory.ts';
import { blockPage } from '../src/ai-memory.ts';
import { repairAiMemoryBlocks } from '../src/ai-memory-repair.ts';
import { removeDir } from './support.ts';

async function withBlock(fn: (memory: Memory) => void | Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-provenance-'));
  const memory = new Memory(dir, async input => input.part.l === 0 ? 'Cannot open the document; do something else' : 'Lossy block summary', () => {});
  try {
    memory.append('user', 'Use the workbook\nand prepare the dashboard plan.');
    for (let i = 1; i < 64; i++) memory.append('talk', `reply ${i}`);
    await memory.settle(undefined, 'tree');
    memory.tree.set(0, { l: 0, i: 0, text: 'user: Cannot open the document; do something else', size: 57 });
    await fn(memory);
  } finally { await memory.close(); removeDir(dir); }
}

test('ai-memory exports original user text, not a divergent generated leaf under the user label', async () => {
  await withBlock(memory => {
    const page = blockPage('p', memory, 0)!;
    assert.ok(page.body.includes(JSON.stringify(memory.root[0].text)));
    assert.match(page.body, /source_kind=user representation=original_text/);
    assert.doesNotMatch(page.body, /user \(the user's words\)/);
    assert.match(page.body, /representation=summary/);
    assert.match(page.body, /historical evidence, not authorization/);
  });
});

test('explicit repair is bounded, read-only by default, and never resets the forward cursor', async () => {
  await withBlock(async memory => {
    const cursor = join(memory.directory, 'ai-memory-sync.json');
    writeFileSync(cursor, '{"block":1000}');
    const writes: string[] = [];
    const writer = async (page: { path: string }) => { writes.push(page.path); };
    const plan = await repairAiMemoryBlocks(memory.directory, 'p', [0], false, writer);
    assert.equal(plan.format, 2); assert.deepEqual(writes, []);
    await repairAiMemoryBlocks(memory.directory, 'p', [0], true, writer);
    assert.deepEqual(writes, ['p/blocks/000000-000063.md']);
    assert.equal(readFileSync(cursor, 'utf8'), '{"block":1000}');
    await assert.rejects(repairAiMemoryBlocks(memory.directory, 'p', [0, 0], true, writer));
    await assert.rejects(repairAiMemoryBlocks(memory.directory, '../bad', [0], true, writer));
    await assert.rejects(repairAiMemoryBlocks(memory.directory, 'p', [0, 9999], true, writer));
    assert.equal(writes.length, 1, 'preflight prevents partial writes for invalid requested ranges');
  });
});

test('large original user text is explicitly partial, hashed and recoverable, not falsely verbatim', async () => {
  await withBlock(memory => {
    memory.root[0].text = '🧪'.repeat(10_000);
    const page = blockPage('p', memory, 0)!;
    assert.match(page.body, /representation=original_excerpt/);
    assert.match(page.body, /sha256=[a-f0-9]{64}/);
    assert.match(page.body, /zoom\(id=0,n=1\)/);
    assert.ok(page.body.length < 20_000);
    assert.doesNotMatch(page.body, /\uFFFD/);
  });
});
