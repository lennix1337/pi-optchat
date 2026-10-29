import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/store/db.ts';
import { queuedTask } from './task-fixtures.ts';
import { createComputers } from '../src/computer/manager.ts';
import { browserTextRequest } from '../src/computer/effects.ts';
import { createGateway } from '../src/policy/gateway.ts';
import { ToolEffects } from '../src/runtime/tool-effects.ts';
import { ToolTask } from '../src/runtime/tool-task.ts';
import { browserTextPort } from '../src/runtime/tool-browser.ts';
import { WorkerRuntime } from '../src/runtime/worker.ts';
import { TaskExecutor } from '../src/runtime/task-executor.ts';
import { createBackup, restoreBackup } from '../src/ops/backup.ts';
import { memoryProtector, privateDir } from './vault-support.ts';

test('restore fences completed preview plan before effect handoff without fencing plain draft', () => privateDir('tool-handoff-', async root => {
  const data = join(root, 'data'), restored = join(root, 'restored'), out = join(root, 'snapshot.backup'); mkdirSync(data, { mode: 0o700 }); mkdirSync(restored, { mode: 0o700 });
  const db = join(data, 'tasks.sqlite'), authority = {}, profile = 'p'; const { protector } = memoryProtector(); let calls = 0, generations = 0;
  const store = new TaskStore(db, profile);
  const event = (id: string) => ({ version: 1 as const, eventId: id, correlationId: id, profileId: profile, taskId: 't', sessionId: 's', channelId: 'c', runId: 'r', source: { actorId: 'human', sourceKind: 'trusted-local-human' as const, sourceEventId: id }, observedAt: new Date().toISOString(), sequence: store.nextSequence(), evidence: { kind: 'observed' as const, reference: 'test' } });
  store.create(queuedTask(profile, 't', 'x', 'create'), event('create')); store.transition('t', 1, 'working', event('working'));
  const gateway = createGateway({ databasePath: join(data, 'gateway.sqlite'), profileId: profile, operatorAuthority: authority, policy: () => 'review', inspect: () => ({ decision: 'allow', reasons: [] }) });
  const computers = createComputers({ databasePath: join(data, 'computer.sqlite'), owner: `handoff-${randomUUID()}`, operatorAuthority: authority, image: 'optchat-computer-browser:1' });
  const worker = new WorkerRuntime({ databasePath: db, owner: 'seed', handlers: { draft: input => input } });
  const port = browserTextPort(gateway, computers);
  const effects = new ToolEffects(db, { ...port, dispatch: async (request, review) => { calls++; return port.dispatch(request, review); } }, (id, revision) => store.get(id)?.revision === revision);
  try {
    await worker.acquire(); worker.enqueue('draft:t:2', 'draft', { kind: 'browser_text', text: 'handoff preview' });
    worker.enqueue('draft:plain:2', 'draft', { kind: 'draft', text: 'plain stays done' });
    await worker.runOnce(); assert.equal(worker.job('draft:t:2')!.state, 'done'); assert.equal(worker.job('draft:plain:2')!.state, 'done');
    assert.equal(effects.pending().length, 0);
    await createBackup({ databasePath: db, profileId: profile, out, protector });
    await worker.stop(); const computer = await computers.create(profile, 'agent');
    const build = (task: any, text: string, operationId: string) => browserTextRequest({ version: 1, operationId, profileId: profile, sessionId: 's', taskId: task.taskId, runId: 'r', policyVersion: 'v', expiresAt: Date.now() + 120000 }, computer, text);
    const executor = new TaskExecutor({ store, profileId: profile, databasePath: db, channels: ['c'], run: async () => { generations++; return { kind: 'draft', text: 'unexpected' }; }, tools: { task: new ToolTask(store, effects, profile, 'c'), request: build } });
    try {
      await executor.tick(); const pending = effects.pending()[0]; assert.equal(pending.state, 'waiting');
      gateway.decide(pending.reviewId!, 'approve', authority); await executor.tick();
      assert.equal(effects.get(pending.id).state, 'done'); assert.match(String(effects.get(pending.id).result), /handoff preview/); assert.equal(calls, 1);
    } finally { await executor.close(); }
    const report = await restoreBackup({ backup: out, into: restored, profileId: profile, protector });
    const copyDb = join(restored, 'tasks.sqlite'), copyStore = new TaskStore(copyDb, profile);
    const copyGateway = createGateway({ databasePath: join(restored, 'gateway.sqlite'), profileId: profile, operatorAuthority: authority, policy: () => 'review', inspect: () => ({ decision: 'allow', reasons: [] }) });
    const copyPort = browserTextPort(copyGateway, computers);
    const copyEffects = new ToolEffects(copyDb, { ...copyPort, dispatch: async (r, review) => { calls++; return copyPort.dispatch(r, review); } }, (id, revision) => copyStore.get(id)?.revision === revision);
    const copyWorker = new WorkerRuntime({ databasePath: copyDb, owner: 'observe' });
    const copyExecutor = new TaskExecutor({ store: copyStore, profileId: profile, databasePath: copyDb, channels: ['c'], run: async () => { generations++; return { kind: 'draft', text: 'unexpected' }; }, tools: { task: new ToolTask(copyStore, copyEffects, profile, 'c'), request: build } });
    try {
      assert.equal(copyWorker.job('draft:t:2')!.state, 'blocked', 'restored preview job must not recreate effect');
      assert.equal(copyWorker.job('draft:plain:2')!.state, 'done', 'plain draft must remain done');
      assert.equal(report.fenced.jobs, 1); await copyExecutor.tick();
      assert.equal(copyEffects.pending().length, 0); assert.equal(calls, 1); assert.equal(generations, 0);
    } finally { await copyExecutor.close(); copyWorker.close(); copyEffects.close(); copyGateway.close(); copyStore.close(); }
  } finally { await worker.stop(); worker.close(); effects.close(); gateway.close(); store.close(); await computers.cleanup(); computers.close(); }
}));
