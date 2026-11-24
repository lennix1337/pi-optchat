import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, type Entry, type Summary } from '../src/memory.ts';
import { appendRecent, atomicWrite, FileStore, localDay, readJsonl, type Lease, type Saved, type Store } from '../src/store.ts';
import { holdProfile, HEARTBEAT_MS, isWindows, ProfileBusyError, profileSocket } from '../src/profiles.ts';
import { removeDir, withTempDir } from './support.ts';

const entry = (i: number, text: string): Entry => ({ i, kind: 'user', text, size: 0, date: '2026-10-09T12:00:00.000Z' });
const node = (i: number, text: string): Summary => ({ l: 0, i, text, size: 0 });
const temp = () => mkdtempSync(join(tmpdir(), 'optchat-store-'));


function contract(name: string, open: (dir: string, warn: (s: string) => void) => Store) {
  test(`${name}: what is written loads back, in order, in a fresh store`, async () => {
    const dir = temp();
    try {
      const store = open(dir, () => {});
      await store.load();
      for (const [i, text] of ['one', 'two', 'three'].entries()) await store.append(entry(i, text));
      await store.appendNode(node(0, 'first summary'));
      await store.saveView('[[0,0]]'); await store.saveView('[[0,0],[0,1]]');
      const saved = await open(dir, () => {}).load();
      assert.deepEqual(saved.entries, ['one', 'two', 'three'].map((text, i) => entry(i, text)));
      assert.deepEqual(saved.tree, [node(0, 'first summary')]);
      assert.equal(saved.view, '[[0,0],[0,1]]');
    } finally { removeDir(dir); }
  });
  test(`${name}: a store refuses to append after another one appended`, async () => {
    const dir = temp();
    try {
      const a = open(dir, () => {}), b = open(dir, () => {});
      await a.load(); await b.load();
      await a.append(entry(0, 'from a'));
      await assert.rejects(async () => b.append(entry(0, 'from b')), /nothing was written/);
      assert.deepEqual((await open(dir, () => {}).load()).entries, [entry(0, 'from a')]);
    } finally { removeDir(dir); }
  });
  test(`${name}: images come back as they were put, and an unknown one is missing`, async () => {
    const dir = temp();
    try {
      const store = open(dir, () => {}), data = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      await store.load();
      await store.putImage('0123456789abcdef', 'image/png', data);
      const kept = await open(dir, () => {}).image('0123456789abcdef');
      assert.equal(kept?.mimeType, 'image/png');
      assert.deepEqual(Uint8Array.from(kept?.data ?? []), data);
      assert.equal(await store.image('fedcba9876543210'), undefined);
    } finally { removeDir(dir); }
  });
}
contract('FileStore', (dir, warn) => new FileStore(dir, warn));

test('FileStore: a line torn by a crash is skipped with a warning, and the next append starts on a fresh line', () => {
  const dir = temp();
  try {
    new FileStore(dir).load();
    const first = new FileStore(dir); first.load(); first.append(entry(0, 'kept'));
    appendFileSync(join(dir, 'main', `${localDay()}.jsonl`), '{"i":1,"kind":"us');
    const warnings: string[] = [], reopened = new FileStore(dir, text => warnings.push(text));
    assert.deepEqual(reopened.load().entries, [entry(0, 'kept')]);
    assert.match(warnings.join('\n'), /Skipped damaged JSON at .*:2/);
    reopened.append(entry(1, 'after the crash'));
    assert.deepEqual(new FileStore(dir, () => {}).load().entries, [entry(0, 'kept'), entry(1, 'after the crash')]);
  } finally { removeDir(dir); }
});

