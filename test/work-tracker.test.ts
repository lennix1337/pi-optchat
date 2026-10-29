import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { TaskStore } from '../assistant/src/store/db.ts';
import { createAssistantServer } from '../assistant/src/http/server.ts';
import { classify, registerWorkTracker, WorkTracker } from '../src/work-tracker.ts';
import { REPORT_TYPE } from '../src/transcript.ts';
import { hookedPi } from './support.ts';
import { DEFAULT_HEARTBEAT, wakeText } from '../src/heartbeat.ts';
import type { ShellJob } from '../src/shells.ts';
import type { RunInfo } from '../src/runs.ts';

const answer = (text: string, stopReason = 'stop') => [{ role: 'assistant', content: [{ type: 'text', text }], stopReason }] as unknown as AgentMessage[];

/** Tracker -> real loopback HTTP API -> SQLite store, as the panel reads it. */
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'work-tracker-'));
  const store = new TaskStore(join(dir, 'db'), 'p');
  const server = createAssistantServer({ store, token: 'secret', profileId: 'p' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  writeFileSync(join(dir, 'assistant.json'), JSON.stringify({ version: 1, profileId: 'p', endpoint: `http://127.0.0.1:${address.port}`, token: 'secret' }));
  const warnings: string[] = [];
  const tracker = new WorkTracker(() => ({ dir, name: 'p', sessionId: 's' }), undefined, text => warnings.push(text));
  const tasks = () => store.list(null, 100).tasks;
  const notes = (id: string) => store.events(0, 100).filter(e => e.event.taskId === id).map(e => `${e.task.status}: ${e.event.evidence.reference}`);
  const stop = async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); };
  const close = async () => { if (server.listening) await stop(); rmSync(dir, { recursive: true, force: true }); };
  return { tracker, tasks, notes, warnings, close, stop, store, dir };
}

test('a run becomes a working task and ends in review with its final answer as the note', async () => {
  const f = await fixture();
  try {
    f.tracker.userMessage('[Slack] quantas issues abertas?');
    await f.tracker.idle();
    const [task] = f.tasks();
    assert.equal(task.status, 'working'); assert.equal(task.title, 'quantas issues abertas?'); assert.equal(task.verification, 'not_verified');
    f.tracker.userMessage('steer mid-run'); // Not a new task.
    f.tracker.runEnded(answer('São 12 abertas.'));
    await f.tracker.idle();
    assert.equal(f.tasks().length, 1);
    assert.deepEqual(f.notes(task.taskId), ['queued: Em andamento', 'working: Em andamento', 'ready_for_review: São 12 abertas.']);
    assert.equal(f.store.events(0, 100)[0].event.channelId, 'Slack');
  } finally { await f.close(); }
});

test('the project rides on the channel: a project Slack channel at once, a run at its end by where it worked', async () => {
  const f = await fixture();
  try {
    f.tracker.userMessage('[Slack #dentai] e o deploy?');
    f.tracker.runEnded(answer('Feito.'));
    f.tracker.userMessage('arruma o teste');
    await f.tracker.idle();
    f.tracker.runEnded([{ role: 'assistant', content: [{ type: 'toolCall', name: 'edit', arguments: { path: 'C:/projetos/pi-optchat/src/x.ts' } }] }, ...answer('Arrumei.')] as unknown as AgentMessage[]);
    await f.tracker.idle();
    const channels = f.store.events(0, 100).map(e => e.event.channelId);
    assert.deepEqual(channels, ['Slack #dentai \u00b7 dentai', 'Slack #dentai \u00b7 dentai', 'Slack #dentai \u00b7 dentai', 'OptChat', 'OptChat', 'OptChat \u00b7 harness']);
  } finally { await f.close(); }
});

test('a run that ends asking the operator waits as needs_input, and the next message continues the same task', async () => {
  const f = await fixture();
  try {
    f.tracker.userMessage('faz o deploy');
    f.tracker.runEnded(answer('Posso fazer o deploy agora?'));
    await f.tracker.idle();
    const [task] = f.tasks();
    assert.equal(task.status, 'needs_input');
    f.tracker.userMessage('sim');
    f.tracker.runEnded(answer('Deploy feito.'));
    await f.tracker.idle();
    assert.equal(f.tasks().length, 1);
    assert.deepEqual(f.notes(task.taskId).slice(2), ['needs_input: Posso fazer o deploy agora?', 'working: Resposta recebida: sim', 'ready_for_review: Deploy feito.']);
  } finally { await f.close(); }
});

