import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, restoreBackup } from '../src/ops/backup.ts';
import { TaskStore } from '../src/store/db.ts';
import { createGateway } from '../src/policy/gateway.ts';
import { createRuntime } from '../src/runtime/worker.ts';
import { createRoutines } from '../src/routines/manager.ts';
import { createNotificationCenter } from '../src/notifications/center.ts';
import { Vault } from '../src/secrets/vault.ts';
import { effect } from './runtime-support.ts';
import { CANARY, contains, memoryProtector, privateDir } from './vault-support.ts';
import { PROFILE, seedTask } from './ops-support.ts';

const operator = {};

/** Worker + gateway on the service data directory, delivering effects to an external sink outside it. */
function stack(dataDir: string, sink: string[], owner: string) {
  const gateway = createGateway({ databasePath: join(dataDir, 'gateway.sqlite'), profileId: 'p', operatorAuthority: operator, policy: m => m.action === 'review' ? 'review' : 'allow', inspect: () => ({ decision: 'allow', reasons: [] }) });
  const runtime = createRuntime({ databasePath: join(dataDir, 'runtime.sqlite'), owner, gateway, leaseMs: 60_000,
    handlers: { noop: () => undefined }, adapters: { mail: { invoke: bytes => { sink.push(Buffer.from(bytes).toString()); return { accepted: true }; } } } });
  return { gateway, runtime, async close() { await runtime.stop(); runtime.close(); gateway.close(); } };
}
async function drain(runtime: ReturnType<typeof createRuntime>) { while (await runtime.runOnce()); }

test('backup -> restore round trip: encrypted at rest, schema-checked, executed effects never replayed', () => privateDir('backup-roundtrip-', async root => {
  const data = join(root, 'data'), target = join(root, 'restored'), out = join(root, 'assistant.backup');
  mkdirSync(data); mkdirSync(target);
  const { protector } = memoryProtector();
  const sink: string[] = [];
  seedTask(join(data, 'tasks.sqlite'), `title ${CANARY}`);
  const live = stack(data, sink, 'worker-a');
  await live.runtime.acquire();
  live.runtime.enqueue('send-a', 'effect', effect('op-a', 'mail A'));
  await drain(live.runtime);
  live.runtime.enqueue('send-b', 'effect', effect('op-b', 'mail B'));
  live.runtime.enqueue('local-c', 'noop', {});
  live.runtime.notify('note-1', ['tui'], 'task done');
  await live.runtime.deliver('tui', () => undefined);
  const { payloadBase64: _payload, ...reviewed } = effect('op-r', 'needs review');
  const review = live.gateway.prepare({ ...reviewed, action: 'review', payload: Buffer.from('needs review') });
  assert.equal(review.decision, 'review');
  live.gateway.decide(review.reviewId!, 'approve', operator);
  const routines = createRoutines({ databasePath: join(data, 'runtime.sqlite'), runtime: live.runtime });
  routines.create({ id: 'daily', profileId: PROFILE, kind: 'noop', schedule: { kind: 'daily', at: '09:00', timeZone: 'UTC' } });
  routines.resume('daily', 'operator');
  routines.close();
  const notes = createNotificationCenter({ databasePath: join(data, 'notifications.sqlite'), operatorAuthority: operator });
  notes.setConsent('local', true, operator);
  notes.notify({ id: 'task-1:finished', channel: 'local', category: 'task_finished', ref: 'task-1' });
  await notes.deliver('local', () => undefined);
  notes.close();
  const vault = await Vault.open({ databasePath: join(data, 'vault.sqlite'), protector });
  vault.put(Buffer.from(CANARY), { profileId: PROFILE, origin: 'https://example.test', action: 'login' });
  vault.close();
  writeFileSync(join(data, 'notes.txt'), 'not a database');

  const summary = await createBackup({ databasePath: join(data, 'tasks.sqlite'), profileId: PROFILE, out, protector });
  assert.deepEqual(summary.entries.map(e => e.name).sort(), ['gateway.sqlite', 'notifications.sqlite', 'runtime.sqlite', 'tasks.sqlite']);
  assert.deepEqual(summary.excluded.sort((a, b) => a.name.localeCompare(b.name)), [{ name: 'notes.txt', reason: 'not_sqlite' }, { name: 'vault.sqlite', reason: 'vault' }]);
  const archive = readFileSync(out);
  assert.equal(contains(archive, CANARY), false, 'no plaintext task content in the backup');
  assert.equal(contains(archive, 'mail A'), false);
  await assert.rejects(createBackup({ databasePath: join(data, 'tasks.sqlite'), profileId: PROFILE, out, protector }), /backup_exists/);

  // After the backup, the queued effect B is sent. Restoring the older snapshot must not send it again.
  await drain(live.runtime);
  assert.deepEqual(sink, ['mail A', 'mail B']);
  await live.close();

  const report = await restoreBackup({ backup: out, into: target, profileId: PROFILE, protector });
  assert.deepEqual(readdirSync(target).filter(n => !/-(wal|shm|journal)$/.test(n)).sort(), ['gateway.sqlite', 'notifications.sqlite', 'runtime.sqlite', 'tasks.sqlite']);
  assert.equal(report.tasksDatabase, join(target, 'tasks.sqlite'));
  assert.deepEqual(report.fenced, { jobs: 2, leases: 1, grants: 1, reviews: 0, routines: 1, connectorGrants: 0 });

  const store = new TaskStore(join(target, 'tasks.sqlite'), PROFILE);
  try { assert.match(store.get('task-1')!.title, /title/); } finally { store.close(); }

  const restored = stack(target, sink, 'worker-restored');
  try {
    assert.equal(await restored.runtime.acquire(), true, 'restored lease is released for a new owner');
    await drain(restored.runtime);
    assert.deepEqual(sink, ['mail A', 'mail B'], 'no external effect repeated after restore');
    const jobs = new Map(restored.runtime.jobs().map(j => [j.id, j]));
    assert.equal(jobs.get('send-a')!.state, 'done');
    assert.deepEqual([jobs.get('send-b')!.state, jobs.get('send-b')!.error], ['effect_uncertain', 'restored_unreconciled']);
    assert.deepEqual([jobs.get('local-c')!.state, jobs.get('local-c')!.error], ['blocked', 'restored_unreconciled']);
    restored.runtime.notify('note-1', ['tui'], 'task done');
    assert.deepEqual(restored.runtime.notifications().map(n => [n.id, n.state]), [['note-1', 'delivered']], 'outbox dedup survives restore');
    const grant = new DatabaseSync(join(target, 'gateway.sqlite'));
    try { assert.equal(grant.prepare('SELECT COUNT(*) AS n FROM grants WHERE revoked = 0').get()!.n, 0, 'approvals do not survive a restore'); } finally { grant.close(); }
  } finally { await restored.close(); }
  const view = createRuntime({ databasePath: join(target, 'runtime.sqlite'), owner: 'view' });
  const restoredRoutines = createRoutines({ databasePath: join(target, 'runtime.sqlite'), runtime: view });
  try { assert.deepEqual([restoredRoutines.get('daily').state, restoredRoutines.get('daily').pausedReason], ['paused', 'restored']); } finally { restoredRoutines.close(); view.close(); }
  const restoredNotes = createNotificationCenter({ databasePath: join(target, 'notifications.sqlite'), operatorAuthority: operator });
  try {
    let pushed = 0;
    await restoredNotes.deliver('local', () => { pushed++; });
    assert.equal(pushed, 0, 'accepted notifications are not pushed again after restore');
    assert.equal(restoredNotes.list()[0].state, 'accepted');
  } finally { restoredNotes.close(); }
}));

