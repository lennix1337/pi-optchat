import { flat, noLine, type Memory } from './memory.ts';

/** One successful read of memory, as the arguments that reopen what the caller saw. */
export interface MemoryRead { id: number; n: number; offset?: number; limit?: number }

/** The bounds of one zoom `findText` call, so its work and its output stay small whatever the range. */
export const FIND = {
  maxText: 200,         // longest findText
  scanChars: 1_000_000, // original characters searched per call
  scanMessages: 4_096,  // messages examined per call
  excerpts: 8,          // matches shown per call
  context: 120,         // characters around a match
  nextLimit: 2_000,     // limit of the suggested follow-up zoom
} as const;

const HIGH = /[\ud800-\udbff]/, LOW = /[\udc00-\udfff]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const quote = (text: string) => JSON.stringify(text);

interface Folded { text: string; start(index: number): number; end(index: number): number }

/** Lowercases text and maps folded indexes back to original ones. Normalize capital sigma first to avoid contextual final
 * sigma; only length-changing folds (U+0130) need the code-point map. Existing lowercase final sigma stays distinct. */
function fold(text: string): Folded {
  const lower = (text.includes('\u03a3') ? text.replaceAll('\u03a3', '\u03c3') : text).toLowerCase();
  if (lower.length === text.length) return { text: lower, start: index => index, end: index => index };
  let folded = '';
  const origin: number[] = [];
  for (let at = 0; at < text.length;) {
    const point = String.fromCodePoint(text.codePointAt(at)!), low = point.toLowerCase();
    for (let unit = 0; unit < low.length; unit++) origin.push(at);
    folded += low; at += point.length;
  }
  return {
    text: folded,
    start: index => origin[index] ?? text.length,
    // A folded index inside one character's expansion ends after that character.
    end: index => { while (index < origin.length && origin[index] === origin[index - 1]) index++; return origin[index] ?? text.length; },
  };
}

/** The aligned blocks id+n (n a power of two, as zoom requires) that tile messages from..to-1, newest first. */
function blocks(from: number, to: number) {
  const tiles: { id: number; n: number }[] = [];
  for (let at = from; at < to;) {
    let n = 1;
    while (at % (n * 2) === 0 && at + n * 2 <= to) n *= 2;
    tiles.push({ id: at, n }); at += n;
  }
  return tiles.reverse();
}

/** Logged zoom/search results only copy memory, so a range search skips them as Memory.search does. */
const COPY_KINDS = new Set<string>(['tool', 'echo']);
const isCopy = ({ kind, text }: { kind: string; text: string }) => COPY_KINDS.has(kind) && /^(zoom|search)[ :]/.test(text);

/** The arguments of one findText lookup, as zoom received them. */
export interface FindArgs { id: number; n: number; findText: string; offset?: number; limit?: number }
interface Hit { id: number; start: number; from: number; to: number }
interface Scan { hits: Hit[]; searched: number; examined: number; skipped: number; more: boolean; resume?: { id: number; offset: number }; older: number }

/** Admission shared with Memory.zoom, which stays the authority for a plain read: only an aligned, existing range. */
function checkRange(memory: Memory, id: number, n: number) {
  if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(n) || n < 1 || !Number.isInteger(Math.log2(n)) || id % n || id + n > memory.root.length)
    throw noLine(id, n, memory.root.length);
}

function checkFind(memory: Memory, { id, n, findText, offset, limit }: FindArgs) {
  if (typeof findText !== 'string' || !findText.length || findText.length > FIND.maxText || LONE_SURROGATE.test(findText))
    throw new Error(`findText must be 1 to ${FIND.maxText} characters of well-formed text.`);
  if (limit !== undefined) throw new Error('findText does not take limit: it returns bounded excerpts.');
  checkRange(memory, id, n);
  if (offset === undefined) return;
  if (n !== 1) throw new Error('With findText, offset (where the search starts) needs n = 1.');
  const { length } = memory.root[id].text;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= Math.max(1, length))
    throw new Error(`Message ${id} has ${length} characters; offset must be 0 to ${Math.max(0, length - 1)}.`);
}

/** Up to `max` non-overlapping matches of the folded needle in text[begin, end), as original [start, end) spans. */
function spans(text: string, begin: number, end: number, needle: string, max: number) {
  const folded = fold(text.slice(begin, end)), found: [number, number][] = [];
  for (let at = folded.text.indexOf(needle); at >= 0 && found.length < max; at = folded.text.indexOf(needle, at + needle.length))
    found.push([begin + folded.start(at), begin + folded.end(at + needle.length)]);
  return found;
}

/** The excerpt around a match: FIND.context characters each side, never cutting a surrogate pair. */
function hitAt(text: string, id: number, start: number, stop: number): Hit {
  const from = Math.max(0, start - FIND.context), to = Math.min(text.length, stop + FIND.context);
  return { id, start, from: from > 0 && LOW.test(text[from]) ? from - 1 : from, to: to < text.length && HIGH.test(text[to - 1]) ? to + 1 : to };
}

