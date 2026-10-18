import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory, bytes } from '../src/memory.ts';
import { updateOperationalState } from '../src/operational-state.ts';
import { BLOCK_LEVEL, NOTE_BYTES, STATUS_BYTES, Sync, inOptMemLog, noteParts, renderStatus } from '../src/sync.ts';
import { removeDir } from './support.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { aiMemoryWriter, type Page } from '../src/ai-memory.ts';

const BLOCK = 2 ** BLOCK_LEVEL;
async function memoryWith(dir: string, messages: number, text = (i: number) => `message ${i}`) {
  const memory = new Memory(join(dir, 'memory'), async input => `merged ${input.part.l}/${input.part.i} ${input.source.slice(0, 300)}`, () => {});
  for (let i = 0; i < messages; i++) memory.append(i % 2 ? 'talk' : 'user', text(i));
  await memory.settle(undefined, 'tree');
  return memory;
}
function withDir(fn: (dir: string) => Promise<void>) {
  return async () => { const dir = mkdtempSync(join(tmpdir(), 'optchat-sync-')); try { await fn(dir); } finally { removeDir(dir); } };
}
function sync(dir: string, memory: Memory, extra: Partial<ConstructorParameters<typeof Sync>[0]> = {}) {
  const sent: string[] = [], warnings: string[] = [];
  const s = new Sync({ profile: 'p', dir, memory, statusFile: join(dir, 'status.md'), model: () => 'prov/model', status: () => true, optmem: () => true,
    send: async text => { sent.push(text); }, hasNote: () => false, warn: text => warnings.push(text), debounceMs: 5, retryMs: 20, ...extra });
  return { s, sent, warnings };
}

test('note parts fit OptMem, split at words, never inside a character, and lose no text', () => {
  const text = `${'Decisão sobre o compactador 🐕 '.repeat(14)}fim`;
  const parts = noteParts(128, 191, text);
  assert.ok(parts.length > 1 && parts.length <= 9);
  parts.forEach((part, k) => {
    assert.ok(bytes(part) <= NOTE_BYTES, `${bytes(part)} bytes`);
    assert.ok(part.startsWith(`[optchat 128-191 ${k + 1}/${parts.length}] `));
    assert.ok(!part.includes('\uFFFD') && !/[\ud800-\udbff](?![\udc00-\udfff])/.test(part));
  });
  const body = parts.map(part => part.slice(part.indexOf('] ') + 2)).join(' ');
  assert.equal(body, text.replace(/\s+/g, ' ').trim());
  // A line that fits is one part; a word longer than the room is cut by bytes; newlines become spaces.
  assert.deepEqual(noteParts(0, 63, 'short\nline'), ['[optchat 0-63 1/1] short line']);
  for (const part of noteParts(0, 63, 'x'.repeat(600))) assert.ok(bytes(part) <= NOTE_BYTES);
  assert.ok(noteParts(0, 63, '"quoted" --flag $HOME %PATH% `tick` \\ back').every(part => bytes(part) <= NOTE_BYTES));
});

