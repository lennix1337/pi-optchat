import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/store/db.ts';

const id = "x'); DROP TABLE tasks;--";
function task(profileId: string) { return { version: 1 as const, profileId, taskId: id, title: 'title', status: 'queued' as const, verification: 'not_verified' as const, revision: 1, inputRevision: 1, sourceEventId: 'source1' }; }
function event(profileId: string, sequence: number) { return { version: 1 as const, eventId: `event${sequence}`, profileId, sessionId: 'session', channelId: 'channel', taskId: id, runId: 'run', source: { actorId: 'actor', sourceKind: 'external' as const, sourceEventId: `source${sequence}` }, observedAt: '2026-10-28T12:00:00Z', sequence, correlationId: 'correlation', evidence: { kind: 'observed' as const, reference: 'reference' } }; }
function fixture(fn: (path: string) => void) { const dir = mkdtempSync(join(tmpdir(), 'assistant-ownership-')); try { fn(join(dir, 'db')); } finally { rmSync(dir, { recursive: true, force: true }); } }
test('profile scope, conflicts, sequence, pagination and independent writers', () => fixture(path => {
  const a = new TaskStore(path, 'a'); const b = new TaskStore(path, 'b'); const other = new TaskStore(path, 'a');
  try {
  a.create(task('a'), event('a', 1)); b.create(task('b'), event('b', 1));
  assert.equal(b.get(id)!.profileId, 'b'); assert.equal(b.get('missing'), null);
  assert.throws(() => a.create(task('a'), event('a', 2)));
  assert.throws(() => a.transition(id, 1, 'working', event('b', 2)));
  assert.throws(() => a.transition(id, 1, 'working', event('a', 3)));
  assert.throws(() => a.transition(id, 1, 'working', { ...event('a', 2), version: 2 } as never));
  assert.throws(() => a.transition(id, 1, 'working', { ...event('a', 2), eventId: 'event1' }));
  assert.throws(() => a.transition(id, 1, 'working', { ...event('a', 2), source: { ...event('a', 2).source, sourceEventId: 'source1' } }));
  a.transition(id, 1, 'working', event('a', 2));
  assert.throws(() => other.transition(id, 1, 'working', event('a', 3)));
  assert.equal(a.events(0, 100).length, 2); assert.equal(b.events(0, 100).length, 1);
  const list = a.list(null, 1); assert.equal(list.nextCursor, null); list.tasks[0].title = 'mutated'; assert.equal(a.get(id)!.title, 'title');
  const lock = new DatabaseSync(path); lock.exec('BEGIN IMMEDIATE'); assert.throws(() => other.transition(id, 2, 'needs_input', event('a', 3))); lock.exec('ROLLBACK'); lock.close();
  a.transition(id, 2, 'needs_input', event('a', 3));
  assert.throws(() => b.respond({ version: 1, profileId: 'a', taskId: id, revision: 3, inputRevision: 2, text: 'private' }, event('b', 2)));
  assert.equal(b.events(0, 100).length, 1);
  } finally { a.close(); b.close(); other.close(); }
}));
test('actual SQL failure rolls back event and private response', () => fixture(path => {
  const a = new TaskStore(path, 'a'); a.create(task('a'), event('a', 1)); a.transition(id, 1, 'working', event('a', 2)); a.transition(id, 2, 'needs_input', event('a', 3));
  const raw = new DatabaseSync(path); raw.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'fault'); END");
  assert.throws(() => a.respond({ version: 1, profileId: 'a', taskId: id, revision: 3, inputRevision: 2, text: 'private' }, event('a', 4)));
  assert.equal(a.events(0, 100).length, 3); assert.equal(a.get(id)!.revision, 3); assert.equal(raw.prepare('SELECT count(*) AS n FROM responses').get()!.n, 0);
  assert.equal(raw.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok'); raw.close(); a.close();
}));
test('newer and unversioned unknown schemas refused without migration', () => fixture(path => {
  let raw = new DatabaseSync(path); raw.exec('PRAGMA user_version = 2'); raw.close(); assert.throws(() => new TaskStore(path, 'a'));
  raw = new DatabaseSync(path); assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 2); raw.exec('PRAGMA user_version = 0; CREATE TABLE unknown (id INTEGER)'); raw.close();
  assert.throws(() => new TaskStore(path, 'a')); raw = new DatabaseSync(path); assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 0); assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'tasks'").get()!.n, 0);
  raw.exec('DROP TABLE unknown; CREATE VIEW events AS SELECT 1'); raw.close();
  assert.throws(() => new TaskStore(path, 'a')); raw = new DatabaseSync(path); assert.equal(raw.prepare('PRAGMA user_version').get()!.user_version, 0); assert.equal(raw.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'tasks'").get()!.n, 0); raw.close();
}));

