import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfillChildUsage } from '../src/agents.ts';

test('opening the profile reparses only the child sessions that changed since their usage was counted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-child-backfill-'));
  try {
    const a = join(dir, 'a.jsonl'), b = join(dir, 'b.jsonl');
    writeFileSync(a, '{"x":1}\n'); writeFileSync(b, '{"x":2}\n');
    const runs = [{ id: 'a', sessionFile: a, parentSession: 'p' }, { id: 'b', sessionFile: b, parentSession: 'p' }, { id: 'c', parentSession: 'p' }];
    const opened: string[] = [], counted: string[] = [];
    const usage = { backfill: (_entries: unknown[], _session: string, _role: 'main' | 'subagent', runId?: string) => { counted.push(runId!); } };
    const open = (file: string) => { opened.push(file); return { getEntries: () => [] }; };
    const run = () => backfillChildUsage(dir, runs, usage, () => {}, open);

    run();
    assert.deepEqual(opened, [a, b], 'the first open counts every child session');
    assert.deepEqual(counted, ['a', 'b']);

    opened.length = 0; run();
    assert.deepEqual(opened, [], 'an unchanged session is not reopened at the next open');

    appendFileSync(b, '{"x":3}\n'); opened.length = 0; run();
    assert.deepEqual(opened, [b], 'a session that grew is counted again');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a session that fails to open is retried at the next open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-child-backfill-'));
  try {
    const a = join(dir, 'a.jsonl'); writeFileSync(a, '{}\n');
    const warnings: string[] = []; let fail = true, opens = 0;
    const open = () => { opens++; if (fail) throw new Error('boom'); return { getEntries: () => [] }; };
    const usage = { backfill: () => {} };
    backfillChildUsage(dir, [{ id: 'a', sessionFile: a }], usage, text => warnings.push(text), open);
    assert.equal(warnings.length, 1);
    fail = false;
    backfillChildUsage(dir, [{ id: 'a', sessionFile: a }], usage, text => warnings.push(text), open);
    assert.equal(opens, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