test('the status keeps the oldest and newest lines within its budget, names what it left out, and shows operational state', withDir(async dir => {
  const memory = await memoryWith(dir, 400, i => `message ${i} ${'x'.repeat(400)}`);
  try {
    const file = join(dir, 'operational-state.json');
    updateOperationalState(file, { kind: 'objective', text: 'Ship sync A+B', sourceMessageId: '1' });
    const text = renderStatus({ profile: 'p', model: 'prov/model', memory, operationalFile: file, now: new Date('2026-01-01T00:00:00Z') }, 8_000);
    assert.ok(bytes(text) <= 8_000, `${bytes(text)}`);
    assert.match(text, /^# OptChat status: profile p/);
    assert.match(text, /Updated 2026-01-01T00:00:00.000Z · model prov\/model · 400 messages/);
    assert.match(text, /Ship sync A\+B/);
    const last = memory.view.at(-1)!;
    assert.ok(text.includes(`\n${last.i * 2 ** last.l}+${2 ** last.l}|`), 'the newest line is kept');
    assert.match(text, /^0\+\d+\|/m);
    assert.match(text, /\(messages \d+-\d+ omitted here/);
    // The full default budget holds a small chat whole.
    const small = renderStatus({ profile: 'p', memory });
    assert.ok(bytes(small) <= STATUS_BYTES);
  } finally { await memory.close(); }
}));

test('an unreadable operational state is reported in the status instead of failing it', withDir(async dir => {
  const memory = await memoryWith(dir, 3);
  try {
    const file = join(dir, 'operational-state.json');
    writeFileSync(file, '{not json');
    assert.match(renderStatus({ profile: 'p', memory, operationalFile: file }), /operational state unreadable/);
  } finally { await memory.close(); }
}));

test('sync starts at the newest finished block, sends each block once and in order, and resumes from its cursor', withDir(async dir => {
  const memory = await memoryWith(dir, 3 * BLOCK + 5);
  try {
    const first = sync(dir, memory);
    await first.s.now();
    assert.ok(existsSync(join(dir, 'status.md')));
    assert.ok(first.sent.length >= 1 && first.sent.every(note => note.startsWith(`[optchat ${2 * BLOCK}-${3 * BLOCK - 1} `)), first.sent.join('\n'));
    await first.s.now();
    const count = first.sent.length;
    for (let i = 3 * BLOCK + 5; i < 4 * BLOCK; i++) memory.append('user', `later ${i}`);
    await memory.settle(undefined, 'tree');
    await first.s.now();
    assert.ok(first.sent.slice(count).every(note => note.startsWith(`[optchat ${3 * BLOCK}-${4 * BLOCK - 1} `)) && first.sent.length > count);
    await first.s.close();
    // A new Sync on the same profile continues; nothing is sent twice.
    const again = sync(dir, memory);
    await again.s.now();
    assert.deepEqual(again.sent, []);
    await again.s.close();
    assert.deepEqual(first.warnings, []);
  } finally { await memory.close(); }
}));

test('a failed note warns once, keeps its place and is retried; a note already in OptMem is not sent again', withDir(async dir => {
  const memory = await memoryWith(dir, 2 * BLOCK);
  try {
    let fail = true;
    const attempts: string[] = [];
    const s = sync(dir, memory, { send: async text => { attempts.push(text); if (fail) throw new Error('memo missing'); } });
    await s.s.now(); await s.s.now();
    assert.equal(attempts.length, 1, 'backoff holds retries');
    assert.equal(s.warnings.length, 1);
    assert.match(s.warnings[0], /memo missing/);
    fail = false;
    await new Promise(resolve => setTimeout(resolve, 40));
    await s.s.now();
    assert.equal(attempts[1], attempts[0], 'the same note is retried');
    await s.s.close();
    // A crash after OptMem saved a note, before the cursor moved: the log already has it.
    writeFileSync(join(dir, 'optmem-sync.json'), JSON.stringify({ block: 1, part: 0 }));
    const sentAgain: string[] = [];
    const dedupe = sync(dir, memory, { send: async text => { sentAgain.push(text); }, hasNote: marker => attempts.some(a => a.startsWith(marker)) });
    await dedupe.s.now();
    assert.deepEqual(sentAgain, []);
    await dedupe.s.close();
  } finally { await memory.close(); }
}));

test('a corrupt cursor is not overwritten: sync warns and leaves it for inspection', withDir(async dir => {
  const memory = await memoryWith(dir, 2 * BLOCK);
  try {
    writeFileSync(join(dir, 'optmem-sync.json'), '{"block": -1}');
    const s = sync(dir, memory);
    await s.s.now();
    assert.deepEqual(s.sent, []);
    assert.match(s.warnings.join(), /Invalid OptMem sync cursor/);
    assert.equal(readFileSync(join(dir, 'optmem-sync.json'), 'utf8'), '{"block": -1}');
    await s.s.close();
  } finally { await memory.close(); }
}));

test('the status file is rewritten only when its content changes, debounced, and a bad path warns once', withDir(async dir => {
  const memory = await memoryWith(dir, 4);
  try {
    const s = sync(dir, memory, { optmem: () => false });
    await s.s.now();
    const written = statSync(join(dir, 'status.md')).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 30));
    await s.s.now();
    assert.equal(statSync(join(dir, 'status.md')).mtimeMs, written, 'unchanged content is not rewritten');
    memory.append('user', 'news');
    await memory.settle();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.match(readFileSync(join(dir, 'status.md'), 'utf8'), /\|user: news/);
    await s.s.close();
    mkdirSync(join(dir, 'blocked.md'));
    const bad = sync(dir, memory, { statusFile: join(dir, 'blocked.md'), optmem: () => false });
    await bad.s.now(); memory.append('user', 'more'); await memory.settle(); await bad.s.now();
    assert.equal(bad.warnings.length, 1);
    // Once the path frees up, the write is retried without waiting for another chat change.
    removeDir(join(dir, 'blocked.md'));
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.match(readFileSync(join(dir, 'blocked.md'), 'utf8'), /\|user: more/);
    await bad.s.close();
  } finally { await memory.close(); }
}));

