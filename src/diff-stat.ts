/** Added and removed lines of one change, as `git diff --numstat` counts them. */
export interface LineDelta { added: number; removed: number }

const linesOf = (text: string): string[] => text === '' ? [] : text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

/** Lines added and removed turning `before` into `after`: the lines both texts share at the start and the end are not changes. */
export function lineDelta(before: string, after: string): LineDelta {
  const a = linesOf(before), b = linesOf(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { added: b.length - head - tail, removed: a.length - head - tail };
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The line change a file `edit` or `write` call makes, read from its arguments: an edit sums its `oldText`/`newText`
 * pairs, a write adds every line of its `content` (what it replaces is not in the call). Undefined when the arguments
 * carry neither, so a caller never prints a count it does not know.
 */
export function callDelta(tool: string, input: unknown): LineDelta | undefined {
  if (!record(input)) return undefined;
  if (tool === 'write') return typeof input.content === 'string' ? { added: linesOf(input.content).length, removed: 0 } : undefined;
  if (tool !== 'edit') return undefined;
  const pairs = Array.isArray(input.edits) ? input.edits : [input];
  const total: LineDelta = { added: 0, removed: 0 };
  let seen = false;
  for (const pair of pairs) {
    if (!record(pair) || typeof pair.oldText !== 'string' || typeof pair.newText !== 'string') continue;
    const delta = lineDelta(pair.oldText, pair.newText);
    total.added += delta.added; total.removed += delta.removed; seen = true;
  }
  return seen ? total : undefined;
}

export const deltaText = ({ added, removed }: LineDelta): string => `+${added} -${removed}`;
