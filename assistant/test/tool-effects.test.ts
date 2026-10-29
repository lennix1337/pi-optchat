import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createGateway } from '../src/policy/gateway.ts';
import { ToolEffects } from '../src/runtime/tool-effects.ts';

test('tool review remains waiting until an exact gateway grant and cannot replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-effects-'));
  const authority = {};
  const gateway = createGateway({ databasePath: join(dir, 'policy.sqlite'), profileId: 'p', operatorAuthority: authority,
    policy: () => 'review', inspect: () => ({ decision: 'allow', reasons: [] }) });
  let calls = 0;
  const taskDb = new DatabaseSync(join(dir, 'tools.sqlite'));
  taskDb.exec(`CREATE TABLE tasks (profile TEXT, id TEXT, snapshot TEXT); INSERT INTO tasks VALUES ('p', 't', '{"status":"working","revision":1}'); CREATE TABLE lease (name TEXT PRIMARY KEY, owner TEXT, token INTEGER); INSERT INTO lease VALUES ('worker','owner',1)`); taskDb.close();
  const lease = { owner: 'owner', token: 1 };
  const effects = new ToolEffects(join(dir, 'tools.sqlite'), {
    prepare: request => gateway.prepare(request), status: id => gateway.status(id),
    ready: (request, id) => gateway.reviewReady(request, id),
    dispatch: (request, id) => gateway.dispatchReviewed(request, id, bytes => { calls++; return Buffer.from(bytes).toString(); }),
  }, (task, revision) => task === 't' && revision === 1);
  try {
    const request = { version: 1 as const, operationId: 'o', profileId: 'p', sessionId: 's', taskId: 't', runId: 'r',
      adapter: 'computer', action: 'browser_text', account: 'c', destination: 'd', policyVersion: 'v', expiresAt: Date.now() + 60_000, payload: Buffer.from('hello') };
    const pending = effects.prepare(request, 1);
    assert.equal((await effects.resume(pending.id, lease)).state, 'waiting');
    assert.equal(calls, 0);
    gateway.decide(pending.reviewId!, 'approve', authority);
    const result = await effects.resume(pending.id, lease);
    assert.equal(result.state, 'done'); assert.equal(result.result, 'hello'); assert.equal(calls, 1);
    await assert.rejects(effects.resume(pending.id, lease), /tool_stale/);
    assert.throws(() => effects.prepare({ ...request, action: 'shell' }, 1), /tool_not_admitted/);
    assert.throws(() => effects.prepare({ ...request, operationId: 'stale' }, 2), /tool_not_admitted/);
    const cancelled = effects.prepare({ ...request, operationId: 'cancel' }, 1);
    assert.equal(effects.cancel(cancelled.id), true);
    await assert.rejects(effects.resume(cancelled.id, lease), /tool_stale/);
    assert.equal(calls, 1);
    const stale = effects.prepare({ ...request, operationId: 'cancelled-task' }, 1);
    const writer = new DatabaseSync(join(dir, 'tools.sqlite'));
    writer.prepare('UPDATE tasks SET snapshot = ?').run(JSON.stringify({ status: 'cancelled', revision: 2 }));
    await assert.rejects(effects.resume(stale.id, lease), /tool_stale/);
    writer.prepare('UPDATE tasks SET snapshot = ?').run(JSON.stringify({ status: 'working', revision: 1 })); writer.close();
    const interrupted = effects.prepare({ ...request, operationId: 'interrupted' }, 1);
    const raw = new DatabaseSync(join(dir, 'tools.sqlite'));
    raw.prepare("UPDATE tool_effects SET state = 'dispatching' WHERE id = ?").run(interrupted.id); raw.close();
    assert.equal(effects.get(interrupted.id).state, 'dispatching');
    await assert.rejects(effects.resume(interrupted.id, lease), /tool_stale/);
    assert.equal(calls, 1);
    const misleading = new ToolEffects(join(dir, 'tools.sqlite'), {
      prepare: () => ({ decision: 'review', reviewId: 'test' }), status: () => 'absent', ready: () => true,
      dispatch: async () => { throw new Error('approval_required'); },
    }, () => true);
    try {
      const ambiguous = misleading.prepare({ ...request, operationId: 'ambiguous' }, 1);
      assert.equal((await misleading.resume(ambiguous.id, lease)).state, 'uncertain');
      await assert.rejects(misleading.resume(ambiguous.id, lease), /tool_stale/);
    } finally { misleading.close(); }
  } finally { effects.close(); gateway.close(); rmSync(dir, { recursive: true, force: true }); }
});