test('a process interrupted before the JSONL commit newline cannot activate or later promote a summary', () => {
  const dir = temp(), originals = [entry(0, 'first original'), entry(1, 'second original')];
  const leaves = [node(0, 'first summary'), { ...node(1, 'second summary'), i: 1 }];
  const parent = { l: 1, i: 0, text: 'parent summary', size: 0 };
  try {
    const store = new FileStore(dir, () => {}); store.load();
    for (const original of originals) store.append(original);
    for (const leaf of leaves) store.appendNode(leaf);
    const file = join(dir, 'tree', `${localDay()}.jsonl`);
    const interrupted = spawnSync(process.execPath, ['-e',
      "const {openSync,writeSync}=require('node:fs'); const fd=openSync(process.argv[1],'a'); writeSync(fd,process.argv[2]); process.exit(73);",
      file, JSON.stringify(parent)], { encoding: 'utf8' });
    assert.equal(interrupted.status, 73, interrupted.stderr);

    const warnings: string[] = [], resumed = new FileStore(dir, text => warnings.push(text));
    const recovered = resumed.load();
    assert.deepEqual(recovered.entries, originals, 'the append-only original log is unchanged');
    assert.deepEqual(recovered.tree, leaves, 'an unterminated summary is not committed');
    assert.match(warnings.join('\n'), /Skipped damaged JSON at .*tree.*:3/);

    resumed.appendNode(parent);
    const reopened = new FileStore(dir, () => {}).load();
    assert.deepEqual(reopened.entries, originals);
    assert.deepEqual(reopened.tree, [...leaves, parent], 'the next append discards, rather than promotes, the interrupted tail');
  } finally { removeDir(dir); }
});

test('a store with a lease holds the profile instead of the local lock, renews it, and frees it on release', async () => {

  let holder: string | undefined, beats = 0;
  const machine = (): { lock: Lease } => ({ lock: {
    async lease(_profile, who) { if (holder !== undefined) return holder; holder = who; return undefined; },
    async heartbeat() { beats++; },
    async release() { holder = undefined; },
  } });
  const dir = temp();
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const release = await holdProfile(machine(), dir, 'work', 'laptop', () => {});
    if (!isWindows) assert.equal(existsSync(profileSocket(dir)), false, 'the machine-local lock is not taken');
    await assert.rejects(holdProfile(machine(), dir, 'work', 'desktop', () => {}), error => error instanceof ProfileBusyError && error.owner === 'laptop');
    mock.timers.tick(HEARTBEAT_MS * 3);
    assert.equal(beats, 3);
    await release();
    mock.timers.tick(HEARTBEAT_MS * 3);
    assert.equal(beats, 3, 'no renewals after release');
    await (await holdProfile(machine(), dir, 'work', 'desktop', () => {}))();
  } finally { mock.timers.reset(); removeDir(dir); }
});


function behind() {
  const landed: string[] = [];
  let fail = false, delay = 20;
  const later = (text: string) => {
    const failing = fail, ms = Math.max(1, delay -= 3);
    return new Promise<void>((resolve, reject) => setTimeout(() => failing ? reject(new Error('offline')) : (landed.push(text), resolve()), ms));
  };
  const store: Store = {
    load: async (): Promise<Saved> => ({ entries: [], tree: [] }),
    append: e => later(e.text), appendNode: n => later(`node ${n.i}`), saveView: () => later('view'),
    putImage: () => later('image'), image: async () => undefined,
  };
  return { store, landed, failing: (on: boolean) => { fail = on; } };
}

test('a store that writes behind gets its writes one at a time, in the order Memory made them', async () => {
  const { store, landed } = behind();
  const memory = new Memory({ directory: temp(), store, saved: await store.load() }, async () => 'unused', () => {});
  for (const text of ['one', 'two', 'three']) memory.append('user', text);
  assert.equal(landed.length, 0, 'appends return before their writes land');
  await memory.settle(undefined, 'tree'); await memory.close();
  assert.deepEqual(landed.filter(text => !text.startsWith('node') && text !== 'view'), ['one', 'two', 'three']);
  assert.ok(landed.indexOf('node 0') > landed.indexOf('one'), 'a node lands after its message');
});

test('once a write-behind append fails, nothing more is written, summary nodes included, even if the store recovers', async () => {
  const { store, landed, failing } = behind(), warnings: string[] = [];
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const memory = new Memory({ directory: temp(), store, saved: await store.load() }, async () => { await gate; return 'summary'; }, text => warnings.push(text));
  const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  await wait(30); landed.length = 0;

  failing(true); memory.append('user', 'lost '.repeat(200)); memory.append('user', 'queued behind it');
  await wait(60);
  assert.match(warnings.join('\n'), /Memory could not be saved: offline/);
  failing(false); release();
  await wait(60);
  assert.deepEqual(landed, [], 'no message, node or view is written after the failed append');
  assert.throws(() => memory.append('user', 'more'), /Memory could not be saved: offline/);
  await memory.close();
});

