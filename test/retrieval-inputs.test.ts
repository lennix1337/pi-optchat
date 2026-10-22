import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { Memory } from '../src/memory.ts';
import { OutputContext, outputReadTool } from '../src/output-context.ts';
import { OutputStore } from '../src/output-store.ts';
import { withTempDir } from './support.ts';
import { memoryTools, searchTool } from '../src/tools.ts';

const REF = 'a'.repeat(64);
const validate = (tool: { name: string; parameters: unknown }, args: Record<string, unknown>) =>
  validateToolArguments(tool as never, { type: 'toolCall', id: 'call', name: tool.name, arguments: args as never });

const withDirectory = (run: (dir: string) => Promise<void>) => withTempDir('optchat-retrieval-inputs-', run);

test('zoom, search and output_read reject unknown keys, nested query keys included, in the native validator', async () => {
  await withDirectory(async dir => {
    const memory = new Memory(dir, async () => 'summary', () => {});
    try {
      const [zoom, date] = memoryTools(() => memory);
      const search = searchTool(() => memory);
      const outputRead = outputReadTool(() => new OutputContext(new OutputStore(dir, 'session')));
      assert.throws(() => validate(zoom, { id: 0, n: 1, findTxt: 'alpha' }), /findTxt/);
      assert.throws(() => validate(search, { text: 'alpha', limit: 5 }), /limit/);
      assert.throws(() => validate(outputRead, { ref: REF, findTxt: 'alpha' }), /findTxt/);
      assert.throws(() => validate(date, { id: 0, text: 'alpha' }), /text/);
      assert.throws(() => validate(outputRead, { ref: REF, query: { kind: 'lines', startLine: 1, endLine: 2, extra: true } }), /extra/);
      assert.throws(() => validate(outputRead, { ref: REF, query: { kind: 'json', field: ['status'] } }), /field/);
      // Documented inputs still pass unchanged.
      assert.deepEqual(validate(zoom, { id: 0, n: 1, findText: 'alpha', offset: 2 }), { id: 0, n: 1, findText: 'alpha', offset: 2 });
      assert.deepEqual(validate(date, { id: 0 }), { id: 0 });
      assert.deepEqual(validate(search, { text: 'alpha', before: 3 }), { text: 'alpha', before: 3 });
      assert.deepEqual(validate(outputRead, { ref: REF, offset: 0, limit: 10, findText: 'x' }), { ref: REF, offset: 0, limit: 10, findText: 'x' });
      assert.deepEqual(validate(outputRead, { ref: REF, query: { kind: 'lines', startLine: 1, endLine: 2 } }).query, { kind: 'lines', startLine: 1, endLine: 2 });
      assert.deepEqual(validate(outputRead, { ref: REF, query: { kind: 'json', path: '$.a', fields: ['b'] } }).query, { kind: 'json', path: '$.a', fields: ['b'] });
    } finally { await memory.close(); }
  });
});

test('an unavailable zoom range names the valid scope, and empty history says so', async () => {
  await withDirectory(async dir => {
    const memory = new Memory(dir, async () => 'summary', () => {});
    try {
      const [zoom] = memoryTools(() => memory);
      const [, emptyDate] = memoryTools(() => memory);
      await assert.rejects(emptyDate.execute('empty-date', { id: 0 }), /^Error: No message 0\. Memory has no messages yet\.$/);
      await assert.rejects(zoom.execute('empty', { id: 0, n: 1 }), /^Error: No line 0\+1\. Memory has no messages yet\.$/);
      await assert.rejects(zoom.execute('empty-find', { id: 0, n: 1, findText: 'x' }), /No line 0\+1\. Memory has no messages yet\./);
      for (const text of ['a', 'b', 'c']) memory.append('user', text);
      await assert.rejects(zoom.execute('past-end', { id: 3, n: 1 }), /^Error: No line 3\+1\. Messages run 0-2; n is a power of two, id a multiple of n, id\+n at most 3\.$/);
      await assert.rejects(zoom.execute('unaligned', { id: 1, n: 2, findText: 'a' }), /No line 1\+2\. Messages run 0-2;/);
      assert.throws(() => memory.zoom(3, 1), /Messages run 0-2;/);
      const [, date] = memoryTools(() => memory);
      await assert.rejects(date.execute('past-end', { id: 3 }), /^Error: No message 3\. Messages run 0-2\.$/);
      assert.match(await date.execute('first', { id: 0 }).then(reply => reply.content[0].text), /\d{4}/);
    } finally { await memory.close(); }
  });
});

