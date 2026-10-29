import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/store/db.ts';
import { queuedTask } from './task-fixtures.ts';
import { createComputers } from '../src/computer/manager.ts';
import { browserTextRequest, openBrowserText } from '../src/computer/effects.ts';
import { createGateway } from '../src/policy/gateway.ts';
import { ToolEffects } from '../src/runtime/tool-effects.ts';
import { ToolTask } from '../src/runtime/tool-task.ts';
import { browserTextPort } from '../src/runtime/tool-browser.ts';
import { TaskExecutor } from '../src/runtime/task-executor.ts';

test('scripted browser action requires review and projects the real offline snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tool-journey-')); const authority = {}; const profile = 'tool-test';
  const store = new TaskStore(join(dir, 'tasks.sqlite'), profile);
  const computers = createComputers({ databasePath: join(dir, 'computer.sqlite'), owner: `test-${randomUUID()}`, operatorAuthority: authority, image: 'optchat-computer-browser:1' });
  const gateway = createGateway({ databasePath: join(dir, 'gateway.sqlite'), profileId: profile, operatorAuthority: authority, policy: () => 'review', inspect: () => ({ decision: 'allow', reasons: [] }) });
  const effects = new ToolEffects(join(dir, 'tasks.sqlite'), browserTextPort(gateway, computers),
    (id, rev) => { const task = store.get(id); return task?.status === 'working' && task.revision === rev; });
  try {
    const event = (id: string) => ({ version: 1 as const, eventId: id, correlationId: id, profileId: profile, taskId: 'task', sessionId: 's', channelId: 'panel', runId: 'r',
      source: { actorId: 'human', sourceKind: 'trusted-local-human' as const, sourceEventId: id }, observedAt: new Date().toISOString(), sequence: store.nextSequence(), evidence: { kind: 'observed' as const, reference: 'test' } });
    store.create(queuedTask(profile, 'task', 'preview', 'create'), event('create'));
    const computer = await computers.create(profile, 'agent');
    const scriptedText = 'isolated scripted preview';
    const task = new ToolTask(store, effects, profile, 'panel'); let generations = 0;
    const executor = new TaskExecutor({ store, profileId: profile, databasePath: join(dir, 'tasks.sqlite'), channels: ['panel'],
      run: async () => { generations++; return { kind: 'browser_text', text: scriptedText }; },
      tools: { task, request: (current, text, operationId) => browserTextRequest({ version: 1, operationId, profileId: profile, sessionId: 's', taskId: current.taskId, runId: 'r', policyVersion: 'v', expiresAt: Date.now() + 120000 }, computer, text) } });
    try {
      await executor.tick();
      const pending = effects.pending()[0]; assert.equal(pending.state, 'waiting');
      await executor.tick(); assert.equal(generations, 1);
      gateway.decide(pending.reviewId!, 'approve', authority);
      await executor.tick();
      const done = effects.get(pending.id);
      assert.equal(done.state, 'done'); assert.match(String(done.result), /isolated scripted preview/);
      assert.equal(store.get('task')!.status, 'ready_for_review');
      assert.match(store.events().at(-1)!.event.evidence.reference, /isolated scripted preview/);
      await executor.tick(); assert.equal(generations, 1);
    } finally { await executor.close(); }
  } finally { effects.close(); gateway.close(); store.close(); await computers.cleanup(); computers.close(); rmSync(dir, { recursive: true, force: true }); }
});
