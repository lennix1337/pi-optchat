import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/store/db.ts';
import { MAX_ROUTE_ATTEMPTS, TaskExecutor, WAIT, type DraftInput, type DraftRunner } from '../src/runtime/task-executor.ts';
import type { Event, SourceKind } from '../src/contracts/events.ts';
import { queuedTask } from './task-fixtures.ts';

const PROFILE = 'executor-test';
const CHANNEL = 'Rascunhos';
type Source = { actorId: string; sourceKind: SourceKind };
const operator: Source = { actorId: 'web-operator', sourceKind: 'external' };

function event(store: TaskStore, taskId: string, sourceEventId: string, channelId: string, source: Source): Event {
  return { version: 1, eventId: randomUUID(), correlationId: randomUUID(), profileId: PROFILE, taskId, sessionId: 's', channelId, runId: 'web-panel',
    source: { ...source, sourceEventId }, observedAt: new Date().toISOString(), sequence: store.nextSequence(), evidence: { kind: 'observed', reference: 'web-panel' } };
}
async function fixture(fn: (f: { store: TaskStore; dir: string; create(id: string, title: string, channel?: string, source?: Source): void;
  executor(run: DraftRunner, now?: () => number, store?: TaskStore, ready?: () => Promise<boolean>): Promise<TaskExecutor>; respond(id: string, text: string): void; notes(id: string): string[] }) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'oc-executor-'));
  const store = new TaskStore(join(dir, 'tasks.sqlite'), PROFILE);
  const opened: TaskExecutor[] = [];
  try {
    await fn({
      store, dir,
      create(id, title, channel = CHANNEL, source = operator) {
        const sourceEventId = `create-${id}`;
        store.create(queuedTask(PROFILE, id, title, sourceEventId), event(store, id, sourceEventId, channel, source));
      },
      async executor(run, now, taskStore = store, ready) {
        const executor = new TaskExecutor({ store: taskStore, profileId: PROFILE, databasePath: join(dir, 'executor.sqlite'), channels: [CHANNEL, 'Voz'], run, ...(now ? { now } : {}), ...(ready ? { ready } : {}) });
        opened.push(executor); assert.equal(await executor.acquire(), true); return executor;
      },
      respond(id, text) {
        const task = store.get(id)!;
        store.respond({ version: 1, profileId: PROFILE, taskId: id, revision: task.revision, inputRevision: task.inputRevision, text }, event(store, id, randomUUID(), CHANNEL, operator));
      },
      notes: id => store.events(0, 100).filter(entry => entry.event.taskId === id && entry.event.source.actorId === 'draft-executor').map(entry => entry.event.evidence.reference),
    });
  } finally {
    for (const executor of opened) await executor.close();
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
}

test('a panel task runs once, asks for input, consumes the persisted answer and ends ready for review', async () => fixture(async f => {
  const calls: DraftInput[] = [];
  const executor = await f.executor(async input => {
    calls.push(input);
    return input.response ? { kind: 'draft', text: `Rascunho para ${input.response}` } : { kind: 'input', text: 'Para quem é a mensagem?' };
  });
  f.create('t1', 'Escrever convite');
  await executor.tick();
  assert.equal(f.store.get('t1')!.status, 'needs_input');
  await executor.tick();
  assert.equal(calls.length, 1, 'waiting for input does not generate again');
  f.respond('t1', 'equipe');
  await executor.tick();
  assert.deepEqual(calls, [{ title: 'Escrever convite', response: null }, { title: 'Escrever convite', response: 'equipe' }]);
  const task = f.store.get('t1')!;
  assert.equal(task.status, 'ready_for_review');
  assert.equal(task.verification, 'not_verified');
  assert.match(f.notes('t1').at(-1)!, /não enviado:\nRascunho para equipe$/);
  await executor.tick();
  assert.equal(calls.length, 2, 'a reviewed draft is never regenerated');
}));

test('an account limit continues on the next account instead of failing the task', async () => fixture(async f => {
  const accounts = ['codex-1', 'codex-2'];
  const used: string[] = [];
  const executor = await f.executor(async () => {
    const account = accounts.shift()!; used.push(account);
    return account === 'codex-1' ? WAIT : { kind: 'draft', text: `feito em ${account}` };
  });
  f.create('limit', 'Resumo');
  await executor.tick();
  assert.equal(f.store.get('limit')!.status, 'working', 'an exhausted account is not a task failure');
  await executor.tick();
  assert.deepEqual(used, ['codex-1', 'codex-2']);
  assert.equal(f.store.get('limit')!.status, 'ready_for_review');
  assert.match(f.notes('limit').at(-1)!, /feito em codex-2$/);
}));

