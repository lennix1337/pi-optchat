import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../src/store.ts';
import { Inbox } from '../src/inbox.ts';
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

test('loadAsync streams files past one chunk and returns cold summaries when hot is bounded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-open-cold-'));
  try {
    mkdirSync(join(dir, 'main')); mkdirSync(join(dir, 'tree'));
    const pad = 'x'.repeat(500);
    const total = 700; // > 350 KB total, crossing the 256 KB scanJsonl chunk boundary
    const date = '2026-01-01T00:00:00.000Z';
    writeFileSync(join(dir, 'main', '2026-01-01.jsonl'), Array.from({ length: total }, (_, i) => line({ i, kind: 'user', text: `msg ${i} ${pad}`, date })).join(''));
    writeFileSync(join(dir, 'main', '2026-01-02.jsonl'), line({ i: total, kind: 'user', text: 'latest', date: '2026-01-02T00:00:00.000Z' }));
    writeFileSync(join(dir, 'tree', '2026-01-01.jsonl'),
      Array.from({ length: total }, (_, i) => line({ l: 0, i, text: `sum ${i} ${pad}` })).join('') +
      Array.from({ length: total / 2 }, (_, i) => line({ l: 1, i, text: `l1 ${i}` })).join(''));
    const store = new FileStore(dir, () => {});
    const saved = await store.loadAsync(1);
    assert.equal(saved.entries.length, total + 1);
    assert.equal(saved.tree.length, total + total / 2);
    assert.ok(saved.tree.every(node => !('text' in (node as object)) && typeof (node as { size?: unknown }).size === 'number'), 'loadAsync with bounded hot drops summary texts before Memory initializes');
    assert.equal(store.nodeText(0, 0), `sum 0 ${pad}`);
    assert.equal(store.reader(0)?.(), `msg 0 ${pad}`);
    const memory = await Memory.open(dir, (_input, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), () => {});
    try {
      assert.equal(memory.root.length, total + 1);
      assert.equal(memory.tree.get(0)?.text, `sum 0 ${pad}`);
      assert.ok(memory.stats().treeColdNodes > 0 && memory.stats().treeColdNodes <= total);
      // ColdTreeMap supports set/has/delete/values across cold and warm entries without inflating coldSize.
      const beforeSize = memory.tree.size;
      assert.equal(memory.tree.has(0), true);
      memory.tree.set(0, { l: 0, i: 0, text: 'revised 0', size: 9 });
      assert.equal(memory.tree.size, beforeSize);
      assert.equal(memory.tree.get(0)?.text, 'revised 0');
      assert.equal(memory.tree.delete(0), true);
      assert.equal(memory.tree.has(0), false);
      assert.equal(memory.tree.size, beforeSize - 1);
    } finally { await memory.close(); }
  } finally { removeDir(dir); }
});

test('Inbox.recover skips scanning memory.root when no pending inputs exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-inbox-empty-'));
  try {
    const inbox = new Inbox(dir);
    let rootReads = 0;
    const fakeMemory = { get root() { rootReads++; return []; } } as unknown as Memory;
    assert.equal(inbox.recover(fakeMemory), 0);
    assert.equal(rootReads, 0, 'empty inbox must not iterate memory.root');
  } finally { removeDir(dir); }
});

test('looking up summaries and messages across day files reads their lines, not whole files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-lookup-io-'));
  try {
    mkdirSync(join(dir, 'main')); mkdirSync(join(dir, 'tree'));
    const pad = 'x'.repeat(1_000_000), entry = (i: number) => ({ i, kind: 'user', text: `message ${i}`, date: '2026-01-01T00:00:00.000Z' });
    writeFileSync(join(dir, 'main', '2026-01-01.jsonl'), line({ ...entry(0), text: pad }) + line(entry(1)));
    writeFileSync(join(dir, 'main', '2026-01-02.jsonl'), line(entry(2)) + line(entry(3)));
    writeFileSync(join(dir, 'tree', '2026-01-01.jsonl'), line({ l: 0, i: 9, text: pad }) + line({ l: 0, i: 0, text: 'zero' }) + line({ l: 0, i: 1, text: 'one' }));
    writeFileSync(join(dir, 'tree', '2026-01-02.jsonl'), line({ l: 0, i: 8, text: pad }) + line({ l: 1, i: 0, text: 'pair' }) + line({ l: 0, i: 2, text: 'two '.repeat(3000) }));
    const store = new FileStore(dir, () => {});
    store.load(1);
    store.close();
    const before = store.readBytes;
    for (let k = 0; k < 5; k++) {
      assert.equal(store.nodeText(0, 0), 'zero');
      assert.equal(store.nodeText(1, 0), 'pair');
      assert.equal(store.nodeText(0, 1), 'one');
      assert.equal(store.nodeText(0, 2), 'two '.repeat(3000));
      assert.equal(store.reader(1)?.(), 'message 1');
      assert.equal(store.reader(3)?.(), 'message 3');
    }
    assert.ok(store.readBytes - before < 200_000, `read ${store.readBytes - before} bytes for 30 lookups`);
  } finally { removeDir(dir); }
});