test('a timed log past its size keeps only the records younger than the window, measured from the newest one', () => withTempDir('jsonl-', dir => {
  const file = join(dir, 'log.jsonl');
  for (const at of [0, 50, 90]) appendRecent(file, { at }, 1_000_000, 40);
  assert.deepEqual(readJsonl<{ at: number }>(file, () => true).map(e => e.at), [0, 50, 90], 'under the size cap nothing is dropped');
  appendFileSync(file, 'torn{\n');
  appendRecent(file, { at: 100 }, 10, 40);
  assert.deepEqual(readJsonl<{ at: number }>(file, () => true).map(e => e.at), [90, 100], 'past the cap: old records and the torn line go');
}));

test('FileStore: a message text is read back from its line, loaded or appended, with accents intact, and a moved line is refused', () => {
  const dir = temp();
  try {
    const first = new FileStore(dir); first.load(); first.append(entry(0, 'já carregada')); first.append(entry(1, 'segunda'));
    const store = new FileStore(dir); store.load();
    store.append(entry(2, 'acrescentada ção'));
    assert.equal(store.reader(0)?.(), 'já carregada');
    assert.equal(store.reader(1)?.(), 'segunda');
    assert.equal(store.reader(2)?.(), 'acrescentada ção');
    assert.equal(store.reader(3), undefined);
    const swapped = new FileStore(dir); swapped.load();
    const file = join(dir, 'main', `${localDay()}.jsonl`);
    writeFileSync(file, readFileSync(file, 'utf8').replace('"i":1', '"i":7'));
    assert.throws(() => swapped.reader(1)!(), /no longer where it was/);
  } finally { removeDir(dir); }
});

test('a past day of the log is parsed once: later opens take its records from a small index, and a changed day is parsed again', () => {
  const dir = temp();
  try {
    const main = join(dir, 'main'), tree = join(dir, 'tree');
    mkdirSync(main, { recursive: true }); mkdirSync(tree, { recursive: true });
    const past = join(main, '2020-01-01.jsonl');
    writeFileSync(past, [entry(0, 'old one'), entry(1, 'old two')].map(e => JSON.stringify(e) + '\n').join(''));
    writeFileSync(join(main, '2020-01-02.jsonl'), JSON.stringify(entry(2, 'today')) + '\n');
    writeFileSync(join(tree, '2020-01-01.jsonl'), [node(0, 's0'), node(1, 's1'), node(2, 's2')].map(n => JSON.stringify(n) + '\n').join(''));
    const first = new FileStore(dir, () => {}).load(1);
    const cold = { i: 0, kind: 'user', date: entry(0, '').date, size: Buffer.byteLength('user: old one') };
    assert.deepEqual(first.entries[0], cold);
    const index = join(dir, 'load-index', '2020-01-01.jsonl.json');
    assert.ok(existsSync(index), 'the past day gets an index');
    assert.ok(!existsSync(join(dir, 'load-index', '2020-01-02.jsonl.json')), 'the newest day, still written to, gets none');

    const saved = JSON.parse(readFileSync(index, 'utf8'));
    saved.rows[0][2].size = 999; writeFileSync(index, JSON.stringify(saved));
    const second = new FileStore(dir, () => {});
    assert.equal((second.load(1).entries[0] as { size: number }).size, 999);
    assert.equal(second.reader(1)?.(), 'old two', 'texts still read back from the log');

    appendFileSync(past, JSON.stringify(entry(3, 'late')) + '\n');
    assert.deepEqual(new FileStore(dir, () => {}).load(1).entries[0], cold);
  } finally { removeDir(dir); }
});

test('atomicWrite targeting an existing directory fails immediately without blocking on lock retries or leaving a temp file', () => {
  withTempDir('optchat-atomic-dir-', dir => {
    const target = join(dir, 'occupied');
    mkdirSync(target);
    const started = performance.now();
    assert.throws(() => atomicWrite(target, 'payload'));
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 500, `atomicWrite over a directory took ${Math.round(elapsed)} ms instead of failing immediately`);
    assert.equal(existsSync(`${target}.${process.pid}.tmp`), false, 'temp file is removed after failure');
  });
});
