import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_HEARTBEAT, wakeText } from '../src/heartbeat.ts';
import { addQueueItem, nextQueueItem, parseQueue, queueFile, renderQueue } from '../src/heartbeat-queue.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'beat-queue-'));

test('the queue is a markdown checklist a person can edit: [ ] open, [x] done, [!] blocked', () => {
  assert.deepEqual(parseQueue(`# Heartbeat work queue
Notes the heartbeat ignores.
- [x] shipped thing
- [!] needs the prod password
* [ ] second job
- [ ]   first open job  
- [X] also done
- not a checkbox`), [
    { text: 'shipped thing', state: 'done' }, { text: 'needs the prod password', state: 'blocked' },
    { text: 'second job', state: 'open' }, { text: 'first open job', state: 'open' }, { text: 'also done', state: 'done' }]);
});

test('the next item is the first open one; done and blocked items are never taken', () => {
  const dir = temp();
  assert.equal(nextQueueItem(dir), undefined, 'no file, no queue');
  writeFileSync(queueFile(dir), '- [x] done\n- [!] stuck: waiting on credentials\n- [ ] fix the flaky test\n- [ ] later\n');
  assert.equal(nextQueueItem(dir), 'fix the flaky test');
  writeFileSync(queueFile(dir), '- [x] done\n- [!] stuck\n');
  assert.equal(nextQueueItem(dir), undefined);
  rmSync(dir, { recursive: true, force: true });
});

test('an open item annotated as blocked instead of marked [!] is still not taken', () => {
  const dir = temp();
  writeFileSync(queueFile(dir), [
    '- [ ] deploy the site (blocked: needs approval)', '- [ ] publish — blocked: no token', '- [ ] wait [blocked] on review',
    '- [ ] Blocked: waiting for the vendor', '- [ ] fix the PRs that are blocked by CI', '- [ ] unblock the build'].join('\n'));
  assert.equal(nextQueueItem(dir), 'fix the PRs that are blocked by CI', 'a plain mention of the word does not block an item');
  rmSync(dir, { recursive: true, force: true });
});

test('adding an item appends one open line, creating the file with a header and keeping a person\'s edits', () => {
  const dir = temp();
  addQueueItem(dir, 'review\nthe   open PRs');
  const created = readFileSync(queueFile(dir), 'utf8');
  assert.match(created, /^# /);
  assert.deepEqual(parseQueue(created), [{ text: 'review the open PRs', state: 'open' }]);
  writeFileSync(queueFile(dir), '- [ ] hand edited, no final newline');
  addQueueItem(dir, 'second');
  assert.equal(readFileSync(queueFile(dir), 'utf8'), '- [ ] hand edited, no final newline\n- [ ] second\n');
  assert.throws(() => addQueueItem(dir, '   '), /Usage/);
  rmSync(dir, { recursive: true, force: true });
});

test('the listing shows open and blocked items and counts the done ones', () => {
  const dir = temp();
  assert.match(renderQueue(dir), /empty/i);
  writeFileSync(queueFile(dir), '- [x] a\n- [x] b\n- [ ] c\n- [!] d\n');
  const text = renderQueue(dir);
  assert.match(text, /\[ \] c/); assert.match(text, /\[!\] d/); assert.match(text, /2 done/);
  assert.match(text, /next: c/);
  assert.ok(text.includes(queueFile(dir)));
  rmSync(dir, { recursive: true, force: true });
});

const queue = { path: '/p/heartbeat-queue.md', item: 'fix the flaky test' };
test('queue entries are candidates, not unconditional priorities or a drain-until-empty instruction', () => {
  for (const task of ['', 'continue task-7']) {
    const text = wakeText(task, 'anthropic/claude-haiku-5-5', 30, DEFAULT_HEARTBEAT, queue);
    assert.match(text, /fix the flaky test/);
    assert.ok(text.includes('/p/heartbeat-queue.md'));
    assert.match(text, /- \[x\]/); assert.match(text, /- \[!\]/);
    assert.match(text, /not a priority order/);
    assert.match(text, /inspect other open items/);
    assert.doesNotMatch(text, /Do it before|Then take the next open item|first open job/);
    assert.match(text, /Never[^]*Merge/, 'the plan limits stay in force');
    assert.match(text, /within the limits below/);
  }
});

test('with an empty queue the wake is the plan jobs, as before', () => {
  assert.equal(wakeText('x', 'm', 30, DEFAULT_HEARTBEAT, { path: '/p/q.md' }), wakeText('x', 'm', 30, DEFAULT_HEARTBEAT));
  assert.doesNotMatch(wakeText('x', 'm', 30, DEFAULT_HEARTBEAT), /Work queue candidate:|\/p\/q\.md/);
});
