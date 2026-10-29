import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Memory } from '../src/memory.ts';
import { registerAssistantMemory, type AssistantMemoryOwner } from '../src/assistant-memory.ts';
import { MemoryView, type Original } from '../assistant/src/memory/projection.ts';
import { createPrivateDirectory } from '../assistant/src/store/private-directory.ts';

test('registered memory reads FileStore originals, pages, persists corrections and refuses stale or switched owners', { timeout: 120000 }, async () => {
  const dir = join(tmpdir(), `assistant-memory-${randomUUID()}`); createPrivateDirectory(dir);
  let memory = new Memory(dir, async () => 'summary');
  const long = 'a'.repeat(5999) + '😀' + 'b'.repeat(4500);
  memory.append('user', long, '2026-01-01T00:00:00.000Z');
  memory.append('talk', 'original assistant claim', '2026-01-02T00:00:00.000Z', undefined, { source: 'claude', conversation: 'c', message: 'm', title: 't' });
  const about = join(dir, 'ABOUT-ME.md'); writeFileSync(about, '# About\n- first fact\n');
  let owner: AssistantMemoryOwner = { identity: {}, profileId: 'p', sessionId: 's', memory, databasePath: join(dir, 'corrections.sqlite'), aboutMePath: about };
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  registerAssistantMemory({ registerCommand: (_name: string, options: { handler: typeof handler }) => { handler = options.handler; } } as unknown as ExtensionAPI, () => owner);
  const notices: string[] = [], inputs: string[] = [];
  let afterInput: (() => void) | undefined;
  const ctx = { mode: 'tui', hasUI: true, sessionManager: { getSessionId: () => 's' }, ui: { notify: (s: string) => notices.push(s), input: async () => { const value = inputs.shift(); afterInput?.(); afterInput = undefined; return value; }, confirm: async () => true } } as unknown as ExtensionCommandContext;
  const run = async (command: string) => { notices.length = 0; await handler(command, ctx); return notices.join('\n'); };
  try {
    let output = await run('read 0');
    assert.match(output, /Untrusted historical original/); assert.match(output, /next page: offset 5999/); assert.ok(!output.includes('b'.repeat(100)));
    output = await run('read 0 5999'); assert.ok(output.includes('😀' + 'b'.repeat(100))); assert.match(output, /of 10501/);
    output = await run('read 1'); assert.match(output, /talk/); assert.match(output, /claude/); assert.match(output, /2026-01-02/); assert.match(output, /hypothesis/);
    inputs.push('corrected claim', 'operator clarification'); output = await run('correct 1'); assert.match(output, /Correction recorded/);
    await memory.close(); memory = new Memory(dir, async () => 'summary'); owner = { ...owner, memory };
    output = await run('read 1'); assert.match(output, /original assistant claim/); assert.match(output, /corrected claim/); assert.match(output, /Corrections: 1/);
    assert.equal(memory.root[1].text, 'original assistant claim');
    inputs.push('updated', 'reason'); await run('correct about:2');
    assert.equal(readFileSync(about, 'utf8'), '# About\n- first fact\n');
    writeFileSync(about, '# About\n- changed fact\n'); output = await run('read about:2'); assert.match(output, /stale: 1/); assert.doesNotMatch(output, /Current operator correction/);
    inputs.push('bad swap'); afterInput = () => { owner = { ...owner, identity: {} }; }; output = await run('correct 1'); assert.match(output, /Profile or session changed/);
    output = await run('read 1'); assert.match(output, /Corrections: 1/);
    inputs.push('changed while prompting', 'reason'); afterInput = () => writeFileSync(about, '# About\n- changed again\n'); output = await run('correct about:2');
    assert.match(output, /memory_original_changed/);
    memory.append('note', 'summary\u001b[31m\u009b', '2026-01-03T00:00:00.000Z');
    output = await run('read 2'); assert.match(output, /Kind: summary/); assert.ok(!output.includes('\u001b')); assert.ok(!output.includes('\u009b')); assert.match(output, /\\u001b/);
    output = await run('corrections 1'); assert.match(output, /Applicable/); assert.match(output, /corrected claim/);
    memory.root[1].date = '2026-01-04T00:00:00.000Z'; output = await run('read 1'); assert.match(output, /stale: 1/);
  } finally { await memory.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('MemoryView bounds correction pages, preserves current and rejects empty originals', () => {
  let original: Original = { ref: 'r', text: 'first', author: 'user', kind: 'fact', observedAt: '2026-01-01T00:00:00Z' };
  const authority = {};
  const view = new MemoryView({ databasePath: ':memory:', profileId: 'p', operatorAuthority: authority, sources: [{ sourceId: 's', profileId: 'p', get: () => original }] });
  try {
    const hash = view.read('s', 'r').originalHash;
    for (let i = 0; i < 35; i++) view.correct({ sourceId: 's', ref: 'r', originalHash: hash, text: `fix ${i}`, reason: 'reason', kind: 'fact' }, authority);
    const page = view.read('s', 'r'); assert.equal(page.corrections.length, 32); assert.equal(page.correctionCount, 35); assert.equal(page.nextCorrectionOffset, 32); assert.equal(page.current.text, 'fix 34');
    const next = view.read('s', 'r', 32); assert.equal(next.corrections.length, 3); assert.equal(next.nextCorrectionOffset, undefined);
    original = { ...original, observedAt: '2026-02-01T00:00:00Z' }; assert.equal(view.read('s', 'r').correctionCount, 35);
    original = { ...original, text: ' ' }; assert.throws(() => view.read('s', 'r'), /memory_source_invalid/);
  } finally { view.close(); }
});
