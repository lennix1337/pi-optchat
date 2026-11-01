import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readOperationalState } from './operational-state.ts';

/** A conflict the operator already closed, which a memory line must stop citing. The compactor copies what the lines it merges
 * say, so one stale "UNRESOLVED" spreads to every line after it; an instruction alone did not stop that (31/10: 95 of 146 view
 * lines still cited the "no Git" rule the operator replaced at 87165). The compactor refuses such a line and asks again. */
export interface ClosedConflict { id: string; say: string; cites: (segment: string) => boolean }

/** `closed-conflicts.json` in the profile: `match` (and `with`, when given) are case-insensitive regexes a segment must both hit. */
interface ClosedRecord { id: string; match: string; with?: string; say: string }
export const CLOSED_FILE = 'closed-conflicts.json';

function isRecord(value: unknown): value is ClosedRecord {
  const v = value as Partial<ClosedRecord> | null;
  return typeof v === 'object' && v !== null && typeof v.id === 'string' && typeof v.match === 'string' && typeof v.say === 'string'
    && (v.with === undefined || typeof v.with === 'string');
}

export function fromRecords(records: unknown): ClosedConflict[] {
  if (!Array.isArray(records) || !records.every(isRecord)) throw new Error(`${CLOSED_FILE} must be a list of {id, match, with?, say}.`);
  return records.map(record => {
    const match = new RegExp(record.match, 'i'), also = record.with === undefined ? undefined : new RegExp(record.with, 'i');
    return { id: record.id, say: record.say, cites: segment => match.test(segment) && (!also || also.test(segment)) };
  });
}

const OPEN_WORDS = /UNRESOLVED|disputed|\bvs\.?\s|conflict/i;
/** A superseded operational record, cited as still open (its source id next to "UNRESOLVED", "vs", "disputed"). */
export function fromOperationalState(file: string): ClosedConflict[] {
  if (!existsSync(file)) return [];
  const { entries } = readOperationalState(file);
  return entries.flatMap(next => {
    const old = next.supersedes ? entries.find(entry => entry.id === next.supersedes) : undefined;
    if (!old || old.sourceMessageId === next.sourceMessageId) return [];
    const id = new RegExp(`\\b${old.sourceMessageId.replace(/[^\w]/g, '')}\\b`);
    return [{ id: old.id, say: `${old.sourceMessageId} was replaced by ${next.sourceMessageId}: ${next.text.slice(0, 200)}`,
      cites: (segment: string) => id.test(segment) && OPEN_WORDS.test(segment) }];
  });
}

/** The profile's closed conflicts, reread only when one of its two files changes. */
export function closedConflictsOf(dir: string, warn: (text: string) => void = () => {}) {
  const files = [join(dir, CLOSED_FILE), join(dir, 'operational-state.json')];
  let stamp = '', list: ClosedConflict[] = [];
  return (): readonly ClosedConflict[] => {
    const now = files.map(file => existsSync(file) ? `${statSync(file).mtimeMs}` : '-').join('|');
    if (now === stamp) return list;
    stamp = now;
    try { list = [...existsSync(files[0]) ? fromRecords(JSON.parse(readFileSync(files[0], 'utf8'))) : [], ...fromOperationalState(files[1])]; }
    catch (error) { list = []; warn(`Closed conflicts ignored: ${error instanceof Error ? error.message : String(error)}`); }
    return list;
  };
}

// Lines separate items with ";" and sentences; a parenthesis often carries the stale remark on its own.
const items = (line: string) => line.split(/(?<=[;.])\s+/);
export function cited(line: string, list: readonly ClosedConflict[]): ClosedConflict[] {
  const parts = [...items(line), ...line.match(/\([^()]*\)/g) ?? []];
  return list.filter(conflict => parts.some(part => conflict.cites(part)));
}

/** The correction the compactor sends after a line that cites a closed conflict. */
export const closedFeedback = (hits: readonly ClosedConflict[]) => `Your line cites ${hits.length === 1 ? 'a conflict' : 'conflicts'} the user already closed:
${hits.map(hit => `- ${hit.say}`).join('\n')}
Write the whole line again for the same <input> without mentioning ${hits.length === 1 ? 'it' : 'them'}, and keep everything else.`;

/** Rewrites the shown lines that cite a closed conflict, once per list of conflicts (`closed-conflicts.done` keeps the ids done). */
export async function cleanClosedOnce(dir: string, memory: { revise(stale: (text: string) => string | undefined): Promise<number> }, list: readonly ClosedConflict[]) {
  const version = list.map(conflict => conflict.id).sort().join(','), marker = join(dir, 'closed-conflicts.done');
  if (!list.length || existsSync(marker) && readFileSync(marker, 'utf8') === version) return 0;
  const changed = await memory.revise(text => { const hits = cited(text, list); return hits.length ? hits.map(hit => `- ${hit.say}`).join('\n') : undefined; });
  writeFileSync(marker, version);
  return changed;
}

/** Last resort when the model keeps citing it: drop the parentheses, then the items, that do. Never returns an empty line. */
export function dropClosed(line: string, list: readonly ClosedConflict[]) {
  const hits = (text: string) => cited(text, list).length > 0;
  const kept = items(line).flatMap(item => {
    if (!hits(item)) return [item];
    // A parenthesis that alone, or in its item, carries the citation goes; the item stays if that was all.
    let lean = item;
    for (const group of item.match(/\s*\([^()]*\)/g) ?? []) if (hits(group) || !hits(lean.replace(group, ''))) lean = lean.replace(group, '');
    return hits(lean) ? [] : [lean];
  });
  return (kept.join(' ').trim() || line).replace(/\s{2,}/g, ' ');
}