test('output_read overflow errors give the valid scope and a continuation', () => {
  const store = new OutputStore(mkdtempSync(join(tmpdir(), 'optchat-retrieval-output-')), 'session');
  try {
    const lines = store.put(Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join('\n'));
    assert.throws(() => store.query(lines, { kind: 'lines', startLine: 1, endLine: 201 }),
      /Invalid line range: use 1-based startLine <= endLine, at most 200 lines per query/);
    assert.throws(() => store.query(lines, { kind: 'lines', startLine: 290, endLine: 310 }),
      /Line range exceeds output length \(300 lines\); use endLine 300 or less/);
    const wide = store.put('é'.repeat(30_000));
    assert.throws(() => store.query(wide, { kind: 'lines', startLine: 1, endLine: 1 }),
      /24000-byte limit; request fewer or shorter lines, or page the original with output_read offset\/limit without a query/);
    const json = store.put(JSON.stringify({ big: 'é'.repeat(30_000) }));
    assert.throws(() => store.query(json, { kind: 'json' }),
      /24000-byte limit; request fewer fields, or page the original with output_read offset\/limit without a query/);
  } finally { rmSync(store.directory, { recursive: true, force: true }); }
});

test('output_read text search says it is case-sensitive and continues with a runnable call', () => {
  const store = new OutputStore(mkdtempSync(join(tmpdir(), 'optchat-retrieval-find-')), 'session');
  try {
    const ref = store.put('Alpha beta alpha gamma');
    assert.match(store.page(ref, { findText: 'alpha' }), /Match at character 11; to find the next, repeat findText with offset 16\./);
    assert.match(store.page(ref, { findText: 'ALPHA' }), /No case-sensitive literal match after character 0\./);
    assert.match(outputReadTool(() => new OutputContext(store)).description, /case-sensitive literal findText/);
  } finally { rmSync(store.directory, { recursive: true, force: true }); }
});

test('output_read offset past the saved output states the valid range for paging and search', () => {
  const store = new OutputStore(mkdtempSync(join(tmpdir(), 'optchat-retrieval-offset-')), 'session');
  try {
    const ref = store.put('Alpha beta');
    assert.throws(() => store.page(ref, { offset: 11 }), /^Error: Output has 10 characters; offset must be 0 to 10\.$/);
    assert.throws(() => store.page(ref, { offset: 11, findText: 'beta' }), /^Error: Output has 10 characters; offset must be 0 to 10\.$/);
    assert.match(store.page(ref, { offset: 10 }), /\[characters 10-10 of 10\]/);
  } finally { rmSync(store.directory, { recursive: true, force: true }); }
});

test('output_read JSON index errors name the array length and the valid indexes', () => {
  const store = new OutputStore(mkdtempSync(join(tmpdir(), 'optchat-retrieval-index-')), 'session');
  try {
    const ref = store.put('{"items":[{"a":1},{"a":2}],"name":"x","none":[]}');
    assert.throws(() => store.query(ref, { kind: 'json', path: '$.items[2]' }), /index 2 does not exist; the array has 2 items \(indexes 0-1\)/);
    assert.throws(() => store.query(ref, { kind: 'json', path: '$.none[0]' }), /index 0 does not exist; the array is empty/);
    assert.throws(() => store.query(ref, { kind: 'json', path: '$.name[0]' }), /index 0 does not exist; the value is not an array/);
    assert.match(store.query(ref, { kind: 'json', path: '$.items[1]' }), /\{"a":2\}$/);
  } finally { rmSync(store.directory, { recursive: true, force: true }); }
});
