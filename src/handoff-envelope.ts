/**
 * The bounded handoff between agents: an ID, a short summary and pointers to the full sources (a run, a memory page,
 * a file). It never carries a transcript: its input has no message list, and its output never exceeds the byte cap.
 */

/** The most bytes one handoff may carry, in UTF-8. */
export const HANDOFF_MAX_BYTES = 8192;
const POINTER_LIMIT = 12;
const POINTER_BYTES = 200;
const ID_BYTES = 200;
const NAME_BYTES = 100;

export interface HandoffPointer { kind: 'run' | 'memory' | 'file' | 'shell' | 'output'; ref: string }
export interface HandoffInput { id: string; from: string; to: string; summary: string; pointers?: HandoffPointer[] }
export interface HandoffEnvelope { text: string; bytes: number; truncated: boolean }

/** Text that would not fit the handoff cap, refused rather than cut silently. */
export class HandoffTooLarge extends Error {}

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

/** The longest prefix of `text` within `limit` UTF-8 bytes, cut on a character boundary. */
export function clipBytes(text: string, limit: number): string {
  let out = '', used = 0;
  for (const character of text) {
    const size = byteLength(character);
    if (used + size > limit) break;
    out += character; used += size;
  }
  return out;
}

/** The instruction for one dispatch (a task, guidance): refused with its size when over the cap, never cut. */
export function checkHandoffSummary(text: string, maxBytes = HANDOFF_MAX_BYTES, label = 'Handoff'): string {
  const size = byteLength(text);
  if (size > maxBytes) throw new HandoffTooLarge(`${label} is ${size} bytes; the handoff limit is ${maxBytes}. Put the details in a file or memory page and pass its path or ID.`);
  return text;
}

const cutNote = (kept: number, total: number) => `\n[summary cut: ${kept} of ${total} bytes kept; the pointers name the full sources]`;

/**
 * The envelope for `input` within `maxBytes`. A summary that does not fit is cut, and the envelope says so; the pointers
 * (capped in number and length) keep the way to the rest. Throws only when the frame alone exceeds the cap.
 */
export function handoffEnvelope(input: HandoffInput, maxBytes = HANDOFF_MAX_BYTES): HandoffEnvelope {
  const pointers = input.pointers ?? [];
  const lines = pointers.slice(0, POINTER_LIMIT).map(pointer => `- ${pointer.kind}: ${clipBytes(pointer.ref, POINTER_BYTES)}`);
  if (pointers.length > POINTER_LIMIT) lines.push(`- ${pointers.length - POINTER_LIMIT} more not listed`);
  const header = `[handoff ${clipBytes(input.id, ID_BYTES)}] ${clipBytes(input.from, NAME_BYTES)} -> ${clipBytes(input.to, NAME_BYTES)}`;
  const frame = (summary: string, note: string) => [header, `summary:\n${summary}${note}`, 'pointers:', ...lines].join('\n');
  const whole = frame(input.summary, '');
  if (byteLength(whole) <= maxBytes) return { text: whole, bytes: byteLength(whole), truncated: false };
  const total = byteLength(input.summary);
  // The note's digits never grow past the total's, so the frame sized with the total's note always fits.
  const room = maxBytes - byteLength(frame('', cutNote(total, total)));
  if (room < 0) throw new HandoffTooLarge(`Handoff frame alone is ${byteLength(frame('', cutNote(total, total)))} bytes; the limit is ${maxBytes}.`);
  const kept = clipBytes(input.summary, room);
  const text = frame(kept, cutNote(byteLength(kept), total));
  return { text, bytes: byteLength(text), truncated: true };
}
