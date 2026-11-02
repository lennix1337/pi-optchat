import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HANDOFF_MAX_BYTES, HandoffTooLarge, checkHandoffSummary, clipBytes, handoffEnvelope } from '../src/handoff-envelope.ts';

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

test('an envelope exactly at the cap is whole; one byte more is cut to fit, with a note', () => {
  const frame = (summary: string, note = '') => `[handoff h1] a -> b\nsummary:\n${summary}${note}\npointers:\n- run: h1`;
  const base = bytes(frame(''));
  const whole = handoffEnvelope({ id: 'h1', from: 'a', to: 'b', summary: 'x'.repeat(100), pointers: [{ kind: 'run', ref: 'h1' }] }, base + 100);
  assert.equal(whole.truncated, false);
  assert.equal(whole.bytes, base + 100);
  const over = handoffEnvelope({ id: 'h1', from: 'a', to: 'b', summary: 'x'.repeat(101), pointers: [{ kind: 'run', ref: 'h1' }] }, base + 100);
  assert.equal(over.truncated, true);
  assert.ok(over.bytes <= base + 100, `cut envelope is ${over.bytes} bytes, over the cap`);
  assert.match(over.text, /summary cut: \d+ of 101 bytes kept; the pointers name the full sources/);
  assert.match(over.text, /- run: h1/, 'the pointer that leads to the full source survives the cut');
});

test('whatever the summary holds, the envelope never exceeds the cap and keeps characters whole', () => {
  const pieces = ['a', 'é', '€', '😀', '\n', ' ', 'x'.repeat(7)];
  let seed = 7;
  const random = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 300; round++) {
    const summary = Array.from({ length: random(400) }, () => pieces[random(pieces.length)]).join('');
    // Large enough for the frame: at most 12 pointers of 200 bytes plus the header and the notes.
    const cap = 3000 + random(2000);
    const envelope = handoffEnvelope({ id: 'run-1', from: 'worker', to: 'router', summary,
      pointers: Array.from({ length: random(16) }, (_, index) => ({ kind: 'file' as const, ref: `C:/${index}/${'p'.repeat(random(300))}` })) }, cap);
    assert.ok(envelope.bytes <= cap, `${envelope.bytes} bytes over the ${cap} cap`);
    assert.equal(envelope.bytes, bytes(envelope.text));
    assert.ok(!envelope.text.includes('\uFFFD'), 'a cut never splits a character');
  }
});

test('pointers are capped in number and length, and the omitted ones are counted', () => {
  const pointers = Array.from({ length: 30 }, (_, index) => ({ kind: 'memory' as const, ref: `page-${index}-${'q'.repeat(500)}` }));
  const envelope = handoffEnvelope({ id: 'x', from: 'a', to: 'b', summary: 'ok', pointers });
  assert.equal(envelope.truncated, false);
  assert.equal(envelope.text.split('\n').filter(line => line.startsWith('- memory:')).length, 12);
  assert.match(envelope.text, /- 18 more not listed/);
  for (const line of envelope.text.split('\n').filter(line => line.startsWith('- memory:'))) assert.ok(bytes(line) <= 200 + 'memory: '.length + 2, 'a pointer is clipped to 200 bytes');
});

test('the envelope is the handoff: an ID, the parties and a summary, never the messages behind it', () => {
  const envelope = handoffEnvelope({ id: 'run-9', from: 'worker run-9', to: 'router', summary: 'Tests pass: 12/12.', pointers: [{ kind: 'run', ref: 'run-9' }, { kind: 'file', ref: 'C:/s/run-9.jsonl' }] });
  assert.equal(envelope.text, '[handoff run-9] worker run-9 -> router\nsummary:\nTests pass: 12/12.\npointers:\n- run: run-9\n- file: C:/s/run-9.jsonl');
});

test('a dispatch over the cap is refused with its size, and one at the cap is accepted unchanged', () => {
  const atCap = 'y'.repeat(HANDOFF_MAX_BYTES);
  assert.equal(checkHandoffSummary(atCap), atCap);
  assert.throws(() => checkHandoffSummary(`${atCap}z`, HANDOFF_MAX_BYTES, 'Task'), (error: unknown) => error instanceof HandoffTooLarge
    && /Task is 8193 bytes; the handoff limit is 8192/.test(String(error)));
  assert.throws(() => checkHandoffSummary('é'.repeat(4097), 8192), HandoffTooLarge, '4097 two-byte characters are 8194 bytes');
});

test('a frame that cannot fit the cap at all is refused, not returned oversized', () => {
  assert.throws(() => handoffEnvelope({ id: 'i', from: 'a', to: 'b', summary: 'x', pointers: [{ kind: 'run', ref: 'r' }] }, 20), HandoffTooLarge);
});

test('clipBytes keeps whole characters within the byte limit', () => {
  assert.equal(clipBytes('ab€d', 4), 'ab');
  assert.equal(clipBytes('ab€d', 5), 'ab€');
  assert.equal(clipBytes('😀😀', 5), '😀');
  assert.equal(clipBytes('short', 100), 'short');
});