test('multipage continuation preserves every task and event in order', () => fixture(path => {
  const store = new TaskStore(path, 'a');
  for (let i = 1; i <= 7; i++) {
    const taskId = `task-${i}`;
    store.create({ ...task('a'), taskId, sourceEventId: `source${i}` }, { ...event('a', i), taskId });
  }
  const ids: string[] = []; let cursor: string | null = null; let pages = 0;
  do { const page = store.list(cursor, 2); ids.push(...page.tasks.map(item => item.taskId)); cursor = page.nextCursor; pages++; assert.ok(pages <= 4); } while (cursor !== null);
  assert.deepEqual(ids, Array.from({ length: 7 }, (_, i) => `task-${i + 1}`)); assert.equal(pages, 4);
  const sequences: number[] = []; let after = 0;
  for (;;) { const page = store.events(after, 2); if (!page.length) break; sequences.push(...page.map(item => item.event.sequence)); after = page[page.length - 1].event.sequence; assert.ok(sequences.length <= 7); }
  assert.deepEqual(sequences, [1, 2, 3, 4, 5, 6, 7]); store.close();
}));

test('get list and events perform no SQLite writes', () => fixture(path => {
  const store = new TaskStore(path, 'a'); store.create(task('a'), event('a', 1));
  const observer = new DatabaseSync(path);
  const beforeVersion = observer.prepare('PRAGMA data_version').get()!.data_version;
  const beforeChanges = observer.prepare('SELECT total_changes() AS n').get()!.n;
  store.get(id); store.get('missing'); store.list(null, 1); store.events(0, 1);
  assert.equal(observer.prepare('PRAGMA data_version').get()!.data_version, beforeVersion);
  assert.equal(observer.prepare('SELECT total_changes() AS n').get()!.n, beforeChanges);
  observer.close(); store.close();
}));

test('profile filters isolate distinct task and event identities', () => fixture(path => {
  const a = new TaskStore(path, 'a'); const b = new TaskStore(path, 'b');
  try {
  assert.throws(() => a.create({ ...task('b'), taskId: 'wrong-profile' }, { ...event('a', 1), taskId: 'wrong-profile' }), /Invalid initial task/);
  a.create(task('a'), event('a', 1));
  b.create({ ...task('b'), taskId: 'only-b' }, { ...event('b', 1), taskId: 'only-b' });
  assert.equal(a.get('only-b'), null); assert.deepEqual(a.list(null, 10).tasks.map(t => t.taskId), [id]);
  assert.deepEqual(a.events(0, 10).map(e => e.event.profileId), ['a']);
  assert.throws(() => a.transition(id, 1, 'working', event('b', 2)), /identity mismatch/);
  assert.deepEqual(a.events(0, 10).map(e => e.event.sequence), [1]);
  } finally { a.close(); b.close(); }
}));

test('stale transition revision rejects an otherwise legal transition', () => fixture(path => {
  const store = new TaskStore(path, 'a');
  try {
    store.create(task('a'), event('a', 1)); store.transition(id, 1, 'working', event('a', 2));
    const before = store.get(id); const events = store.events(0, 10);
    assert.throws(() => store.transition(id, 1, 'needs_input', event('a', 3)), /revision/);
    assert.deepEqual(store.get(id), before); assert.deepEqual(store.events(0, 10), events);
  } finally { store.close(); }
}));
