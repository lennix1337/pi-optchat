const utf8 = (text: string) => Buffer.byteLength(text);
const span = (line: string) => Number(/^\d+\+(\d+)\|/.exec(line)?.[1] ?? 1);
/** Lines covering at least this many messages are the old, broad summaries a child needs to place its task in the chat. */
const COARSE_SPAN = 512;
/** Share of the budget the broad summaries may take; the newest lines fill the rest. */
const COARSE_SHARE = 0.6;
/** Retain whole lines and identifiers, never truncate an instruction or pretend omitted history was read.
 *  Keeps the oldest broad summaries (which name the standing rules and settled facts), then the newest lines;
 *  the middle-aged, finer lines are left out. Measured offline on this chat: a newest-only 16 KB view kept 0/5
 *  task facts and 6/10 rules, this one at 24 KB kept 5/5 and 10/10. */
export function focusedChildView(view: string, budget = 24 * 1024) {
  if (utf8(view) <= budget || !view.startsWith('<chat>\n') || !view.endsWith('\n</chat>')) return view;
  const lines = view.slice(7, -8).split('\n');
  const keep = new Set<number>();
  let used = 0;
  const take = (i: number, limit: number) => {
    const size = utf8(lines[i]) + 1;
    if (keep.has(i) || used + size > limit) return false;
    keep.add(i); used += size; return true;
  };
  if (utf8(lines[0]) < budget / 4) take(0, budget);
  for (let i = 1; i < lines.length; i++) if (span(lines[i]) >= COARSE_SPAN) take(i, budget * COARSE_SHARE);
  for (let i = lines.length - 1; i > 0; i--) if (!keep.has(i) && !take(i, budget - 512)) break;
  const selected = [...keep].sort((a, b) => a - b).map(i => lines[i]);
  return `[Focused child history: ${lines.length - selected.length} older lines omitted from this snapshot, not discarded. Use zoom(id, n) for omitted history or exact evidence; ask the parent if the task needs a missing decision. Task and installed instructions follow unchanged.]\n<chat>\n${selected.join('\n')}\n</chat>`;
}
