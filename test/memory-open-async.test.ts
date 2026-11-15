import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../src/store.ts';
import { Memory } from '../src/memory.ts';
import { removeDir } from './support.ts';

const line = (value: unknown) => JSON.stringify(value) + '\n';
test('sliced open preserves the synchronous store and memory, including damaged tails, revisions and unordered records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-open-parity-'));
  try {
    mkdirSync(join(dir, 'main')); mkdirSync(join(dir, 'tree'));
    const entry = (i: number) => ({ i, kind: 'user', text: `message ${i}`, date: '2026-01-01T00:00:00.000Z' });
    writeFileSync(join(dir, 'main', '2026-01-01.jsonl'), line(entry(1)) + line(entry(0)) + '{broken}\n');
    writeFileSync(join(dir, 'main', '2026-01-02.jsonl'), line(entry(2)) + '{tail');
    writeFileSync(join(dir, 'tree', '2026-01-01.jsonl'), [
      { l: 0, i: 2, text: 'two' }, { l: 1, i: 0, text: 'pair' },
      { l: 0, i: 1, text: 'one' }, { l: 0, i: 0, text: 'zero' },
      { l: 0, i: 0, text: 'revised zero', revised: true },
      { invalid: true },
    ].map(line).join('') + '{tail');
    const aWarnings: string[] = [], bWarnings: string[] = [];
    const a = new FileStore(dir, text => aWarnings.push(text)), b = new FileStore(dir, text => bWarnings.push(text));
    const sync = a.load(1), asyncSaved = await b.loadAsync(1);
    assert.deepEqual(asyncSaved, sync);
    assert.deepEqual(bWarnings, aWarnings);
    assert.equal(b.reader(0)?.(), 'message 0');
    assert.equal(b.nodeText(0, 0), 'revised zero');
    const first = new Memory({ directory: dir, store: a, saved: sync }, async () => 'unexpected', () => {});
    const second = await Memory.open(dir, async () => 'unexpected', () => {});
    assert.deepEqual(second.root.map(e => e.text), first.root.map(e => e.text));
    assert.deepEqual([...second.tree].map(([k, v]) => [k, v.text]), [...first.tree].map(([k, v]) => [k, v.text]));
    assert.deepEqual(second.view, first.view);
    await first.close(); await second.close();
  } finally { removeDir(dir); }
});

test('sliced load refuses a concurrent append instead of accepting a stale snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-open-race-'));
  try {
    mkdirSync(join(dir, 'main')); mkdirSync(join(dir, 'tree'));
    const file = join(dir, 'tree', '2026-01-01.jsonl');
    writeFileSync(file, line({ l: 0, i: 0, text: 'summary' }).repeat(50_000));
    const loading = new FileStore(dir, () => {}).loadAsync();
    const rejected = assert.rejects(loading, /Another process wrote/);
    const mutation = new Promise<void>(resolve => setImmediate(() => { appendFileSync(file, line({ l: 0, i: 1, text: 'new' })); resolve(); }));
    await mutation;
    await rejected;
  } finally { removeDir(dir); }
});
