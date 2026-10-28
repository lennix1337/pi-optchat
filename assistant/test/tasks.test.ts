import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/store/db.ts';

const task = { version: 1 as const, profileId: 'p', taskId: '__proto__', title: 'Title', status: 'queued' as const, verification: 'not_verified' as const, revision: 1, inputRevision: 1, sourceEventId: 'source1' };
function event(sequence: number) { return { version: 1 as const, eventId: `event${sequence}`, profileId: 'p', sessionId: 'session', channelId: 'channel', taskId: task.taskId, runId: 'run', source: { actorId: 'actor', sourceKind: 'model' as const, sourceEventId: `source${sequence}` }, observedAt: '2026-10-28T12:00:00Z', sequence, correlationId: 'correlation', evidence: { kind: 'observed' as const, reference: 'original' } }; }
test('task journey and detached replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-')); const path = join(dir, 'db');
  try {
    let store = new TaskStore(path, 'p');
    store.create(task, event(1)); store.transition(task.taskId, 1, 'working', event(2)); store.transition(task.taskId, 2, 'needs_input', event(3));
    const response = { version: 1 as const, profileId: 'p', taskId: task.taskId, revision: 3, inputRevision: 2, text: 'private answer' };
    store.respond(response, event(4)); assert.throws(() => store.respond(response, event(5)));
    store.transition(task.taskId, 4, 'succeeded', event(5));
    const copy = store.get(task.taskId)!; copy.title = 'changed'; assert.equal(store.get(task.taskId)!.title, 'Title');
    assert.equal(JSON.stringify(store.events(0, 20)).includes('private answer'), false);
    store.close();
    const moduleUrl = new URL('../src/store/db.ts', import.meta.url).href;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `import { TaskStore } from ${JSON.stringify(moduleUrl)}; const s = new TaskStore(process.argv[1], 'p'); console.log(JSON.stringify(s.get('__proto__'))); s.close();`, path], { encoding: 'utf8' });
    assert.equal(JSON.parse(output).revision, 5);
    store = new TaskStore(path, 'p'); assert.equal(store.get(task.taskId)!.sourceEventId, 'source1'); assert.equal(store.events(0, 20)[0].event.evidence.reference, 'original'); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stale response revisions independently reject on a later needs_input cycle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-revisions-')); const path = join(dir, 'db');
  try {
    const store = new TaskStore(path, 'p'); const observer = new DatabaseSync(path);
    try {
    store.create(task, event(1)); store.transition(task.taskId, 1, 'working', event(2)); store.transition(task.taskId, 2, 'needs_input', event(3));
    store.respond({ version: 1, profileId: 'p', taskId: task.taskId, revision: 3, inputRevision: 2, text: 'first' }, event(4));
    store.transition(task.taskId, 4, 'needs_input', event(5));
    const before = store.get(task.taskId)!; const beforeEvents = store.events(0, 100);
    const beforeResponses = observer.prepare('SELECT * FROM responses ORDER BY input_revision').all();
    const response = { version: 1 as const, profileId: 'p', taskId: task.taskId, revision: 5, inputRevision: 3, text: 'second' };
    assert.throws(() => store.respond({ ...response, revision: 3 }, event(6)), /Stale or mismatched/);
    assert.deepEqual(store.get(task.taskId), before); assert.deepEqual(store.events(0, 100), beforeEvents);
    assert.deepEqual(observer.prepare('SELECT * FROM responses ORDER BY input_revision').all(), beforeResponses);
    assert.throws(() => store.respond({ ...response, inputRevision: 1 }, event(6)), /Stale or mismatched/);
    assert.deepEqual(store.get(task.taskId), before); assert.deepEqual(store.events(0, 100), beforeEvents);
    assert.deepEqual(observer.prepare('SELECT * FROM responses ORDER BY input_revision').all(), beforeResponses);
    store.respond(response, event(6));
    } finally { observer.close(); store.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('event snapshots replay to the live projection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-replay-')); const path = join(dir, 'db');
  try {
    const store = new TaskStore(path, 'p');
    store.create(task, event(1)); store.transition(task.taskId, 1, 'working', event(2)); store.transition(task.taskId, 2, 'needs_input', event(3));
    store.respond({ version: 1, profileId: 'p', taskId: task.taskId, revision: 3, inputRevision: 2, text: 'private' }, event(4));
    store.transition(task.taskId, 4, 'succeeded', event(5));
    const projection = new Map<string, typeof task | ReturnType<typeof store.get>>();
    for (const entry of store.events(0, 100)) projection.set(entry.task.taskId, entry.task);
    assert.deepEqual([...projection.values()], store.list(null, 100).tasks);
    assert.deepEqual(projection.get(task.taskId), store.get(task.taskId)); store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
