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
import { browserTextPort } from '../src/runtime/tool-browser.ts';
import { WorkerRuntime } from '../src/runtime/worker.ts';
import { createBackup, restoreBackup } from '../src/ops/backup.ts';
import { memoryProtector, privateDir } from './vault-support.ts';

test('restore before a real reviewed browser dispatch cannot replay it', () => privateDir('tool-backup-', async root => {
  const data = join(root, 'data'), restored = join(root, 'restored'), out = join(root, 'snapshot.backup'); mkdirSync(data); mkdirSync(restored);
  const db = join(data, 'tasks.sqlite'), authority = {}, profile = 'p'; const { protector } = memoryProtector(); let calls = 0;
  const store = new TaskStore(db, profile);
  const event = (id: string) => ({ version: 1 as const, eventId: id, correlationId: id, profileId: profile, taskId: 't', sessionId: 's', channelId: 'c', runId: 'r', source: { actorId: 'human', sourceKind: 'trusted-local-human' as const, sourceEventId: id }, observedAt: new Date().toISOString(), sequence: store.nextSequence(), evidence: { kind: 'observed' as const, reference: 'test' } });
  store.create(queuedTask(profile, 't', 'x', 'create'), event('create')); store.transition('t', 1, 'working', event('working'));
  const gateway = createGateway({ databasePath: join(data, 'gateway.sqlite'), profileId: profile, operatorAuthority: authority, policy: () => 'review', inspect: () => ({ decision: 'allow', reasons: [] }) });
  const computers = createComputers({ databasePath: join(data, 'computer.sqlite'), owner: `backup-${randomUUID()}`, operatorAuthority: authority, image: 'optchat-computer-browser:1' });
  const worker = new WorkerRuntime({ databasePath: db, owner: 'w' }); const port = browserTextPort(gateway, computers);
  const effects = new ToolEffects(db, { ...port, dispatch: async (request, review) => { calls++; return port.dispatch(request, review); } }, (id, revision) => store.get(id)?.revision === revision);
  try {
    await worker.acquire(); const computer = await computers.create(profile, 'agent');
    const request = browserTextRequest({ version: 1, operationId: 'operation', profileId: profile, sessionId: 's', taskId: 't', runId: 'r', policyVersion: 'v', expiresAt: Date.now() + 120000 }, computer, 'backup browser proof');
    const pending = effects.prepare(request, 2);
    await createBackup({ databasePath: db, profileId: profile, out, protector });
    gateway.decide(pending.reviewId!, 'approve', authority);
    const result = await effects.resume(pending.id, worker.leaseIdentity()); assert.equal(result.state, 'done'); assert.match(String(result.result), /backup browser proof/); assert.equal(calls, 1);
    const report = await restoreBackup({ backup: out, into: restored, profileId: profile, protector }); assert.equal(report.fenced.toolEffects, 1);
    const copyStore = new TaskStore(join(restored, 'tasks.sqlite'), profile);
    const copyGateway = createGateway({ databasePath: join(restored, 'gateway.sqlite'), profileId: profile, operatorAuthority: authority, policy: () => 'review', inspect: () => ({ decision: 'allow', reasons: [] }) });
    const copyWorker = new WorkerRuntime({ databasePath: join(restored, 'tasks.sqlite'), owner: 'copy' });
    const copyPort = browserTextPort(copyGateway, computers);
    const copyEffects = new ToolEffects(join(restored, 'tasks.sqlite'), { ...copyPort, dispatch: async (r, review) => { calls++; return copyPort.dispatch(r, review); } }, (id, rev) => copyStore.get(id)?.revision === rev);
    try {
      await copyWorker.acquire(); const review = copyGateway.prepare(request); assert.equal(review.decision, 'review');
      if (review.decision !== 'review') throw new Error('review'); copyGateway.decide(review.reviewId, 'approve', authority);
      assert.equal(copyEffects.get(pending.id).state, 'uncertain');
      await assert.rejects(copyEffects.resume(pending.id, copyWorker.leaseIdentity()), /tool_stale/); assert.equal(calls, 1);
    } finally { await copyWorker.stop(); copyWorker.close(); copyEffects.close(); copyGateway.close(); copyStore.close(); }
  } finally { await worker.stop(); worker.close(); effects.close(); gateway.close(); store.close(); await computers.cleanup(); computers.close(); }
}));