async function sealed(root: string) {
  const data = join(root, 'data'); mkdirSync(data);
  seedTask(join(data, 'tasks.sqlite'), 'title');
  const keys = memoryProtector();
  const out = join(root, 'assistant.backup');
  await createBackup({ databasePath: join(data, 'tasks.sqlite'), profileId: PROFILE, out, protector: keys.protector });
  return { out, protector: keys.protector, bytes: readFileSync(out) };
}
function emptyTarget(root: string, name: string) { const dir = join(root, name); mkdirSync(dir); return dir; }

test('a tampered backup fails closed and writes nothing', () => privateDir('backup-tamper-', async root => {
  const { out, protector, bytes } = await sealed(root);
  const cases: [string, (b: Buffer) => Buffer][] = [
    ['ciphertext byte', b => { const c = Buffer.from(b); c[c.length - 40] ^= 1; return c; }],
    ['authentication tag', b => { const c = Buffer.from(b); c[c.length - 1] ^= 1; return c; }],
    ['header', b => Buffer.from(b.toString('latin1').replace('"format":1', '"format":1 '), 'latin1')],
    ['truncation', b => b.subarray(0, b.length - 100)],
    ['magic', b => { const c = Buffer.from(b); c[0] ^= 1; return c; }],
  ];
  for (const [name, mutate] of cases) {
    writeFileSync(out, mutate(bytes));
    const target = emptyTarget(root, `t-${name.replace(/\s/g, '-')}`);
    await assert.rejects(restoreBackup({ backup: out, into: target, profileId: PROFILE, protector }), /backup_unreadable/, name);
    assert.deepEqual(readdirSync(target), [], `${name}: nothing restored`);
  }
}));

test('a backup sealed by another key, profile or unsupported schema refuses without writing', () => privateDir('backup-key-', async root => {
  const { out, protector } = await sealed(root);
  const other = memoryProtector();
  const t1 = emptyTarget(root, 'wrong-key');
  await assert.rejects(restoreBackup({ backup: out, into: t1, profileId: PROFILE, protector: other.protector }), /backup_unreadable/);
  await assert.rejects(restoreBackup({ backup: out, into: t1, profileId: PROFILE, protector: memoryProtector('other-kind').protector }), /backup_unreadable/);
  assert.deepEqual(readdirSync(t1), []);
  await assert.rejects(restoreBackup({ backup: out, into: t1, profileId: 'someone-else', protector }), /backup_profile_mismatch/);
  assert.deepEqual(readdirSync(t1), []);
  writeFileSync(join(t1, 'existing'), 'x');
  await assert.rejects(restoreBackup({ backup: out, into: emptyTarget(root, 'nonempty') + '-missing', profileId: PROFILE, protector }), /restore_target/);
  await assert.rejects(restoreBackup({ backup: out, into: t1, profileId: PROFILE, protector }), /restore_target_not_empty/);

  const data2 = join(root, 'future'); mkdirSync(data2);
  seedTask(join(data2, 'tasks.sqlite'), 'title');
  const db = new DatabaseSync(join(data2, 'tasks.sqlite')); db.exec('PRAGMA user_version = 2'); db.close();
  const future = join(root, 'future.backup');
  await createBackup({ databasePath: join(data2, 'tasks.sqlite'), profileId: PROFILE, out: future, protector });
  const t2 = emptyTarget(root, 'future-target');
  await assert.rejects(restoreBackup({ backup: future, into: t2, profileId: PROFILE, protector }), /backup_schema_unsupported/);
  assert.deepEqual(readdirSync(t2), []);
}));
