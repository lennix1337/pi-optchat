import { Type, type Static } from 'typebox';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { flat, PAGE, start, type Memory } from './memory.ts';
import { loadImages } from './images.ts';
import { runTranscript } from './transcript.ts';
import { findInRange, FIND, type MemoryRead } from './zoom-navigation.ts';
export type { MemoryRead };
export const result = (text: string) => ({ content: [{ type: 'text' as const, text }], details: {} });
export const SEARCH_PAGE = 20;
const SNIPPET = 200;

/** One page of hits, each with its id, the view line holding it, its date and a snippet around the first match; at most ~5 KB. */
export function searchPage(memory: Memory, text: string, before?: number) {
  const hits = memory.search(text, before), older = before === undefined ? '' : 'older ';
  if (!hits.length) return `No ${older}messages contain "${text}".`;
  const page = hits.slice(0, SEARCH_PAGE), needle = text.toLowerCase();
  const lines = page.map(entry => {
    // Cut the original text, whose match may span lines, and flatten only the cut.
    const at = Math.max(0, entry.text.toLowerCase().indexOf(needle) - SNIPPET / 4);
    const snippet = flat(entry.text.slice(at, at + SNIPPET).replace(/^[\udc00-\udfff]|[\ud800-\udbff]$/g, ''));
    // The live view, which may have folded since the turn's snapshot: its lines are built, so zoom always opens them.
    const line = memory.covering(entry.i); // Named only when the hit is inside a summary line.
    return `${entry.i}${line?.l ? ` (in ${start(line)}+${2 ** line.l})` : ''} · ${new Date(entry.date).toString().slice(0, 21)} · ${entry.kind}: ${at ? '…' : ''}${snippet}${at + SNIPPET < entry.text.length ? '…' : ''}`;
  });
  const more = hits.length > page.length ? `\nOlder matches: search again with before: ${page[page.length - 1].i}.` : '';
  return `${hits.length} ${older}${hits.length === 1 ? 'message contains' : 'messages contain'} "${text}", newest first:\n${lines.join('\n')}${more}`;
}

const zoomParameters = Type.Object({ id: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.String({ minLength: 1 })])),
  agent: Type.Optional(Type.String({ minLength: 1 })), n: Type.Optional(Type.Integer({ minimum: 1 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: PAGE })),
  findText: Type.Optional(Type.String({ minLength: 1, maxLength: FIND.maxText })) }, { additionalProperties: false });

/** A page of a run's transcript, saying where the next one starts. */
export function runPage(text: string, offset = 0, limit = PAGE) {
  if (offset > text.length) throw new Error(`This transcript has ${text.length} characters; offset must be 0 to ${text.length}.`);
  // Never split a surrogate pair: a page starts on its first half and ends after its second.
  const from = /[\udc00-\udfff]/.test(text[offset] ?? '') ? offset - 1 : offset;
  let to = Math.min(text.length, from + limit);
  if (to < text.length && /[\ud800-\udbff]/.test(text[to - 1])) to += to - 1 === from ? 1 : -1;
  return `${text.slice(from, to)}\n[characters ${from}-${to} of ${text.length}${to < text.length ? `; go on with offset ${to}` : ''}]`;
}

type ZoomArguments = Static<typeof zoomParameters>;
const FIND_AGENT = 'findText searches memory messages, not an agent transcript: drop findText, or use id instead of agent.';

/** A read of message or summary line id: a findText lookup (text excerpts only; the follow-up zoom on a hit returns the images its page names), or the page zoom opens. */
async function readMemory(m: Memory, id: number, { n = 1, offset, limit, findText }: ZoomArguments, onRead?: (read: MemoryRead) => void) {
  if (findText !== undefined) {
    const found = findInRange(m, { id, n, findText, offset, limit });
    // Touch older hits first so a bounded consumer retains the newest evidence from this batch.
    for (const read of found.reads.toReversed()) onRead?.(read);
    return result(found.text);
  }
  const text = m.zoom(id, n, offset, limit), page = result(text);
  const read = { id, n, ...n !== 1 || offset === undefined ? {} : { offset }, ...n !== 1 || limit === undefined ? {} : { limit } };
  // A message's images come back with its text, as read returns a PNG; summaries stay text.
  const images = n === 1 ? await loadImages(m.store, text) : [];
  onRead?.(read);
  return { ...page, content: [...page.content, ...images] };
}

/** `runs` gives a subagent's messages by run id, live or finished; undefined for no such run.
 * `onRead` hears each successful memory read, never a failed one nor an agent transcript; a findText read reports its excerpts, not the whole range. */
export function memoryTools(memory: () => Memory, runs?: (id: string) => readonly AgentMessage[] | undefined, onRead?: (read: MemoryRead) => void) {
  return [
    { name: 'zoom', label: 'Zoom memory', description: `Open id+n into halves; n=1: original with images. agent:"id" or string id: subagent chat. offset/limit page characters (max ${PAGE}). findText: case-insensitive literal in id..id+n-1 only, newest first; bounded excerpts and exact follow-ups for hits/unsearched regions. n=1 offset starts search; no limit/agent. Prefer direct zoom for a single read, dependent tree navigation, or images. Code Mode is optional for independent text-only reads: await calls, emit every result with its id; Promise.allSettled retains partial successes. Bound output without unnecessary paging. Pi 1.1.0 drops zoom's image attachments in Code Mode.`,
      parameters: zoomParameters,
      async execute(_id: string, args: ZoomArguments) {
        const { id, agent, offset, limit, findText } = args;
        if (agent !== undefined && id !== undefined) throw new Error('Use either id or agent, not both.');
        const run = agent ?? (typeof id === 'string' ? id : undefined), messages = run === undefined ? undefined : runs?.(run);
        if (findText !== undefined && (agent !== undefined || messages)) throw new Error(FIND_AGENT);
        if (messages) return result(runPage(runTranscript(messages), offset, limit));
        if (agent !== undefined) throw new Error(`No run ${agent}.`);
        if (id === undefined) throw new Error('zoom takes id and n, or agent.');
        // A model may quote a message id; eight digits can be a run id, so those never open a message.
        if (typeof id === 'string' && (!/^\d+$/.test(id) || id.length === 8)) throw new Error(`No run ${id}.`);
        return readMemory(memory(), Number(id), args, onRead);
      } },
    { name: 'date', label: 'Memory date', description: 'The date and time of message id.',
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
      async execute(_id: string, args: { id: number }) { return result(memory().date(args.id)); } },
  ] as const;
}

export const searchTool = (memory: () => Memory) => ({ name: 'search', label: 'Search memory',
  description: `Find the original messages that contain text (plain text, any case), newest first, ${SEARCH_PAGE} at a time; before: id continues with older ones. zoom(id, 1) gives a hit whole.`,
  parameters: Type.Object({ text: Type.String({ minLength: 1 }), before: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
  async execute(_id: string, args: { text: string; before?: number }) { return result(searchPage(memory(), args.text, args.before)); } });
