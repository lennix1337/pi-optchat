import { test } from 'node:test';
import assert from 'node:assert/strict';
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OutputStore } from '../src/output-store.ts';
import { OutputContext, outputReadTool } from '../src/output-context.ts';
import { tempDir } from './support.ts';
import { toolResultMessage } from './messages.ts';

const log = `${'build: compiling module successfully\n'.repeat(2000)}error CS0246: missing Type\nFAILED test one\nTests: 1 failed, 400 passed\nexit code 1\n`;
const message = (text = log) => toolResultMessage('call', 'bash', text, { isError: true, timestamp: 1 });
const fixture = () => tempDir('optchat-output-');
test('shell projection preserves original, diagnostics and error state; originals survive restart and search', () => {
  const f = fixture();
  try {
    const store = new OutputStore(f.dir, 'session-one'), context = new OutputContext(store);
    const original = message(), before = JSON.stringify(original);
    const projected = context.project([original])[0];
    assert.equal(JSON.stringify(original), before);
    assert.equal(projected.role === 'toolResult' && projected.isError, true);
    const text = JSON.stringify(projected);
    assert.ok(text.length < log.length / 4);
    assert.match(text, /CS0246/); assert.match(text, /400 passed/); assert.match(text, /omitted/);
    const ref = /output:([a-f0-9]{64})/.exec(text)![1];
    assert.equal(new OutputStore(f.dir, 'session-one').read(ref), log);
    assert.throws(() => new OutputStore(f.dir, 'session-two').read(ref), /unavailable/);
    assert.match(store.page(ref, { findText: 'CS0246' }), /missing Type/);
    assert.match(store.page(ref, { offset: log.length - 12, limit: 12 }), /exit code 1/);
    assert.deepEqual(context.project([original]), [projected]);
    assert.equal(context.stats().stored, 1);
  } finally { f.close(); }
});
test('small/unknown/image results stay exact; storage failures fail open', () => {
  const f = fixture();
  try {
    const store = new OutputStore(f.dir, 's', { maxBytes: 10 }), context = new OutputContext(store);
    const m = message(); assert.equal(context.project([m])[0], m);
    const small = message('error'); assert.equal(context.project([small])[0], small);
    const unknown = { ...message(), toolName: 'read' }; assert.equal(context.project([unknown])[0], unknown);
    const image = { ...message(), content: [{ type: 'image' as const, data: 'x', mimeType: 'image/png' }] };
    assert.equal(context.project([image])[0], image);
    assert.throws(() => store.read('../secrets'), /Invalid/);
  } finally { f.close(); }
});
test('cleanup uses record expiry, not restored filesystem timestamps', () => {
  const f = fixture();
  try {
    let now = Date.now();
    const store = new OutputStore(f.dir, 'one', { ttlMs: 1000, now: () => now });
    const ref = store.put('restored live output');
    const file = join(store.directory, `${ref}.json`);
    utimesSync(file, new Date(0), new Date(0));
    assert.equal(store.read(ref), 'restored live output');
    new OutputStore(f.dir, 'two', { ttlMs: 1000, now: () => now }).put('new output');
    assert.equal(store.read(ref), 'restored live output');
    now += 1001;
    utimesSync(file, new Date(now), new Date(now));
    store.put('cleanup expired output');
    assert.throws(() => store.read(ref), /unavailable/);
  } finally { f.close(); }
});
test('profile quota covers all sessions without evicting unexpired originals', () => {
  const f = fixture();
  try {
    const one = new OutputStore(f.dir, 'one', { maxBytes: 200 });
    const ref = one.put('a'.repeat(80));
    assert.throws(() => new OutputStore(f.dir, 'two', { maxBytes: 200 }).put('b'.repeat(80)), /full/);
    assert.equal(one.read(ref), 'a'.repeat(80));
  } finally { f.close(); }
});
test('unverifiable profile records still count against shared quota', () => {
  const f = fixture();
  try {
    const one = new OutputStore(f.dir, 'one', { maxBytes: 200 });
    const ref = one.put('a'.repeat(80));
    writeFileSync(join(one.directory, `${ref}.json`), 'invalid'.repeat(40));
    assert.throws(() => new OutputStore(f.dir, 'two', { maxBytes: 200 }).put('b'.repeat(80)), /full/);
  } finally { f.close(); }
});
test('omitted diagnostic matches remain recoverable, never silently treated as success', () => {
  const f = fixture();
  try {
    const context = new OutputContext(new OutputStore(f.dir, 'one'));
    const original = message(Array.from({ length: 120 }, (_, i) => `error diagnostic_${i}_ ${'detail '.repeat(40)}`).join('\n'));
    const projected = JSON.stringify(context.project([original]));
    const ref = /output:([a-f0-9]{64})/.exec(projected)![1];
    assert.match(projected, /120 diagnostic-pattern matches, not a verdict/);
    assert.ok(!projected.includes('diagnostic_60_'));
    assert.match(context.read(ref, { findText: 'diagnostic_60_', limit: 1000 }), /diagnostic_60_/);
  } finally { f.close(); }
});
test('output_read exposes structured retrieval with shared read metrics and rejects mixed modes', async () => {
  const f = fixture();
  try {
    const store = new OutputStore(f.dir, 'structured'), context = new OutputContext(store);
    const tool = outputReadTool(() => context);
    const ref = store.put(JSON.stringify({ result: { status: 'failed', details: 'original evidence' } }));
    const response = await tool.execute('json', { ref, query: { kind: 'json', path: '$.result', fields: ['status'] } });
    assert.match(response.content[0].text, /failed/);
    assert.ok(!response.content[0].text.includes('original evidence'));
    const lines = store.put('first\nsecond\nthird');
    assert.match((await tool.execute('lines', { ref: lines, query: { kind: 'lines', startLine: 2, endLine: 2 } })).content[0].text, /2: second/);
    await assert.rejects(tool.execute('mixed', { ref, offset: 0, query: { kind: 'json' } }), /not both/);
    assert.equal(context.stats().reads, 2);
    assert.match(store.read(ref), /original evidence/);
  } finally { f.close(); }
});
test('bounded retention, integrity and Unicode-safe paging', () => {
  const f = fixture(); let now = Date.now();
  try {
    const store = new OutputStore(f.dir, 's', { ttlMs: 1000, now: () => now });
    const ref = store.put('a😀b\nerror deep');
    assert.match(store.page(ref, { offset: 2, limit: 1 }), /😀/);
    assert.throws(() => store.page(ref, { limit: 25001 }), /Invalid/);
    writeFileSync(join(store.directory, `${ref}.json`), '{}');
    assert.throws(() => store.read(ref), /integrity/);
    const next = store.put('next'); now += 2000;
    assert.throws(() => store.read(next), /expired/);
    store.put('fresh');
    assert.throws(() => store.read(next), /unavailable/);
  } finally { f.close(); }
});
