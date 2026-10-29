import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceSetup } from '../src/service-setup.ts';
import { checkSetup } from '../src/setup.ts';
import { memoryProtector } from './vault-support.ts';
import { TaskStore } from '../src/store/db.ts';
import { queuedTask, storeEvent } from './task-fixtures.ts';

const NOW = Date.parse('2026-10-29T12:00:00Z');
const briefing = (createdAt: string, mail: string, calendar = 'ok') => ({ version: 1, profileId: 'owner', briefingId: 'b-1', kind: 'daily', localDate: '2026-10-29', timeZone: 'America/Sao_Paulo',
  createdAt, taskSequence: 0, distractions: 0, items: [], sources: [{ sourceId: 'tasks', state: 'ok', error: null }, { sourceId: 'pessoal:mail', state: mail, error: mail === 'ok' ? null : 'truncated' }, { sourceId: 'pessoal:calendar', state: calendar, error: null }] });
const googleStatus = async (latest: unknown) => {
  const { protector } = memoryProtector();
  const component = serviceSetup({ databasePath: ':memory:', profileId: 'owner', google: { connections: ['pessoal'] } }, protector, { briefing: async () => latest }).find(c => c.id === 'google')!;
  return (await checkSetup([component], { now: () => NOW }))[0];
};

test('Google is ready only after a recent stored briefing actually read every declared connection', async () => {
  const read = await googleStatus(briefing('2026-10-29T10:00:21.234Z', 'partial'));
  assert.equal(read.status, 'ready');
  assert.equal(read.evidence, 'briefing b-1');
  assert.match(read.detail, /pessoal:mail parcial/);
  assert.equal((await googleStatus(briefing('2026-10-27T10:00:00Z', 'ok'))).status, 'not_verified');
  assert.equal((await googleStatus(briefing('2026-10-29T10:00:00Z', 'ok', 'unavailable'))).status, 'not_verified');
  assert.equal((await googleStatus(null)).status, 'not_verified');
  assert.equal((await googleStatus({ ...briefing('2026-10-29T10:00:00Z', 'ok'), profileId: 'other' })).status, 'not_verified');
});

test('the executor model is ready only after the executor itself produced a draft or a question recently', async () => {
  const { protector } = memoryProtector();
  const store = new TaskStore(':memory:', 'owner');
  const ids = (n: number, actorId: string, sourceKind: 'worker' | 'trusted-local-human') => ({ eventId: `e${n}`, sourceEventId: `s${n}`, correlationId: 'c', actorId, sourceKind, reference: 'r' });
  store.create(queuedTask('owner', 't1', 'tarefa', 's1'), storeEvent('owner', 't1', 1, ids(1, 'web-operator', 'trusted-local-human')));
  store.transition('t1', 1, 'working', storeEvent('owner', 't1', 2, ids(2, 'draft-executor', 'worker')));
  const status = async () => (await checkSetup([serviceSetup({ databasePath: ':memory:', profileId: 'owner', executor: {} }, protector, { executor: () => store.latestResult('draft-executor') }).find(c => c.id === 'model')!], { now: () => NOW }))[0];
  assert.equal((await status()).status, 'not_verified', 'starting work is not a generated result');
  store.transition('t1', 2, 'failed', storeEvent('owner', 't1', 3, ids(3, 'draft-executor', 'worker')));
  assert.equal((await status()).status, 'not_verified', 'a failed generation proves nothing');
  store.transition('t1', 3, 'queued', storeEvent('owner', 't1', 4, ids(4, 'web-operator', 'trusted-local-human')));
  store.transition('t1', 4, 'working', storeEvent('owner', 't1', 5, ids(5, 'draft-executor', 'worker')));
  store.transition('t1', 5, 'ready_for_review', storeEvent('owner', 't1', 6, ids(6, 'web-operator', 'trusted-local-human')));
  assert.equal((await status()).status, 'not_verified', 'another actor moving the task is not the executor');
  store.transition('t1', 6, 'working', storeEvent('owner', 't1', 7, ids(7, 'web-operator', 'trusted-local-human')));
  store.transition('t1', 7, 'needs_input', storeEvent('owner', 't1', 8, ids(8, 'draft-executor', 'worker')));
  const ready = await status();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.evidence, 'draft-executor event 8');
  store.close();
});

test('service configuration is present, not exercised or falsely missing, without contacting accounts', async () => {
  const { protector } = memoryProtector();
  const config = { databasePath: ':memory:', executor: {}, google: { connections: ['fixture'] }, notifications: { local: true } };
  const relevant = (options: typeof config | { databasePath: string }) => serviceSetup(options, protector).filter(c => ['model', 'google', 'notifications'].includes(c.id));
  const configured = await checkSetup(relevant(config));
  assert.deepEqual(configured.map(c => [c.id, c.status]), [['model', 'not_verified'], ['google', 'not_verified'], ['notifications', 'not_verified']]);
  assert(configured.every(c => !c.evidence));
  const missing = await checkSetup(relevant({ databasePath: ':memory:' }));
  assert(missing.every(c => c.status === 'needs_setup'));
  const pinned = serviceSetup({ ...config, executor: { provider: 'fixture-provider', model: 'fixture-model' } }, protector).find(c => c.id === 'model')!;
  assert.equal((await checkSetup([pinned]))[0].status, 'not_verified');
  assert.match((await pinned.probe()).detail, /fixture-provider\/fixture-model/);
});
