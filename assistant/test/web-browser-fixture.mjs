// Disposable browser acceptance fixture. No real account, provider, secret or production executor.
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../src/store/db.ts';
import { createAssistantServer } from '../src/http/server.ts';

const dir = resolve(process.env.ASSISTANT_BROWSER_EVIDENCE ?? 'C:/projetos/local-validation/runs/personal-assistant-parity/t10-browser');
mkdirSync(dir, { recursive: true });
const databasePath = join(dir, `fixture-${Date.now()}.db`);
const store = new TaskStore(databasePath, 'browser-acceptance');
const db = new DatabaseSync(databasePath);
const id = 'browser-task';
function event(reference = 'fixture://original/request', taskId = id) {
  return { version: 1, eventId: randomUUID(), profileId: 'browser-acceptance', taskId, sessionId: 'fixture', channelId: 'Pesquisa', runId: 'scripted-fixture-only', source: { actorId: 'scripted-fixture-worker', sourceKind: 'worker', sourceEventId: randomUUID() }, observedAt: new Date().toISOString(), sequence: store.nextSequence(), correlationId: randomUUID(), evidence: { kind: 'observed', reference } };
}
const initial = event();
store.create({ version: 1, profileId: 'browser-acceptance', taskId: id, title: 'Revisar resumo da pesquisa local', status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: initial.source.sourceEventId }, initial);
store.transition(id, 1, 'working', event()); store.transition(id, 2, 'needs_input', event());
const extraTasks = Number(process.env.ASSISTANT_BROWSER_TASK_COUNT ?? 0);
if (!Number.isSafeInteger(extraTasks) || extraTasks < 0 || extraTasks > 300) throw new Error('Invalid disposable fixture task count');
for (let i = 0; i < extraTasks; i++) {
  const taskId = `page-${String(i).padStart(3, '0')}`;
  const entry = event('fixture://pagination', taskId);
  store.create({ version: 1, profileId: 'browser-acceptance', taskId, title: `Tarefa de paginação ${i}`, status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: entry.source.sourceEventId }, entry);
}
const server = createAssistantServer({ store, token: 'DISPOSABLE-BROWSER-ONLY', profileId: 'browser-acceptance', web: true });
let responseConsumed = false;
const worker = setInterval(() => {
  const task = store.get(id);
  const stale = join(dir, 'stale-request');
  if (existsSync(stale)) {
    if (task.status !== 'needs_input') throw new Error('stale fixture requires current input');
    store.transition(id, task.revision, 'working', event());
    store.transition(id, task.revision + 1, 'needs_input', event('fixture://original/revised-input'));
    unlinkSync(stale);
  }
  const response = db.prepare('SELECT text FROM responses WHERE profile = ? AND task_id = ? ORDER BY input_revision DESC LIMIT 1').get('browser-acceptance', id);
  if (!responseConsumed && response && store.get(id).status === 'working') {
    responseConsumed = true;
    writeFileSync(join(dir, 'result.txt'), `Scripted fixture result from operator input: ${response.text}\n`);
    store.transition(id, store.get(id).revision, 'ready_for_review', event('fixture://artifact/result.txt'));
    writeFileSync(join(dir, 'worker-proof.json'), JSON.stringify({ fixtureOnly: true, responseConsumed: true, resultFile: 'result.txt', revision: store.get(id).revision }));
  }
}, 250);
function close() { clearInterval(worker); clearTimeout(deadline); server.closeAllConnections(); server.close(() => { db.close(); store.close(); console.log('DISPOSABLE_BROWSER_FIXTURE_CLOSED'); }); }
const deadline = setTimeout(close, 12 * 60_000);
process.on('SIGTERM', close); process.on('SIGINT', close);
server.listen(43218, '127.0.0.1', () => { writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ pid: process.pid, databasePath, base: 'http://127.0.0.1:43218' })); console.log('DISPOSABLE_BROWSER_FIXTURE_READY http://127.0.0.1:43218'); });
