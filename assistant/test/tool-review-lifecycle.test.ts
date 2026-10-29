import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/store/db.ts';
import { createGateway } from '../src/policy/gateway.ts';
import { browserTextPort } from '../src/runtime/tool-browser.ts';
import { browserTextRequest } from '../src/computer/effects.ts';
import type { ComputerManager } from '../src/computer/manager.ts';
import { ToolEffects } from '../src/runtime/tool-effects.ts';
import { ToolTask } from '../src/runtime/tool-task.ts';
import { TaskExecutor } from '../src/runtime/task-executor.ts';
import { queuedTask } from './task-fixtures.ts';

const profile = 'review-life', computer = { id: 'cmp_fake', profileId: profile, agentId: 'executor', container: 'fake-container', state: 'ready' as const, expiresAt: Date.now() + 3_600_000 };

/** A preview review nobody approves: the operator denies or revokes it, or its window closes. The task must end, the pass must not wedge. */
async function rig(windowMs: number, act: (reviewId: string, gateway: ReturnType<typeof createGateway>, authority: object) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'tool-review-life-')), authority = {}, path = join(dir, 'tasks.sqlite');
  const store = new TaskStore(path, profile); let dispatched = 0;
  const gateway = createGateway({ databasePath: join(dir, 'gateway.sqlite'), profileId: profile, operatorAuthority: authority, policy: () => 'review', inspect: () => ({ decision: 'allow', reasons: [] }) });
  const port = browserTextPort(gateway, {} as ComputerManager);
  const effects = new ToolEffects(path, { ...port, dispatch: async () => { dispatched++; return 'must not run'; } }, (id, revision) => { const task = store.get(id); return task?.status === 'working' && task.revision === revision; });
  const id = 'task';
  store.create(queuedTask(profile, id, 'preview', 'create'), { version: 1, eventId: 'create', correlationId: 'create', profileId: profile, taskId: id, sessionId: 's', channelId: 'panel', runId: 'r',
    source: { actorId: 'human', sourceKind: 'trusted-local-human', sourceEventId: 'create' }, observedAt: new Date().toISOString(), sequence: store.nextSequence(), evidence: { kind: 'observed', reference: 'test' } });
  const executor = new TaskExecutor({ store, profileId: profile, databasePath: path, channels: ['panel'], run: async () => ({ kind: 'browser_text', text: 'texto' }),
    tools: { task: new ToolTask(store, effects, profile, 'panel'), request: (task, text, operationId) => browserTextRequest({ version: 1, operationId, profileId: profile, sessionId: 's', taskId: task.taskId, runId: 'r', policyVersion: 'v', expiresAt: Date.now() + windowMs }, computer, text) } });
  try {
    await executor.tick();
    const waiting = effects.pending()[0]; assert.equal(waiting.state, 'waiting');
    await act(waiting.reviewId!, gateway, authority);
    await executor.tick(); await executor.tick();
    assert.equal(store.get(id)!.status, 'failed', 'the unanswered preview ends the task visibly');
    assert.match(store.events().at(-1)!.event.evidence.reference, /negada|revogada|expirou/);
    assert.equal(effects.get(waiting.id).state, 'cancelled');
    assert.equal(dispatched, 0, 'nothing was dispatched');
    assert.equal(executor.status().failing, false);
  } finally { await executor.close(); effects.close(); gateway.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('a denied preview review fails the task without dispatch', () => rig(120_000, async (reviewId, gateway, authority) => gateway.decide(reviewId, 'deny', authority)));
test('a revoked preview review fails the task without dispatch', () => rig(120_000, async (reviewId, gateway, authority) => gateway.revoke(reviewId, authority)));
test('an expired preview review fails the task instead of wedging the executor pass', () => rig(400, async () => { await new Promise(resolve => setTimeout(resolve, 600)); }));
