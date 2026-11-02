import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readManyTool } from '../src/read-many.ts';

test('read_many reads several files in one call, in parallel, and keeps going past a missing one', async () => {
  let inFlight = 0, peak = 0;
  const slow = { async execute(_id: string, a: { path: string }) {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 50)); inFlight--;
    if (a.path === 'missing') throw new Error('ENOENT missing');
    return { content: [{ type: 'text' as const, text: `body of ${a.path}` }] };
  } };
  const t0 = Date.now();
  const out = await readManyTool('.', slow).execute('1', { files: [{ path: 'a' }, { path: 'missing' }, { path: 'c' }] });
  assert.equal(peak, 3);
  assert.ok(Date.now() - t0 < 140, 'three 50 ms reads must overlap');
  assert.deepEqual(out.content.map(p => (p as { text: string }).text), ['== a', 'body of a', '== missing', 'Error: ENOENT missing', '== c', 'body of c']);
  assert.deepEqual(out.details, { files: 3, failed: 1 });
});

test('read_many uses the real read tool with offset and limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'read-many-'));
  writeFileSync(join(dir, 'x.txt'), 'l1\nl2\nl3\n'); writeFileSync(join(dir, 'y.txt'), 'only\n');
  const out = await readManyTool(dir).execute('1', { files: [{ path: 'x.txt', offset: 2, limit: 1 }, { path: 'y.txt' }] });
  const text = out.content.map(p => (p as { text: string }).text).join('\n');
  assert.match(text, /== x\.txt\nl2/);
  assert.doesNotMatch(text, /l1|l3/);
  assert.match(text, /== y\.txt\nonly/);
});
