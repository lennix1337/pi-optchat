import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import type { ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { executeCodemode as ExecuteCodemode } from '../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/execute.js';
import { Memory } from '../src/memory.ts';
import { memoryTools } from '../src/tools.ts';
import { saveImages } from '../src/images.ts';
import { textContent } from '../src/transcript.ts';

// Exercise the real runtime converter and QuickJS executor, with an isolated synthetic tool host.
const runtime = process.env.PI_CODEMODE_RUNTIME ?? resolve(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '..');
const { executeCodemode } = await import(pathToFileURL(join(runtime, 'dist/extensions/codemode/execute.js')).href) as { executeCodemode: typeof ExecuteCodemode };
const version = JSON.parse(readFileSync(join(runtime, 'package.json'), 'utf8')).version;
const output = (reply: Awaited<ReturnType<typeof ExecuteCodemode>>) => textContent(reply.content, false).split('Output:\n')[1]?.trim() ?? '';

async function withHost(run: (h: ReturnType<typeof host>, memory: Memory, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-codemode-'));
  const memory = new Memory(dir, async () => 'summary', () => {});
  try { await run(host(memory, dir), memory, dir); }
  finally { await memory.close(); rmSync(dir, { recursive: true, force: true }); }
}
function host(memory: Memory, dir: string) {
  const tools = memoryTools(() => memory);
  const zoom = tools[0] as ToolDefinition;
  let count = 0;
  const ctx = {
    cwd: dir, tools, sessionManager: { getBranch: () => [] },
    async executeTool(name: string, args: Parameters<typeof zoom.execute>[1]) {
      const toolCall = { id: `nested-${++count}`, name, arguments: args };
      try {
        assert.equal(name, 'zoom');
        return { toolCall, result: await zoom.execute(toolCall.id, args, undefined, undefined, ctx), isError: false };
      } catch (error) {
        return { toolCall, result: { content: [{ type: 'text', text: String(error) }], details: {} }, isError: true };
      }
    },
  } as unknown as ExtensionToolContext;
  return {
    direct: (args: Parameters<typeof zoom.execute>[1]) => zoom.execute('direct', args, undefined, undefined, ctx),
    get count() { return count; },
    run: (code: string) => executeCodemode('fixture', { code }, undefined, undefined, ctx),
  };
}

function smallPng() {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
}

test('real Code Mode: one zoom matches direct text but adds no call reduction', () => withHost(async (h, memory) => {
  memory.append('user', 'complete original');
  const direct = await h.direct({ id: 0, n: 1 });
  const reply = await h.run('text(await tools.zoom({id:0,n:1}));');
  assert.equal(reply.isError, undefined);
  assert.equal(output(reply), textContent(direct.content, false));
  assert.equal(h.count, 1);
  assert.equal(reply.details.fullOutputPath, undefined);
}));

test('real Code Mode: independent text reads keep every id and success despite failure', t => withHost(async (h, memory) => {
  for (const text of ['first original', 'second original', 'third original']) memory.append('user', text);
  const reply = await h.run(`const ids=[0,99,1,2];
const results=await Promise.allSettled(ids.map(id=>tools.zoom({id,n:1})));
text(results.map((result,i)=>({id:ids[i],status:result.status,...(result.status==='fulfilled'?{text:result.value}:{error:String(result.reason)})})));`);
  const records = JSON.parse(output(reply));
  assert.deepEqual(records.map((r: { id: number; status: string }) => [r.id, r.status]), [[0, 'fulfilled'], [99, 'rejected'], [1, 'fulfilled'], [2, 'fulfilled']]);
  for (const id of [0, 1, 2]) assert.equal(records.find((r: { id: number }) => r.id === id).text, memory.zoom(id, 1));
  assert.equal(reply.details.fullOutputPath, undefined);
  assert.equal(h.count, 4);
  t.diagnostic(JSON.stringify({ runtime: version, outerCalls: 1, nestedCalls: h.count, successes: 3, failures: 1, complete: true, modelTurns: 'not measured', modelTokens: 'not measured' }));
}));

test('real Code Mode: dependent paging follows offsets without losing characters', () => withHost(async (h, memory) => {
  memory.append('user', 'a'.repeat(99) + '😀' + 'b'.repeat(120));
  const reply = await h.run(String.raw`let offset=0; const pages=[];
for (;;) {
 const page=await tools.zoom({id:0,n:1,offset,limit:100}); pages.push({offset,text:page});
 const next=/next page: offset (\d+)\]/.exec(page); if (!next) break; offset=Number(next[1]);
}
text(pages);`);
  const pages = JSON.parse(output(reply)) as { offset: number; text: string }[];
  assert.deepEqual(pages.map(p => p.offset), [0, 99, 199]);
  for (const p of pages) assert.equal(p.text, memory.zoom(0, 1, p.offset, 100));
  const joined = pages.map(p => p.text.replace(/^0\+1\|user: /, '').replace(/\n\[showing characters[^\n]+\]$/, '')).join('');
  assert.equal(joined, memory.root[0].text);
  assert.equal(h.count, 3);
}));

test('real Code Mode: direct zoom preserves images; text conversion drops them', () => withHost(async (h, memory, dir) => {
  const image = { type: 'image' as const, data: smallPng().toString('base64'), mimeType: 'image/png' };
  await saveImages(dir, [image]);
  memory.append('user', textContent([{ type: 'text', text: 'look' }, image]));
  const direct = await h.direct({ id: 0, n: 1 });
  assert.deepEqual(direct.content.filter(c => c.type === 'image'), [image]);
  const reply = await h.run('text(await tools.zoom({id:0,n:1}));');
  assert.equal(output(reply), textContent(direct.content, false));
  assert.equal(reply.content.filter(c => c.type === 'image').length, 0);
}));

test('real Code Mode: truncation discloses a recoverable file containing every result', () => withHost(async (h, memory) => {
  for (let id = 0; id < 4; id++) memory.append('user', `original-${id}:` + 'abcdefgh '.repeat(300));
  const reply = await h.run('// @options: {"max_output_tokens": 200}\ntext(await Promise.all([0,1,2,3].map(id=>tools.zoom({id,n:1}))));');
  const file = reply.details.fullOutputPath;
  assert.ok(file, 'oversized output must advertise its saved file, not silently disappear');
  try {
    assert.ok(output(reply).includes(file));
    assert.match(output(reply), /truncat/i);
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(saved, [0, 1, 2, 3].map(id => memory.zoom(id, 1)));
    assert.equal(h.count, 4);
  } finally { rmSync(file, { force: true }); }
}));
