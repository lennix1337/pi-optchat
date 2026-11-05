/**
 * Per-channel rules for what OptChat posts on Slack. The DM and each project channel have a word budget (100 by
 * default: the IM cap the DeepSeek Harness article verified). A post over its budget goes out as a short head with a
 * pointer, and the full text follows as a thread reply, so nothing is cut silently.
 */
export const DEFAULT_WORD_BUDGET = 100;
/** Budgets of project channels by name; a channel without one uses the default. The DM is never overridden. */
export type WordBudgets = Readonly<Record<string, number>>;
export const wordBudget = (channel: string | null, budgets: WordBudgets = {}): number =>
  channel !== null && budgets[channel] !== undefined ? budgets[channel] : DEFAULT_WORD_BUDGET;

/** The instruction the model reads with each Slack message: the budget of the channel it answers in. */
export const budgetNote = (budget: number): string => `(Responda em até ${budget} palavras; o que passar disso vai para a thread.)`;
/** The paragraph `budgetNote` ends a Slack message with, matched to take it off again (a message's title). */
export const BUDGET_NOTE = /\n\n\(Responda em até \d+ palavras; o que passar disso vai para a thread\.\)/;
/** The paragraph a Slack message gets when it arrives while a run is working. */
export const MID_RUN = '\n\n(Arrived while you were working: answer it with slack_send, then continue the current work. Do not end the run just to reply.)';
/** His message without the notes the bridge appended to it: what he actually wrote. */
export const withoutBridgeNotes = (text: string): string => text.replace(MID_RUN, '').replace(BUDGET_NOTE, '');

const POINTER = '_… texto completo na thread._';
export const words = (text: string): number => text.match(/\S+/g)?.length ?? 0;

/** What goes out in the channel (`head`) and, when the post was over budget, the full text for the thread reply. */
export type FittedPost = { head: string; full?: string };

/** The head is the leading part of the post that fits in the budget with the pointer; the full text is never trimmed. */
export function fitPost(text: string, budget: number): FittedPost {
  if (words(text) <= budget) return { head: text };
  const room = Math.max(0, budget - words(POINTER));
  const lead = leadingWords(text, room);
  return { head: lead ? `${lead}\n\n${POINTER}` : POINTER, full: text };
}

/**
 * Whole paragraphs while they fit; the first one that does not is cut at a sentence. A word cut is the last resort, only
 * when no paragraph fits at all: a head that already has paragraphs ends at a paragraph boundary.
 */
function leadingWords(text: string, room: number): string {
  const kept: string[] = [];
  let left = room;
  for (const paragraph of text.split(/\n\s*\n/)) {
    const size = words(paragraph);
    if (size <= left) { kept.push(paragraph); left -= size; continue; }
    const cut = leadingSentences(paragraph, left) || (kept.length ? '' : leadingTokens(paragraph, left));
    if (cut) kept.push(cut);
    break;
  }
  return withoutOpenFence(kept.join('\n\n').trim());
}

function leadingSentences(paragraph: string, room: number): string {
  const sentences = paragraph.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [paragraph];
  let cut = '';
  for (const sentence of sentences) {
    if (words(cut + sentence) > room) break;
    cut += sentence;
  }
  return cut.trim();
}

function leadingTokens(paragraph: string, room: number): string {
  return paragraph.split(/\s+/).filter(Boolean).slice(0, room).join(' ');
}

/** A cut inside a code block would leave the head with an open fence: the block is dropped from the head instead. */
function withoutOpenFence(head: string): string {
  if ((head.match(/```/g) ?? []).length % 2 === 0) return head;
  return head.slice(0, head.lastIndexOf('```')).trim();
}
