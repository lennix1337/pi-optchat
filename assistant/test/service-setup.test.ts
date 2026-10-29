import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serviceSetup } from '../src/service-setup.ts';
import { checkSetup } from '../src/setup.ts';
import { memoryProtector } from './vault-support.ts';

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
