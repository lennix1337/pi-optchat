




/**
 * A reply shaped like a memory line: `104704-112 OptChat ...`, `id+n|`, `user: ...; echo: ...`, or the date-and-id-range head the
 * compactor gives merged lines (`15/11 164384-387 OptChat: ...`, 15/11 17:12 wake: the model completed the view's last lines instead
 * of answering), or a line carrying the compactor's own wrapper or its "machine notice, not user words" wording.
 */
export function memoryShapedReply(reply: string): boolean {
  const text = reply.trim();
  return /^\d{3,}(?:[-+]\d+)?[|\s]/.test(text)
    || /^(?:user|talk|tool|echo|work|note):\s/.test(text)
    || /^(?:<compaction-line>\s*)?\d{1,2}\/\d{1,2}\s+(?:~?\d{1,2}:\d{2}\s+)?(?:·\s+)?\d{3,}(?:[-+]\d*)?\b/u.test(text)
    || /^\d{1,2}\/\d{1,2}\s+(?:\d{1,2}:\d{2}\s+)?[A-Za-z][\w.-]*\s+\d{3,}-\d+\b/.test(text)
    || /^<compaction-line>/.test(text)
    || /^\d{1,2}\/\d{1,2}\s+(?:\d{1,2}:\d{2}\s+)?(?:OptChat\b|wake\b|heartbeat\b)/.test(text)
    || /\(machine,?\s+(?:notices?,?\s+)?not (?:the )?operator(?:'s)?(?: words)?\)|\(not operator words\)/i.test(text)
    || /\(machine notices?,? not (?:the )?user(?:'s)? words\b/i.test(text);
}

/** A commitment id (`c_022f4e`) restated together with the fact that it waits on the operator: the wake asks him again what he already knows. */
export function reasksPending(text: string): boolean {
  return /\bc_[0-9a-f]{6}\b[^\n]{0,160}\b(?:waiting_operator|awaits?\s+(?:the\s+)?(?:user|operator)|aguarda\b)|\b(?:waiting_operator|aguarda\b)[^\n]{0,160}\bc_[0-9a-f]{6}\b/iu.test(text);
}

/** A wake report that says nothing happened ("nothing new", "nada novo", "sem novidades"), the summary the operator does not want. */
export function nothingNewReply(text: string): boolean {
  return /^(?:nothing new|no news|nada novo|sem novidades|sem mudan[çc]as)\b/iu.test(text.trim());
}
