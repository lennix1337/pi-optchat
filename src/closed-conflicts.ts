import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dropWhere } from './carried-ids.ts';
import { readOperationalState } from './operational-state.ts';

/** A conflict the operator already closed, which a memory line must stop citing. The compactor copies what the lines it merges
 * say, so one stale "UNRESOLVED" spreads to every line after it; an instruction alone did not stop that (31/10: 95 of 146 view
 * lines still cited the "no Git" rule the operator replaced at 87165). The compactor refuses such a line and asks again. */
export interface ClosedConflict { id: string; say: string; cites: (segment: string) => boolean }


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
    // external: JSON parses \b as backspace, not a regex word boundary.
    for (const pattern of [record.match, record.with ?? '']) if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(pattern)) {
      throw new Error(`${CLOSED_FILE} entry ${record.id} has a control character in a pattern: write \\\\b, \\\\d in JSON for \\b, \\d.`);
    }
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




const CREDITED = /\b(?:user|operator|operador)\s+(\d{5,6})\b/gi;
const NOT_HIS = new Set(['tool', 'echo', 'talk', 'work']);
export function misattributed(kindOf: (i: number) => string | undefined): ClosedConflict {
  let wrong: string[] = [];
  return {
    id: 'misattributed-user',
    get say() { return `${wrong.join(', ')} ${wrong.length === 1 ? 'is' : 'are'} not the user's message (${wrong.map(id => kindOf(Number(id))).join(', ')}): never credit it to the user or operator; say what it is, or drop the claim.`; },
    cites: segment => {
      const found = [...segment.matchAll(CREDITED)].map(match => match[1]).filter(id => NOT_HIS.has(kindOf(Number(id)) ?? ''));
      if (found.length) wrong = [...new Set(found)];
      return found.length > 0;
    },
  };
}


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
export const dropClosed = (line: string, list: readonly ClosedConflict[]) => dropWhere(line, text => cited(text, list).length > 0);
