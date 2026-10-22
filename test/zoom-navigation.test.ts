import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { imageRef, saveImages } from '../src/images.ts';
import { Memory, PAGE, type Kind } from '../src/memory.ts';
import { Focus } from '../src/focus.ts';
import { memoryTools, type MemoryRead } from '../src/tools.ts';
import { FIND, findInRange } from '../src/zoom-navigation.ts';
import { removeDir } from './support.ts';

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function withZoom(run: (memory: Memory, zoom: (args: Record<string, unknown>) => Promise<{ content: { type: string; text?: string }[] }>, reads: MemoryRead[]) => Promise<void>,
  runs?: (id: string) => readonly AgentMessage[] | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-zoom-nav-'));
  const memory = new Memory(dir, async () => 'summary', () => {});
  const reads: MemoryRead[] = [];
  const [tool] = memoryTools(() => memory, runs, read => reads.push(read));
  try { await run(memory, args => tool.execute('call', args as never) as never, reads); } finally { await memory.close(); removeDir(dir); }
}
const textOf = (page: { content: { type: string; text?: string }[] }) => page.content[0].text ?? '';
const add = (memory: Memory, lines: [Kind, string][], date = '2026-01-01T00:00:00.000Z') => lines.forEach(([kind, text], i) => memory.append(kind, text, new Date(Date.parse(date) + i * 1000).toISOString()));
const callsOf = (text: string) => [...text.matchAll(/^zoom\(id: (\d+), n: (\d+), findText: ("(?:[^"\\]|\\.)*")(?:, offset: (\d+))?\)$/gm)]
  .map(([, id, n, findText, offset]) => ({ id: Number(id), n: Number(n), findText: JSON.parse(findText) as string, ...offset === undefined ? {} : { offset: Number(offset) } }));
const hitsOf = (text: string) => [...text.matchAll(/^(\d+) · (\S+) · (\w+) · character (\d+) of (\d+) · (zoom\([^)]*\))$/gm)]
  .map(([, id, date, kind, at, length, next]) => ({ id: Number(id), date, kind, at: Number(at), length: Number(length), next }));

test('findText finds literal text in any case, with the exact original offset, Unicode included', () => withZoom(async (memory, zoom, reads) => {
  add(memory, [['user', 'The Ünïcödé plan is ready'], ['user', 'İİİ tail MARK here'], ['talk', 'astral 😀 emoji and ΟΔΟΣ'], ['user', 'nothing relevant']]);
  const unicode = textOf(await zoom({ id: 0, n: 1, findText: 'ÜNÏCÖDÉ' }));
  assert.match(unicode, /^1 match of "ÜNÏCÖDÉ" in message 0, newest message first/);
  assert.deepEqual(hitsOf(unicode).map(({ id, at, kind }) => [id, at, kind]), [[0, 4, 'user']]);
  assert.match(unicode, /\n  The Ünïcödé plan is ready$/);
  // U+0130 lowers to two code units, yet the offset is the original one.
  const dotted = hitsOf(textOf(await zoom({ id: 1, n: 1, findText: 'mark' })))[0];
  assert.equal(dotted.at, 'İİİ tail '.length);
  assert.equal(memory.root[1].text.slice(dotted.at, dotted.at + 4), 'MARK');
  assert.equal(hitsOf(textOf(await zoom({ id: 1, n: 1, findText: 'İİ' })))[0].at, 0);
  // Greek final sigma lowers the same way in text and needle.
  assert.equal(hitsOf(textOf(await zoom({ id: 2, n: 1, findText: 'οδοσ' })))[0].at, memory.root[2].text.indexOf('ΟΔΟΣ'));
  assert.equal(hitsOf(textOf(await zoom({ id: 2, n: 1, findText: '😀' })))[0].at, 'astral '.length);
  const absent = textOf(await zoom({ id: 0, n: 4, findText: '😁' }));
  assert.match(absent, /^No match of "😁" \(any case, literal\) in the part of 0\+4 \(messages 0-3\) that was searched \(\d+ characters of 4 messages searched\)\.$/);
  assert.equal(textOf(await zoom({ id: 0, n: 1, findText: 'Unicode' })).startsWith('No match'), true, 'accents are not folded');
  assert.equal(reads.length, 5, 'only the successful finds with a hit report reads');
}));

test('an excerpt never splits a surrogate pair and the callback gets its exact source location', () => withZoom(async (memory, zoom, reads) => {
  const left = `${'q'.repeat(10)}😀${'p'.repeat(FIND.context - 1)}NEEDLE${'p'.repeat(FIND.context - 1)}😀 tail`;
  add(memory, [['user', left]]);
  const text = textOf(await zoom({ id: 0, n: 1, findText: 'needle' }));
  const [hit] = hitsOf(text), excerpt = text.split('\n  ')[1];
  assert.equal(hit.at, 10 + 2 + FIND.context - 1);
  assert.ok(excerpt.isWellFormed());
  assert.match(excerpt, /^…😀p+NEEDLEp+😀…$/u);
  assert.equal(reads.length, 1);
  const [read] = reads;
  assert.deepEqual([read.id, read.n], [0, 1]);
  assert.equal(`…${memory.root[0].text.slice(read.offset, read.offset! + read.limit!)}…`, excerpt);
  // The suggested call is itself valid.
  assert.match(hit.next, /^zoom\(id: 0, n: 1\)$/);
}));

test('bad or conflicting findText parameters fail explicitly and report no read', () => withZoom(async (memory, zoom, reads) => {
  add(memory, [['user', 'alpha beta'], ['user', 'gamma'], ['user', 'delta'], ['user', 'epsilon']]);
  const bad = (args: Record<string, unknown>, message: RegExp) => assert.rejects(() => zoom(args), message);
  await bad({ id: 0, n: 1, findText: '' }, /findText must be 1 to 200 characters of well-formed text/);
  await bad({ id: 0, n: 1, findText: 'x'.repeat(FIND.maxText + 1) }, /1 to 200 characters/);
  await bad({ id: 0, n: 1, findText: 'a\ud83d' }, /well-formed/);
  await bad({ id: 0, n: 1, findText: '\ude00a' }, /well-formed/);
  await bad({ id: 0, n: 1, findText: 'alpha', limit: 5 }, /does not take limit/);
  await bad({ id: 0, n: 2, findText: 'alpha', offset: 1 }, /offset .* needs n = 1/);
  await bad({ id: 0, n: 1, findText: 'alpha', offset: 10 }, /Message 0 has 10 characters; offset must be 0 to 9/);
  await bad({ agent: 'run', findText: 'alpha' }, /not an agent transcript/);
  await bad({ id: 0, agent: 'run', findText: 'alpha' }, /either id or agent/);
  // Same range admission as a plain zoom, message for message.
  for (const [id, n] of [[1, 2], [0, 3], [0, 8], [4, 1], [0, 0], [-1, 1]]) {
    const expected = (() => { try { memory.zoom(id, n); } catch (error) { return (error as Error).message; } })();
    assert.ok(expected, `${id}+${n} is invalid for zoom`);
    await bad({ id, n, findText: 'alpha' }, new RegExp(expected.replace(/[+]/g, '\\+')));
  }
  assert.throws(() => findInRange(memory, { id: 0, n: 1, findText: 'alpha', limit: 1 }), /does not take limit/);
  assert.deepEqual(reads, []);
}));

test('findText never turns an agent transcript into a memory search', () => withZoom(async (memory, zoom, reads) => {
  add(memory, [['user', 'alpha']]);
  await assert.rejects(() => zoom({ id: 'run-1', findText: 'alpha' }), /not an agent transcript/);
  assert.match(textOf(await zoom({ agent: 'run-1' })), /alpha in a run/);
  assert.match(textOf(await zoom({ id: 'run-1' })), /alpha in a run/);
  await assert.rejects(() => zoom({ agent: 'missing' }), /No run missing/);
  assert.deepEqual(reads, [], 'a transcript read is not a memory read');
}, id => id === 'run-1' ? [{ role: 'user', content: 'alpha in a run', timestamp: 1 }] : undefined));

test('many hits are truncated to the newest, and the named calls recover every other hit exactly once', () => withZoom(async (memory, zoom) => {
  add(memory, Array.from({ length: 32 }, (_, i): [Kind, string] => ['user', i % 4 === 3 ? `note ${i} without it` : `message ${i} mentions TOKEN once`]));
  const first = textOf(await zoom({ id: 0, n: 32, findText: 'token' }));
  const shown = hitsOf(first);
  assert.match(first, /^8\+ matches of "token" in 0\+32 \(messages 0-31\), newest message first/);
  assert.deepEqual(shown.map(hit => hit.id), [30, 29, 28, 26, 25, 24, 22, 21]);
  assert.ok(first.length < 4_000, `bounded output, ${first.length} characters`);
  const all = new Set<number>(), found: number[] = [];
  const queue = [{ text: first }];
  let rounds = 0;
  for (let step = queue.shift(); step; step = queue.shift(), rounds++) {
    for (const hit of hitsOf(step.text)) { found.push(hit.id); all.add(hit.id); }
    for (const call of callsOf(step.text)) queue.push({ text: textOf(await zoom(call)) });
  }
  assert.equal(found.length, all.size, 'no hit is reported twice');
  assert.deepEqual([...all].sort((a, b) => a - b), Array.from({ length: 32 }, (_, i) => i).filter(i => i % 4 !== 3));
  assert.ok(rounds < 20);
  // What was left: the rest of message 20, then the aligned blocks below it, newest first.
  assert.deepEqual(callsOf(first).map(({ id, n, offset }) => [id, n, offset]), [[20, 1, 'message 20 mentions '.length], [16, 4, undefined], [0, 16, undefined]]);
}));

test('a message with many matches resumes exactly after the last one shown', () => withZoom(async (memory, zoom) => {
  const body = Array.from({ length: 20 }, (_, i) => `hit-${String(i).padStart(2, '0')}`).join(' ... '), stride = 'hit-00 ... '.length;
  add(memory, [['user', body]]);
  const first = textOf(await zoom({ id: 0, n: 1, findText: 'HIT-' }));
  assert.deepEqual(hitsOf(first).map(hit => hit.at), Array.from({ length: 8 }, (_, i) => i * stride));
  const [resume] = callsOf(first);
  assert.deepEqual(callsOf(first).length, 1);
  assert.equal(resume.offset, 8 * stride, 'the ninth match is where the next call starts');
  const second = textOf(await zoom(resume));
  assert.deepEqual(hitsOf(second).map(hit => hit.at), Array.from({ length: 8 }, (_, i) => (8 + i) * stride));
  const third = textOf(await zoom(callsOf(second)[0]));
  assert.deepEqual(hitsOf(third).map(hit => hit.at), Array.from({ length: 4 }, (_, i) => (16 + i) * stride));
  assert.deepEqual(callsOf(third), []);
  assert.match(third, /^4 matches of "HIT-" in message 0 from character 176/);
}));

test('a newer correction is listed before the older decision with its own provenance, and logged copies do not shadow it', () => withZoom(async (memory, zoom) => {
  add(memory, [['user', 'Decision: store notes in Postgres'], ['talk', 'Noted.'], ['user', 'Correction: not postgres after all, use SQLite'], ['echo', 'zoom: 0+4|an earlier lookup copied postgres']], '2026-03-01T10:00:00.000Z');
  const text = textOf(await zoom({ id: 0, n: 4, findText: 'postgres' }));
  const hits = hitsOf(text);
  assert.deepEqual(hits.map(hit => [hit.id, hit.kind, hit.date]), [[2, 'user', '2026-03-01T10:00:02.000Z'], [0, 'user', '2026-03-01T10:00:00.000Z']]);
  assert.match(text, /1 logged zoom\/search copies skipped/);
  assert.match(text, /\n  …?Correction: not postgres after all/);
  assert.deepEqual(callsOf(text), []);
  // An explicit single-message selection still reads the copy.
  assert.equal(hitsOf(textOf(await zoom({ id: 3, n: 1, findText: 'postgres' })))[0].kind, 'echo');
}));

test('work is bounded by characters, the unsearched part is named and never counted as no match', () => withZoom(async (memory, zoom) => {
  const piece = FIND.scanChars / 10;
  add(memory, Array.from({ length: 16 }, (_, i): [Kind, string] => ['tool', i === 0 ? `old ${'.'.repeat(piece - 100)} needle` : '.'.repeat(piece)]));
  const first = textOf(await zoom({ id: 0, n: 16, findText: 'NEEDLE' }));
  assert.match(first, /^No match of "NEEDLE" \(any case, literal\) in the part of 0\+16 \(messages 0-15\) that was searched \(1,000,000 characters of 10 messages searched\)\./);
  assert.deepEqual(callsOf(first).map(({ id, n }) => [id, n]), [[4, 2], [0, 4]]);
  const second = textOf(await zoom(callsOf(first)[1]));
  assert.deepEqual(hitsOf(second).map(hit => hit.id), [0]);
  assert.deepEqual(callsOf(second), []);
  assert.match(textOf(await zoom(callsOf(first)[0])), /^No match .*\(200,000 characters of 2 messages searched\)\.$/m);
}));

test('one huge message is searched in a bounded window and resumed where a straddling match could start', () => withZoom(async (memory, zoom) => {
  const needle = 'straddle', at = FIND.scanChars - 3;
  memory.append('tool', `${'.'.repeat(at)}${needle}${'.'.repeat(500)}END${needle}`);
  const first = textOf(await zoom({ id: 0, n: 1, findText: needle }));
  assert.match(first, /^No match .* \(1,000,000 characters of 1 messages searched\)\./);
  const [resume] = callsOf(first);
  assert.equal(resume.offset, FIND.scanChars - needle.length + 1);
  const second = textOf(await zoom(resume));
  assert.deepEqual(hitsOf(second).map(hit => hit.at), [at, at + needle.length + 503]);
  assert.deepEqual(callsOf(second), []);
}));

test('searching from an offset inside one message skips what lies before it', () => withZoom(async (memory, zoom) => {
  add(memory, [['user', 'cat dog cat dog cat']]);
  assert.deepEqual(hitsOf(textOf(await zoom({ id: 0, n: 1, findText: 'cat', offset: 4 }))).map(hit => hit.at), [8, 16]);
  assert.match(textOf(await zoom({ id: 0, n: 1, findText: 'cat', offset: 17 })), /^No match/);
}));

test('the message count of one call is bounded too', () => withZoom(async (memory, zoom) => {
  const count = 2 * FIND.scanMessages;
  // Appending 8,192 messages one by one takes seconds of tree bookkeeping the find never reads, so the originals go in directly.
  for (let i = 0; i < count; i++) memory.root.push({ i, kind: 'user', text: i === 0 ? 'rare word' : 'x', size: 16, date: '2026-01-01T00:00:00.000Z' });
  const first = textOf(await zoom({ id: 0, n: count, findText: 'rare' }));
  assert.match(first, new RegExp(`${FIND.scanMessages.toLocaleString('en-US')} messages searched`));
  assert.deepEqual(callsOf(first).map(({ id, n }) => [id, n]), [[0, FIND.scanMessages]]);
  assert.deepEqual(hitsOf(textOf(await zoom(callsOf(first)[0]))).map(hit => hit.id), [0]);
}));

test('skipped copied results count toward the work ceiling and leave an exact continuation', () => withZoom(async (memory, zoom) => {
  const count = 2 * FIND.scanMessages;
  for (let i = 0; i < count; i++) memory.root.push({ i, kind: i === 0 ? 'user' : 'echo', text: i === 0 ? 'rare original' : 'zoom: copied rare result', size: 32, date: '2026-01-01T00:00:00.000Z' });
  const first = textOf(await zoom({ id: 0, n: count, findText: 'rare' }));
  assert.deepEqual(hitsOf(first), [], 'the older original is outside this call\'s examined-message budget');
  assert.deepEqual(callsOf(first).map(({ id, n }) => [id, n]), [[0, FIND.scanMessages]]);
  assert.deepEqual(hitsOf(textOf(await zoom(callsOf(first)[0]))).map(hit => hit.id), [0]);
}));

test('bounded focus keeps the newest matches when one find returns more than its reference capacity', () => withZoom(async memory => {
  add(memory, Array.from({ length: 8 }, (_, i): [Kind, string] => ['user', `marker decision ${i}`]));
  const focus = new Focus();
  const [tool] = memoryTools(() => memory, undefined, ref => focus.observe(ref));
  await tool.execute('find', { id: 0, n: 8, findText: 'marker' });
  const rendered = focus.render(memory);
  assert.ok(rendered.includes('marker decision 7'), 'newest correction must not be evicted by older hits from the same read');
  assert.ok(!rendered.includes('marker decision 0'));
}));

test('plain zoom is unchanged and reports each successful read once, never a failed one', () => withZoom(async (memory, zoom, reads) => {
  add(memory, [['user', 'a'.repeat(PAGE + 10)], ['user', 'two'], ['user', 'three'], ['user', 'four']]);
  await memory.settle(undefined, 'tree');
  assert.equal(textOf(await zoom({ id: 1, n: 1 })), '1+1|user: two');
  assert.match(textOf(await zoom({ id: 0, n: 1, offset: 5, limit: 3 })), /^0\+1\|user: aaa\n\[showing characters 5-8 of 25010; next page: offset 8\]$/);
  assert.match(textOf(await zoom({ id: '2', n: 2 })), /^2\+1\|/);
  await assert.rejects(() => zoom({ id: 9, n: 1 }), /No line 9\+1/);
  await assert.rejects(() => zoom({ id: 0, n: 2, offset: 0 }), /n = 1/);
  await assert.rejects(() => zoom({ id: 0, n: 1, offset: PAGE * 2 }), /offset must be 0 to 25009/);
  await assert.rejects(() => zoom({}), /zoom takes id and n, or agent/);
  assert.deepEqual(reads, [{ id: 1, n: 1 }, { id: 0, n: 1, offset: 5, limit: 3 }, { id: 2, n: 2 }]);
}));

test('summary zoom with an ignored legacy limit does not fail in focus tracking', () => withZoom(async memory => {
  add(memory, [['user', 'first'], ['user', 'second']]);
  await memory.settle(undefined, 'tree');
  const focus = new Focus();
  const [tool] = memoryTools(() => memory, undefined, ref => focus.observe(ref));
  const reply = await tool.execute('summary', { id: 0, n: 2, limit: 5 });
  assert.equal(textOf(reply), memory.zoom(0, 2, undefined, 5));
  assert.equal(focus.size, 1);
}));

test('a find read reports its excerpts only, and an absent or failed find reports nothing', () => withZoom(async (memory, zoom, reads) => {
  add(memory, Array.from({ length: 8 }, (_, i): [Kind, string] => ['user', i % 2 ? 'x'.repeat(3_000) + ' marker ' + 'y'.repeat(3_000) : 'plain']));
  const text = textOf(await zoom({ id: 0, n: 8, findText: 'marker' }));
  const hits = hitsOf(text);
  assert.deepEqual(hits.map(hit => hit.id), [7, 5, 3, 1]);
  assert.deepEqual(reads.map(read => read.id), [1, 3, 5, 7], 'observers keep newest evidence when their capacity is bounded');
  const shownReads = reads.toReversed();
  for (const [i, read] of shownReads.entries()) {
    assert.equal(read.n, 1);
    assert.ok(read.limit! <= 2 * FIND.context + 'marker'.length + 2, 'an excerpt, not the range');
    assert.ok(memory.root[read.id].text.slice(read.offset, read.offset! + read.limit!).includes('marker'));
    // The follow-up zoom reads at the excerpt, in the original message.
    assert.equal(hits[i].next, `zoom(id: ${read.id}, n: 1, offset: ${read.offset}, limit: ${FIND.nextLimit})`);
    assert.match(textOf(await zoom({ id: read.id, n: 1, offset: read.offset, limit: FIND.nextLimit })), /marker/);
  }
  reads.length = 0;
  await zoom({ id: 0, n: 8, findText: 'absent' });
  await assert.rejects(() => zoom({ id: 0, n: 8, findText: 'marker', limit: 3 }), /limit/);
  assert.deepEqual(reads, []);
}));

test('images stay with the page that names them: finds are text, the suggested zoom brings the image', () => withZoom(async (memory, zoom) => {
  const image = { type: 'image' as const, data: ONE_PIXEL_PNG, mimeType: 'image/png' };
  await saveImages(memory.store, [image]);
  const ref = imageRef(image);
  add(memory, [['user', `Look at the chart ${ref} please`], ['user', 'x'.repeat(PAGE + 100) + ` ${ref} later`]]);
  const byWord = await zoom({ id: 0, n: 2, findText: 'chart' });
  assert.deepEqual(byWord.content.map(part => part.type), ['text'], 'excerpts carry no attachments');
  const byRef = await zoom({ id: 0, n: 2, findText: ref });
  assert.deepEqual(hitsOf(textOf(byRef)).map(hit => hit.id), [1, 0]);
  assert.deepEqual(hitsOf(textOf(byRef)).map(hit => hit.next),
    [`zoom(id: 1, n: 1, offset: ${memory.root[1].text.indexOf(ref) - FIND.context}, limit: ${FIND.nextLimit})`, 'zoom(id: 0, n: 1)']);
  const whole = await zoom({ id: 0, n: 1 });
  assert.deepEqual(whole.content.slice(1), [image]);
  const page = await zoom({ id: 1, n: 1, offset: memory.root[1].text.indexOf(ref) - FIND.context, limit: FIND.nextLimit });
  assert.deepEqual(page.content.slice(1), [image]);
}));
