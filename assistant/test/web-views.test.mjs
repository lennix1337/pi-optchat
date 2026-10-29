import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channelMark, deepLinkTask, taskLink, originalAccess, ResponseQueue, ChannelArchive, DeclinedSources, setupLabels } from '../web/src/state.js';

test('a channel mark is a stable view decoration derived only from the channel name', () => {
  const a = channelMark('Pesquisa'); const b = channelMark('Pesquisa'); const c = channelMark('Pessoal');
  assert.deepEqual(a, b);
  assert.equal(a.initial, 'P'); assert.ok(Number.isInteger(a.hue) && a.hue >= 0 && a.hue < 360);
  assert.notEqual(a.hue, c.hue);
  assert.equal(channelMark('  ').initial, '#');
  assert.equal(channelMark('élan').initial, 'É');
});

test('deep links name a task only by an encoded identifier, never carry tokens and reject malformed input', () => {
  assert.equal(taskLink('a b/ç'), '#tarefa=a%20b%2F%C3%A7');
  assert.equal(deepLinkTask('#tarefa=a%20b%2F%C3%A7'), 'a b/ç');
  for (const hash of ['', '#', '#token=x', '#tarefa=', '#tarefa=%E0%A4%A', `#tarefa=${'x'.repeat(201)}`, '#tarefa=a%0Ab', '#tarefa=x&token=y'])
    assert.equal(deepLinkTask(hash), null, hash);
});

test('only chat originals offer a terminal command; other references stay inert text', () => {
  assert.deepEqual(originalAccess('optchat:swlucas05:76134'), { kind: 'chat', command: '/assistant original optchat:swlucas05:76134' });
  for (const reference of ['fixture://original/request', 'https://evil.test/x', 'javascript:alert(1)', 'optchat:p:', 'optchat:p:1 ; rm', 'optchat::1'])
    assert.deepEqual(originalAccess(reference), { kind: 'text' }, reference);
});

test('responses typed while another action is in flight are sent in typed order, and an uncertain result holds the queue', async () => {
  const queue = new ResponseQueue();
  queue.add({ taskId: 'a', text: '1' }); queue.add({ taskId: 'b', text: '2' }); queue.add({ taskId: 'a', text: '3' });
  assert.deepEqual(queue.pending().map(item => item.text), ['1', '2', '3']);
  const sent = [];
  await queue.drain(async item => { sent.push(item.text); return item.text !== '2'; });
  assert.deepEqual(sent, ['1', '2'], 'the queue stops at the first send whose outcome was not confirmed');
  assert.deepEqual(queue.pending().map(item => item.text), ['3']);
  assert.throws(() => queue.add({ taskId: 'c', text: '' }), /empty/);
  queue.remove(queue.pending()[0].id); assert.equal(queue.pending().length, 0);
});

test('archiving a channel hides it from the subject list without touching tasks, and is per profile', () => {
  const storage = new Map(); const api = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  const p = new ChannelArchive('p', api); const q = new ChannelArchive('q', api);
  p.archive('Pesquisa');
  assert.ok(p.has('Pesquisa')); assert.equal(q.has('Pesquisa'), false);
  assert.ok(new ChannelArchive('p', api).has('Pesquisa'), 'survives reload');
  p.restore('Pesquisa'); assert.equal(p.has('Pesquisa'), false);
  storage.set('assistant-panel-archived-channels:p', '{not json'); assert.equal(new ChannelArchive('p', api).has('x'), false);
});

test('"Agora não" choices are per profile, separate from archived subjects, and setup has exactly three honest labels', () => {
  const storage = new Map(); const api = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  const declined = new DeclinedSources('p', api); declined.add('google');
  assert.ok(new DeclinedSources('p', api).has('google')); assert.equal(new DeclinedSources('q', api).has('google'), false);
  assert.equal(new ChannelArchive('p', api).has('google'), false);
  assert.deepEqual(Object.keys(setupLabels), ['ready', 'not_verified', 'needs_setup']);
});
