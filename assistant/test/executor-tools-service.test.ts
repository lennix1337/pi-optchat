import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/main.ts';
import type { DockerRunner } from '../src/computer/docker.ts';
import { RESTORE_HOLDS_FENCE, TaskStore } from '../src/store/db.ts';
import { ExecutorDesk } from '../src/ops/executor-desk.ts';
import { openTaskExecutor } from '../src/runtime/open-executor.ts';
import { openToolService, openToolServiceIfDockerUp } from '../src/runtime/tool-service.ts';
import { createPrivateDirectory } from '../src/store/private-directory.ts';
import { queuedTask } from './task-fixtures.ts';

const profileId = 'tools-service';
/** Docker stand-in: records every call; the "browser" answers with a snapshot of the text it was handed. */
function fakeDocker() {
  const calls: string[][] = []; let owner: string | undefined;
  const docker: DockerRunner = async args => {
    calls.push([...args]);
    if (args[0] === 'inspect') return owner ? { code: 0, stdout: `${owner}|running`, stderr: '' } : { code: 1, stdout: '', stderr: 'No such object' };
    if (args[0] === 'run') { owner = args.find(arg => arg.startsWith('optchat.computer.owner='))!.split('=')[1]; return { code: 0, stdout: 'id', stderr: '' }; }
    if (args[0] === 'exec') return { code: 0, stdout: args.includes('snapshot') ? 'SNAPSHOT-OF-PREVIEW' : '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { docker, calls, browser: () => calls.filter(call => call[0] === 'exec' && call.includes('agent-browser')) };
}
const event = (store: TaskStore, taskId: string) => ({ version: 1 as const, eventId: randomUUID(), correlationId: randomUUID(), profileId, taskId, sessionId: 's', channelId: 'Pessoal', runId: 'r',
  source: { actorId: 'operator', sourceKind: 'trusted-local-human' as const, sourceEventId: `create-${taskId}` }, observedAt: new Date().toISOString(), sequence: store.nextSequence(), evidence: { kind: 'observed' as const, reference: 'test' } });

async function service(fn: (rig: { store: TaskStore; config: Config; fake: ReturnType<typeof fakeDocker>; start: (id: string) => void; generations: () => number; executor: ReturnType<typeof openTaskExecutor> }) => Promise<void>) {
  const dir = join(tmpdir(), 'executor-tools-' + randomUUID()); createPrivateDirectory(dir);
  const config: Config = { version: 1, profileId, databasePath: join(dir, 'tasks.sqlite'), endpoint: 'http://127.0.0.1:1', token: 'token', executor: { agentDir: dir, channels: ['Pessoal'], tools: true } };
  const store = new TaskStore(config.databasePath, profileId), fake = fakeDocker();
  const tools = await openToolService(config, store, fake.docker);
  let generations = 0;
  const executor = openTaskExecutor(config, store, undefined, { ...tools.tools, run: async () => { generations++; return { kind: 'browser_text', text: 'texto para o navegador isolado' }; } });
  try { await fn({ store, config, fake, executor, generations: () => generations, start: id => { store.create(queuedTask(profileId, id, `Prévia ${id}`, `create-${id}`), event(store, id)); } }); }
  finally { await executor.close(); await tools.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('with tools enabled the executor opens a review and runs the preview only after the operator desk approves it', () => service(async ({ store, config, fake, executor, generations, start }) => {
  start('a');
  await executor.tick(); await executor.tick(); await executor.tick();
  assert.equal(store.get('a')!.status, 'working', 'model text does not decide: the task waits for the operator');
  assert.equal(fake.browser().length, 0, 'nothing opened before approval');
  const desk = new ExecutorDesk(config);
  try {
    const [review] = desk.reviews();
    assert.deepEqual([desk.reviews().length, review.taskId, review.title, review.text, review.action], [1, 'a', 'Prévia a', 'texto para o navegador isolado', 'browser_text']);
    assert.throws(() => desk.decide(randomUUID(), 'approve'), /review_not_pending/);
    desk.decide(review.reviewId, 'approve');
    assert.throws(() => desk.decide(review.reviewId, 'approve'), /review_not_pending/, 'a decided review cannot be decided again');
    assert.deepEqual(desk.reviews(), []);
  } finally { desk.close(); }
  await executor.tick();
  assert.equal(store.get('a')!.status, 'ready_for_review');
  assert.match(store.events().at(-1)!.event.evidence.reference, /SNAPSHOT-OF-PREVIEW/);
  assert.deepEqual(fake.browser().map(call => call.find(arg => ['open', 'snapshot', 'close'].includes(arg))), ['open', 'snapshot', 'close'], 'one isolated session, opened once');
  assert.equal(generations(), 1);
  await executor.tick(); await executor.tick(); assert.equal(fake.browser().length, 3); assert.equal(generations(), 1);
}));

test('the operator desk denies a preview: the task fails and the browser never opens', () => service(async ({ store, config, fake, executor, start }) => {
  start('d');
  await executor.tick(); await executor.tick();
  const desk = new ExecutorDesk(config);
  try { desk.decide(desk.reviews()[0].reviewId, 'deny'); } finally { desk.close(); }
  await executor.tick(); await executor.tick();
  assert.equal(store.get('d')!.status, 'failed');
  assert.equal(fake.browser().length, 0);
}));

test('executor.mjs lists reviews and held revisions but refuses every decision outside a real terminal', () => service(async ({ store, config, executor, start }) => {
  const path = join(config.databasePath, '..', 'config.json'); writeFileSync(path, JSON.stringify(config));
  const cli = (...args: string[]) => spawnSync(process.execPath, [process.env.EXECUTOR_TEST_CLI ?? 'assistant/scripts/executor.mjs', path, ...args], { input: '', encoding: 'utf8', timeout: 30000 });
  start('p'); await executor.tick(); await executor.tick();
  const listed = cli('reviews'); assert.equal(listed.status, 0, listed.stderr);
  const { reviews } = JSON.parse(listed.stdout) as { reviews: { reviewId: string; text: string }[] };
  assert.deepEqual(reviews.map(review => review.text), ['texto para o navegador isolado']);
  for (const action of ['approve', 'deny']) {
    const refused = cli(action, reviews[0].reviewId); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /interactive_terminal_required/);
  }
  assert.equal(cli('approve', randomUUID()).stderr.trim(), 'review_not_pending');
  const stillPending = new ExecutorDesk(config); try { assert.equal(stillPending.reviews().length, 1, 'no decision was recorded'); } finally { stillPending.close(); }
  // A restore holds queued revisions; the script lists them read-only and will not reconcile without a terminal.
  start('h');
  const db = new DatabaseSync(config.databasePath); try { db.prepare(RESTORE_HOLDS_FENCE).run(); } finally { db.close(); }
  const held = JSON.parse(cli('restored').stdout) as { restored: { taskId: string; revision: number }[] };
  assert.deepEqual(held.restored.map(hold => [hold.taskId, hold.revision]), [['h', 1], ['p', 2]]);
  const reconcile = cli('reconcile', 'h', '1'); assert.notEqual(reconcile.status, 0); assert.match(reconcile.stderr, /interactive_terminal_required/);
  assert.equal(cli('reconcile', 'h', '9').stderr.trim(), 'not_held_by_restore');
  assert.equal(store.get('h')!.status, 'queued');
  assert.equal(cli('bogus').status, 1);
}));

test('a shutdown cleanup that failed while Docker was down does not block the next start', async () => {
  const dir = join(tmpdir(), 'executor-tools-' + randomUUID()); createPrivateDirectory(dir);
  const config: Config = { version: 1, profileId, databasePath: join(dir, 'tasks.sqlite'), endpoint: 'http://127.0.0.1:1', token: 'token', executor: { agentDir: dir, channels: ['Pessoal'], tools: true } };
  const store = new TaskStore(config.databasePath, profileId);
  try {
    const first = fakeDocker(); let dockerDown = false;
    const tools = await openToolService(config, store, async (args, options) => dockerDown ? { code: 1, stdout: '', stderr: 'Docker Desktop is not running' } : first.docker(args, options));
    dockerDown = true;
    await tools.close();
    const again = await openToolService(config, store, fakeDocker().docker);
    await again.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('with Docker down the assistant keeps running without preview tools and names the cause', async () => {
  const dir = join(tmpdir(), 'executor-tools-' + randomUUID()); createPrivateDirectory(dir);
  const config: Config = { version: 1, profileId, databasePath: join(dir, 'tasks.sqlite'), endpoint: 'http://127.0.0.1:1', token: 'token', executor: { agentDir: dir, channels: ['Pessoal'], tools: true } };
  const store = new TaskStore(config.databasePath, profileId);
  const logged: string[] = [];
  try {
    const down: DockerRunner = async () => ({ code: 1, stdout: '', stderr: 'Docker Desktop is not running' });
    assert.equal(await openToolServiceIfDockerUp(config, store, down, message => logged.push(message)), undefined);
    assert.match(logged.join(' '), /preview tools unavailable.*computer_start_failed/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('after a start that failed with Docker down, the next start with Docker up gets the preview tools back', async () => {
  const dir = join(tmpdir(), 'executor-tools-' + randomUUID()); createPrivateDirectory(dir);
  const config: Config = { version: 1, profileId, databasePath: join(dir, 'tasks.sqlite'), endpoint: 'http://127.0.0.1:1', token: 'token', executor: { agentDir: dir, channels: ['Pessoal'], tools: true } };
  const store = new TaskStore(config.databasePath, profileId);
  try {
    const down: DockerRunner = async () => ({ code: 1, stdout: '', stderr: 'Docker Desktop is not running' });
    assert.equal(await openToolServiceIfDockerUp(config, store, down, () => {}), undefined);
    const logged: string[] = [];
    const up = await openToolServiceIfDockerUp(config, store, fakeDocker().docker, message => logged.push(message));
    assert.ok(up, logged.join(' '));
    await up.close();
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