/** Where a search cut at `end` resumes: where a match could still start, and never before what was already shown. */
function resumeAfterCut(text: string, begin: number, end: number, shownEnd: number, needleLength: number) {
  const resume = Math.max(shownEnd, end - needleLength + 1);
  return Math.max(begin, resume > begin && LOW.test(text[resume]) ? resume - 1 : resume);
}

/** Searches message i into `scan`; false once the call's bounds or its excerpt limit end the search there. */
function scanMessage(scan: Scan, text: string, i: number, needle: string, begin: number) {
  const room = FIND.scanChars - scan.searched;
  // Only the first message examined is searched in part; a later one that does not fit is left whole for its own call.
  if (scan.examined === FIND.scanMessages || text.length - begin > room && scan.searched > 0) { scan.older = i + 1; return false; }
  const end = Math.min(text.length, begin + room), found = spans(text, begin, end, needle, FIND.excerpts - scan.hits.length + 1);
  scan.searched += end - begin; scan.examined++;
  for (const [start, stop] of found) {
    if (scan.hits.length === FIND.excerpts) { scan.more = true; scan.resume = { id: i, offset: start }; scan.older = i; return false; }
    scan.hits.push(hitAt(text, i, start, stop));
  }
  if (end === text.length) return true;
  scan.resume = { id: i, offset: resumeAfterCut(text, begin, end, found.at(-1)?.[1] ?? begin, needle.length) }; scan.older = i;
  return false;
}

function scanRange(memory: Memory, { id, n, findText, offset }: FindArgs): Scan {
  const scan: Scan = { hits: [], searched: 0, examined: 0, skipped: 0, more: false, older: id }, needle = fold(findText).text;
  for (let i = id + n - 1; i >= id; i--) {
    if (scan.examined + scan.skipped === FIND.scanMessages) { scan.older = i + 1; break; }
    const entry = memory.root[i];
    if (n > 1 && isCopy(entry)) scan.skipped++;
    else if (!scanMessage(scan, entry.text, i, needle, n === 1 ? offset ?? 0 : 0)) break;
  }
  return scan;
}

function renderHit(memory: Memory, hit: Hit) {
  const { text, kind, date } = memory.root[hit.id];
  const next = text.length <= FIND.nextLimit ? `zoom(id: ${hit.id}, n: 1)` : `zoom(id: ${hit.id}, n: 1, offset: ${hit.from}, limit: ${FIND.nextLimit})`;
  return `${hit.id} · ${date} · ${kind} · character ${hit.start} of ${text.length} · ${next}\n  ${hit.from ? '…' : ''}${flat(text.slice(hit.from, hit.to))}${hit.to < text.length ? '…' : ''}`;
}

/** The exact calls that search what this one did not: the rest of the message it stopped in, then the aligned blocks of older messages. */
function renderNotSearched({ resume, older, more }: Scan, { id, findText }: FindArgs) {
  const calls = [...resume ? [`zoom(id: ${resume.id}, n: 1, findText: ${quote(findText)}, offset: ${resume.offset})`] : [],
    ...blocks(id, older).map(block => `zoom(id: ${block.id}, n: ${block.n}, findText: ${quote(findText)})`)];
  return calls.length ? `\nNot searched${more ? ' yet' : ''}; narrow with:\n${calls.join('\n')}` : '';
}

function render(memory: Memory, scan: Scan, args: FindArgs) {
  const { id, n, findText, offset } = args, { hits, more } = scan, count = (value: number) => value.toLocaleString('en-US');
  const coverage = `${count(scan.searched)} characters of ${count(scan.examined)} messages searched${scan.skipped ? `, ${scan.skipped} logged zoom/search copies skipped` : ''}`;
  const where = n === 1 ? `message ${id}${offset ? ` from character ${offset}` : ''}` : `${id}+${n} (messages ${id}-${id + n - 1})`;
  const head = hits.length
    ? `${hits.length}${more ? '+' : ''} ${hits.length === 1 && !more ? 'match' : 'matches'} of "${findText}" in ${where}, newest message first (${coverage}).${more ? ` Only the first ${FIND.excerpts} are shown.` : ''}`
    : `No match of "${findText}" (any case, literal) in the part of ${where} that was searched (${coverage}).`;
  return [head, ...hits.map(hit => renderHit(memory, hit))].join('\n') + renderNotSearched(scan, args);
}

/**
 * Literal, case-insensitive lookup of `findText` in the original messages id..id+n-1 only, newest first, with at most
 * FIND.excerpts source-located excerpts, each with the exact zoom that reads around it. Work is bounded by FIND.scanChars
 * and FIND.scanMessages; whatever was not searched is named with the exact calls that search it, never counted as no match.
 * With n = 1, `offset` starts the search inside that message. `reads` are the excerpts, for callers that track what was read.
 */
export function findInRange(memory: Memory, args: FindArgs): { text: string; reads: MemoryRead[] } {
  checkFind(memory, args);
  const scan = scanRange(memory, args);
  return { text: render(memory, scan, args), reads: scan.hits.map(hit => ({ id: hit.id, n: 1, offset: hit.from, limit: hit.to - hit.from })) };
}