test('with both toggles off, sync writes nothing', withDir(async dir => {
  const memory = await memoryWith(dir, BLOCK * 2);
  try {
    const s = sync(dir, memory, { status: () => false, optmem: () => false });
    await s.s.now(); await s.s.close();
    assert.ok(!existsSync(join(dir, 'status.md')) && !existsSync(join(dir, 'optmem-sync.json')));
    assert.deepEqual(s.sent, []);
  } finally { await memory.close(); }
}));

test('inOptMemLog reads only the log tail', withDir(async dir => {
  const log = join(dir, 'LOG.txt');
  assert.equal(inOptMemLog('[optchat 0-63 1/1]', log), false);
  writeFileSync(log, `#1 2026 [optchat 0-63 1/1] old\n${'y'.repeat(70 * 1024)}\n#2 2026 [optchat 64-127 1/2] new\n`);
  assert.equal(inOptMemLog('[optchat 64-127 1/2]', log), true);
  assert.equal(inOptMemLog('[optchat 0-63 1/1]', log), false);
}));

test('ai-memory sync imports every finished block from block 0 in order, then a status page, and resumes from its cursor', withDir(async dir => {
  const memory = await memoryWith(dir, BLOCK * 3 + 5);
  try {
    const pages: Page[] = [];
    const { s, warnings } = sync(dir, memory, { status: () => false, optmem: () => false, aimemory: () => true, writePage: async page => { pages.push(page); } });
    await s.now(); await s.close();
    assert.deepEqual(pages.map(page => page.path), ['p/blocks/000000-000063.md', 'p/blocks/000064-000127.md', 'p/blocks/000128-000191.md', 'p/status.md']);
    assert.deepEqual(warnings, []);
    const block = pages[1].body;
    assert.match(block, /^# OptChat p: messages 64-127\n/);
    assert.ok(block.includes(`## Summary\n\n${memory.node({ l: BLOCK_LEVEL, i: 1 })!.text}`));
    for (let i = 64; i < 128; i++) assert.ok(block.includes(`\n- ${i} (`), `message ${i}`);
    assert.equal(pages[1].abstract, memory.node({ l: BLOCK_LEVEL, i: 1 })!.text.slice(0, 1000));
    assert.match(pages[3].body, /^# OptChat status: profile p/);

    // A new sync on the same profile writes nothing until another block finishes.
    for (let i = 0; i < BLOCK; i++) memory.append('user', `later ${i}`);
    await memory.settle(undefined, 'tree');
    const again: string[] = [];
    const next = sync(dir, memory, { status: () => false, optmem: () => false, aimemory: () => true, writePage: async page => { again.push(page.path); } });
    await next.s.now(); await next.s.close();
    assert.deepEqual(again, ['p/blocks/000192-000255.md', 'p/status.md']);
  } finally { await memory.close(); }
}));

test('a failed ai-memory write warns once, keeps its place and is retried', withDir(async dir => {
  const memory = await memoryWith(dir, BLOCK * 2);
  try {
    let fail = true; const pages: string[] = [];
    const { s, warnings } = sync(dir, memory, { status: () => false, optmem: () => false, aimemory: () => true,
      writePage: async page => { if (fail && page.path.includes('000064')) throw new Error('server down'); pages.push(page.path); } });
    await s.now(); await s.now();
    assert.deepEqual(pages, ['p/blocks/000000-000063.md']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ai-memory.*server down/);
    fail = false;
    await new Promise(resolve => setTimeout(resolve, 30));
    await s.now(); await s.close();
    assert.deepEqual(pages, ['p/blocks/000000-000063.md', 'p/blocks/000064-000127.md', 'p/status.md']);
  } finally { await memory.close(); }
}));

test('the ai-memory writer sends an authenticated memory_write_page call and surfaces refusals', async () => {
  const requests: { auth?: string; body: { params: { name: string; arguments: Record<string, unknown> } } }[] = [];
  let reply = 'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"ok"}],"isError":false}}\n\n';
  const server = createServer((request, response) => {
    let data = '';
    request.on('data', chunk => { data += chunk; });
    request.on('end', () => { requests.push({ auth: request.headers.authorization, body: JSON.parse(data) }); response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(reply); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const write = aiMemoryWriter(url, 'secret');
    await write({ path: 'p/status.md', body: '# x', tags: ['optchat'] });
    assert.equal(requests[0].auth, 'Bearer secret');
    assert.equal(requests[0].body.params.name, 'memory_write_page');
    assert.deepEqual(requests[0].body.params.arguments, { workspace: 'default', project: 'optchat', path: 'p/status.md', body: '# x', tier: 'semantic', tags: ['optchat'] });
    reply = '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"path escapes the wiki"}],"isError":true}}';
    await assert.rejects(write({ path: '../x.md', body: '# x', tags: [] }), /refused \.\.\/x\.md: "path escapes the wiki"/);
  } finally { server.close(); }
});
