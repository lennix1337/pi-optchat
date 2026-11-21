





const ID = /\b(?:c_[0-9a-f]{6}|op_[0-9a-f]{8,}|(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{8,40}|[1-9]\d{4,5})\b/g;

/** The ids in `line` that none of `sources` contains (a prefix of a longer hash in a source counts as contained). */
export function foreignIds(line: string, sources: readonly string[]): string[] {
  const seen = sources.join('\n');
  return [...new Set(line.match(ID) ?? [])].filter(id => !seen.includes(id));
}

/** The correction sent after a line that carries ids from outside its message. */
export const carriedFeedback = (ids: readonly string[]) => `Your line names ${ids.join(', ')}, which <input> does not mention: \
they come from other lines of <chat>. A line for one message says only what that message did or showed; open items elsewhere \
stay in their own lines. Write the whole line again for the same <input> without them, and keep everything else.`;


const items = (line: string) => line.split(/(?<=[;.])\s+/);

/** Drops the parentheses, then the items, that satisfy `hits`. Never returns an empty line. */
export function dropWhere(line: string, hits: (text: string) => boolean) {
  const kept = items(line).flatMap(item => {
    if (!hits(item)) return [item];
    let lean = item;
    for (const group of item.match(/\s*\([^()]*\)/g) ?? []) if (hits(group) || !hits(lean.replace(group, ''))) lean = lean.replace(group, '');
    return hits(lean) ? [] : [lean];
  });
  return (kept.join(' ').trim() || line).replace(/\s{2,}/g, ' ');
}

/** Last resort when the model keeps copying them: the line without the items that name `ids`. The whole item goes, not just
 * its parenthesis: "Home cause (103394) UNVERIFIED" minus the id is still an echo of another line. Never returns an empty line. */
export function dropCarried(line: string, ids: readonly string[]) {
  if (!ids.length) return line;
  const names = (text: string) => ids.some(id => new RegExp(`\\b${id}\\b`).test(text));
  return (items(line).filter(item => !names(item)).join(' ').trim() || line).replace(/\s{2,}/g, ' ');
}