test('with no usable account the task keeps waiting without a job, then runs when one recovers', async () => fixture(async f => {
  let calls = 0; let available = false;
  const executor = await f.executor(async () => { calls++; return { kind: 'draft', text: 'voltou' }; }, undefined, undefined, async () => available);
  f.create('idle', 'Esperar conta');
  await executor.tick(); await executor.tick();
  assert.equal(calls, 0);
  assert.equal(f.store.get('idle')!.status, 'queued', 'nothing started while every account cools down');
  available = true;
  await executor.tick();
  assert.equal(calls, 1);
  assert.equal(f.store.get('idle')!.status, 'ready_for_review');
}));

test('account switches are bounded: the task fails visibly after the last allowed attempt', async () => fixture(async f => {
  let calls = 0;
  const executor = await f.executor(async () => { calls++; return WAIT; });
  f.create('bounded', 'Sem contas');
  for (let i = 0; i < MAX_ROUTE_ATTEMPTS + 3; i++) await executor.tick();
  assert.equal(calls, MAX_ROUTE_ATTEMPTS);
  assert.equal(f.store.get('bounded')!.status, 'failed');
  assert.match(f.notes('bounded').at(-1)!, new RegExp(`após ${MAX_ROUTE_ATTEMPTS} tentativas`));
}));

test('only human-created tasks in the configured channels are admitted', async () => fixture(async f => {
  let calls = 0;
  const executor = await f.executor(async () => { calls++; return { kind: 'draft', text: 'x' }; });
  f.create('voice', 'Por voz', 'Voz');
  f.create('other-channel', 'Outro assunto', 'Geral');
  f.create('model-made', 'Criada por modelo', CHANNEL, { actorId: 'assistant-client', sourceKind: 'model' });
  f.create('slack-made', 'Slack', CHANNEL, { actorId: 'slack:U1', sourceKind: 'external' });
  f.create('local-human', 'Terminal', CHANNEL, { actorId: 'operator', sourceKind: 'trusted-local-human' });
  await executor.tick(); await executor.tick();
  assert.equal(calls, 2, 'one generation per pass');
  assert.equal(f.store.get('local-human')!.status, 'ready_for_review');
  assert.equal(f.store.get('voice')!.status, 'ready_for_review');
  for (const id of ['other-channel', 'model-made', 'slack-made']) assert.equal(f.store.get(id)!.status, 'queued', id);
}));

test('one task the executor cannot prepare fails visibly; the other tasks still get drafts', async () => fixture(async f => {
  const executor = await f.executor(async () => ({ kind: 'draft', text: 'pronto' }));
  const getResponse = f.store.getResponse.bind(f.store);
  f.store.getResponse = (taskId, inputRevision) => { if (taskId === 'broken') throw new Error('response unreadable'); return getResponse(taskId, inputRevision); };
  f.create('broken', 'Resposta ilegível');
  f.create('fine', 'Normal');
  for (let i = 0; i < 3; i++) await executor.tick();
  assert.equal(f.store.get('broken')!.status, 'failed');
  assert.match(f.notes('broken').at(-1)!, /não conseguiu preparar/);
  assert.equal(f.store.get('fine')!.status, 'ready_for_review');
}));

