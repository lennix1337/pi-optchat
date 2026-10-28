import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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
