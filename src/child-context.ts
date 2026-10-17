const utf8 = (text: string) => Buffer.byteLength(text);
/** Retain whole lines and identifiers, never truncate an instruction or pretend omitted history was read. */
export function focusedChildView(view: string, budget = 16 * 1024) {
  if (utf8(view) <= budget || !view.startsWith('<chat>\n') || !view.endsWith('\n</chat>')) return view;
  const lines = view.slice(7, -8).split('\n');
  const selected: string[] = [], first = lines[0];
  let used = 0;
  if (utf8(first) < budget / 4) { selected.push(first); used += utf8(first) + 1; }
  const tail: string[] = [];
  for (let i = lines.length - 1; i >= selected.length; i--) {
    const size = utf8(lines[i]) + 1;
    if (used + size > budget - 512) break;
    tail.unshift(lines[i]); used += size;
  }
  return `[Focused child history: ${lines.length - selected.length - tail.length} older lines omitted from this snapshot, not discarded. Use zoom(id, n) for omitted history or exact evidence; ask the parent if the task needs a missing decision. Task and installed instructions follow unchanged.]\n<chat>\n${[...selected, ...tail].join('\n')}\n</chat>`;
}