test('a failing pass is reported and the executor keeps running, instead of stopping for every task', async () => fixture(async f => {
  const executor = await f.executor(async () => ({ kind: 'draft', text: 'pronto' }));
  const list = f.store.list.bind(f.store);
  let failures = 1;
  f.store.list = (cursor, limit) => { if (failures-- > 0) throw new Error('database is locked'); return list(cursor, limit); };
  const errors: string[] = [];
  executor.start(error => errors.push(error.message));
  f.create('after', 'Depois da falha');
  const deadline = Date.now() + 10_000;
  while (f.store.get('after')!.status !== 'ready_for_review' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(errors, ['database is locked']);
  assert.equal(f.store.get('after')!.status, 'ready_for_review');
  assert.equal(executor.status().state, 'running');
  assert.equal(executor.status().lastError, 'database is locked');
}));

test('invalid model output fails the task once, without retrying or forwarding the text', async () => fixture(async f => {
  let calls = 0;
  const executor = await f.executor(async () => { calls++; return { kind: 'send', text: 'enviei o email' } as never; });
  f.create('bad', 'Teste');
  await executor.tick(); await executor.tick();
  assert.equal(calls, 1);
  assert.equal(f.store.get('bad')!.status, 'failed');
  assert.doesNotMatch(f.notes('bad').join('\n'), /enviei/);
}));

test('a question\'s quick answers belong to its own revision; the next question replaces them', async () => fixture(async f => {
  const executor = await f.executor(async input => input.response === 'Segunda' ? { kind: 'input', text: 'Que horas?', options: ['9h', '14h'] }
    : input.response ? { kind: 'draft', text: `Convite ${input.response}` } : { kind: 'input', text: 'Qual dia?', options: ['Segunda', 'Ter\u00e7a'] });
  f.create('q', 'Marcar reuni\u00e3o');
  await executor.tick();
  const first = f.store.get('q')!;
  assert.deepEqual(executor.prompt(first), { question: 'Qual dia?', options: ['Segunda', 'Ter\u00e7a'] });
  f.respond('q', 'Segunda');
  assert.equal(executor.prompt(f.store.get('q')!), null, 'an answered question offers nothing while the task works');
  await executor.tick();
  const second = f.store.get('q')!;
  assert.equal(second.inputRevision, first.inputRevision + 1);
  assert.deepEqual(executor.prompt(second), { question: 'Que horas?', options: ['9h', '14h'] });
  f.respond('q', '14h'); await executor.tick();
  assert.equal(f.store.get('q')!.status, 'ready_for_review');
  assert.equal(executor.prompt(f.store.get('q')!), null);
}));

test('malformed quick answers fail the task like any invalid output', async () => fixture(async f => {
  const bad = [['s\u00f3 uma'], ['a', 'b', 'c', 'd', 'e'], ['igual', 'igual'], ['linha\nquebrada', 'b'], [' espa\u00e7o', 'b'], ['x'.repeat(81), 'b'], 'texto'];
  const outputs = [...bad.map(options => ({ kind: 'input', text: 'Pergunta?', options })), { kind: 'draft', text: 'Rascunho', options: ['a', 'b'] }];
  let next = 0;
  const executor = await f.executor(async () => outputs[next++] as never);
  outputs.forEach((_, index) => f.create(`bad-${index}`, 'Teste'));
  for (let pass = 0; pass < outputs.length + 1; pass++) await executor.tick();
  assert.equal(next, outputs.length);
  outputs.forEach((_, index) => assert.equal(f.store.get(`bad-${index}`)!.status, 'failed', JSON.stringify(outputs[index])));
}));

test('a crash during generation is failed on recovery, never generated again', async () => fixture(async f => {
  let calls = 0;
  const first = await f.executor((_input, signal) => { calls++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); });
  f.create('crash', 'Interrompida');
  first.tick().catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  // The first process is gone without releasing its lease; nobody else runs jobs until it expires.
  const early = new TaskExecutor({ store: f.store, profileId: PROFILE, databasePath: join(f.dir, 'executor.sqlite'), channels: [CHANNEL], run: async () => { calls++; return { kind: 'draft', text: 'cedo' }; } });
  try { assert.equal(await early.acquire(), false); await early.tick(); } finally { await early.close(); }
  assert.equal(f.store.get('crash')!.status, 'working');
  const second = await f.executor(async () => { calls++; return { kind: 'draft', text: 'não deveria rodar' }; }, () => Date.now() + 10 * 60_000);
  await second.tick();
  assert.equal(calls, 1);
  assert.equal(f.store.get('crash')!.status, 'failed');
  assert.match(f.notes('crash').at(-1)!, /não houve repetição automática/);
}));

test('a clean stop during generation fails the task instead of resending it after restart', async () => fixture(async f => {
  let calls = 0;
  const first = await f.executor((_input, signal) => { calls++; return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); });
  f.create('stopped', 'Parada limpa');
  const pass = first.tick();
  await new Promise(resolve => setImmediate(resolve));
  await first.close(); await pass.catch(() => {});
  const second = await f.executor(async () => { calls++; return { kind: 'draft', text: 'reenviado' }; });
  await second.tick();
  assert.equal(calls, 1);
  assert.equal(f.store.get('stopped')!.status, 'failed');
}));

test('a crash after generation but before projection publishes the saved result without generating again', async () => fixture(async f => {
  let calls = 0;
  let crash = true;
  const crashing = new Proxy(f.store, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (key !== 'transition') return typeof value === 'function' ? value.bind(target) : value;
    return (...args: Parameters<TaskStore['transition']>) => {
      if (crash && args[2] === 'ready_for_review') { crash = false; throw new Error('simulated crash'); }
      return target.transition(...args);
    };
  } });
  const first = await f.executor(async () => { calls++; return { kind: 'draft', text: 'salvo' }; }, undefined, crashing);
  f.create('saved', 'Projeção');
  await assert.rejects(first.tick(), /simulated crash/);
  const second = await f.executor(async () => { calls++; return { kind: 'draft', text: 'duplicado' }; }, () => Date.now() + 10 * 60_000);
  await second.tick();
  assert.equal(calls, 1);
  assert.equal(f.store.get('saved')!.status, 'ready_for_review');
  assert.match(f.notes('saved').at(-1)!, /salvo$/);
}));

test('an operator cancel during generation wins over the late result', async () => fixture(async f => {
  let finish!: () => void;
  const executor = await f.executor(() => new Promise(resolve => { finish = () => resolve({ kind: 'draft', text: 'tarde' }); }));
  f.create('cancel', 'Cancelar');
  const pass = executor.tick();
  await new Promise(resolve => setImmediate(resolve));
  const working = f.store.get('cancel')!;
  f.store.transition('cancel', working.revision, 'cancelled', event(f.store, 'cancel', randomUUID(), CHANNEL, operator));
  finish(); await pass;
  assert.equal(f.store.get('cancel')!.status, 'cancelled');
  assert.doesNotMatch(f.notes('cancel').join('\n'), /tarde/);
}));