test('a wake delivered as a report custom message becomes a task through the hooks; other reports do not', async () => {
  const f = await fixture();
  const { pi, fire } = hookedPi();
  const tracker = registerWorkTracker(pi, () => ({ dir: f.dir, name: 'p', sessionId: 's' }));
  try {
    for (const [content, reply] of [['[shell 07c6b5b8] exit 0', 'Visto.'], [wakeText('fix GX #739', 'haiku', 30, DEFAULT_HEARTBEAT, undefined, '# Wake radar'), 'Corrigi.']]) {
      fire('message_end', { message: { role: 'custom', customType: REPORT_TYPE, content, display: true } });
      fire('agent_end', { messages: answer(reply) });
    }
    await tracker.idle();
    assert.deepEqual(f.tasks().map(t => [t.title, t.status]), [['Wake: fix GX #739', 'ready_for_review']]);
  } finally { await f.close(); }
});

test('an aborted run fails; wakes are labelled and never wait for an answer', async () => {
  const f = await fixture();
  try {
    f.tracker.userMessage(wakeText('fix GX #739', 'haiku', 30, DEFAULT_HEARTBEAT, undefined, '# Wake radar'));
    f.tracker.runEnded(answer('Devo seguir?'));
    f.tracker.userMessage('outra coisa');
    f.tracker.runEnded(answer('', 'aborted'));
    await f.tracker.idle();
    const byTitle = new Map(f.tasks().map(t => [t.title, t]));
    assert.equal(byTitle.get('Wake: fix GX #739')?.status, 'needs_input');
    assert.equal(byTitle.get('outra coisa')?.status, 'failed'); // Not a continuation of the wake.
  } finally { await f.close(); }
});

test('background shells and subagents each get a task from start to end', async () => {
  const f = await fixture();
  try {
    const listeners = new Set<() => void>();
    const shells: ShellJob[] = [{ id: 'fg', command: 'ls', cwd: '.', mode: 'foreground', state: 'running', started: 1, output: '', notify: 'end' }];
    const agents: RunInfo[] = [];
    const source = <T>(items: () => T[]) => ({ subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); }, snapshot: items });
    f.tracker.watchShells(source(() => shells));
    f.tracker.watchAgents(source(() => agents));
    const changed = () => { for (const l of listeners) l(); };
    shells.push({ id: 'bg', command: 'npm test', cwd: '.', mode: 'background', state: 'running', started: 2, output: '', notify: 'end' });
    agents.push({ id: 'abcdef123456', task: 'review PR', state: 'running' } as RunInfo);
    changed(); changed();
    await f.tracker.idle();
    assert.deepEqual(f.tasks().map(t => [t.title, t.status]).sort(), [['[abcdef12] review PR', 'working'], ['npm test', 'working']]);
    Object.assign(shells[1], { state: 'failed', ended: 3, exitCode: 1, output: '2 failing' });
    agents.pop();
    changed();
    await f.tracker.idle();
    const byTitle = new Map(f.tasks().map(t => [t.title, t]));
    assert.equal(byTitle.get('npm test')?.status, 'failed');
    assert.match(f.notes(byTitle.get('npm test')!.taskId).at(-1)!, /exit 1 · 2 failing/);
    assert.equal(byTitle.get('[abcdef12] review PR')?.status, 'ready_for_review');
  } finally { await f.close(); }
});

test('a stopped service costs one warning; a profile without an assistant stays silent', async () => {
  const f = await fixture();
  try {
    await f.stop();
    f.tracker.userMessage('a'); f.tracker.runEnded(answer('b'));
    f.tracker.userMessage('c'); f.tracker.runEnded(answer('d'));
    await f.tracker.idle();
    assert.equal(f.warnings.length, 1);
  } finally { await f.close(); }
  const silent = new WorkTracker(() => ({ dir: f.dir, name: 'p', sessionId: 's' }), undefined, text => f.warnings.push(text));
  silent.userMessage('a'); silent.runEnded(answer('b'));
  await silent.idle();
  assert.equal(f.warnings.length, 1);
});

test('classify names the door each run came through', () => {
  assert.deepEqual(classify(wakeText('', 'haiku', 30, DEFAULT_HEARTBEAT, undefined, '# Wake radar')), { channel: 'Wake', title: 'Wake agendado' });
  assert.deepEqual(classify(wakeText('fix GX #739', 'haiku', 30, DEFAULT_HEARTBEAT, { path: '/p/q.md', item: '- [ ] x' })), { channel: 'Wake', title: 'Wake: fix GX #739' });
  assert.equal(classify("The operator's fixed 30-min schedule woke you").channel, 'OptChat', 'only a real wake prompt counts');
  assert.equal(classify('[shell 1234] exited').channel, 'Shell');
  assert.equal(classify('[c6191f36] report').channel, 'Subagente');
  assert.equal(classify('oi').channel, 'OptChat');
  assert.deepEqual(classify('[Slack #dentai] e o deploy?'), { channel: 'Slack #dentai', title: 'e o deploy?' });
});
