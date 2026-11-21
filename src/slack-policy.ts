/**
 * Per-channel rules for what OptChat posts on Slack. The DM and each project channel have a word budget (100 by
 * default: the IM cap the DeepSeek Harness article verified). The budget is guidance for the model only: every post goes out
 * whole, in one message, never split into a head and a thread reply.
 */
export const DEFAULT_WORD_BUDGET = 100;
/** Budgets of project channels by name; a channel without one uses the default. The DM is never overridden. */
export type WordBudgets = Readonly<Record<string, number>>;

const BUILT_IN: WordBudgets = { wakes: 300 };
export const wordBudget = (channel: string | null, budgets: WordBudgets = {}): number =>
  channel === null ? DEFAULT_WORD_BUDGET : budgets[channel] ?? BUILT_IN[channel] ?? DEFAULT_WORD_BUDGET;

/** The instruction the model reads with each Slack message: the budget of the channel it answers in. */
export const budgetNote = (budget: number): string => `(Responda em até ${budget} palavras, numa mensagem só.)`;
/** The paragraph `budgetNote` ends a Slack message with, matched to take it off again (a message's title). */
export const BUDGET_NOTE = /\n\n\(Responda em até \d+ palavras(?:, numa mensagem só|; o que passar disso vai para a thread)\.\)/;
/** The paragraph a Slack message gets when it arrives while a run is working. */
export const MID_RUN = '\n\n(Arrived while you were working: answer it with slack_send, then continue the current work. Do not end the run just to reply.)';
/** His message without the notes the bridge appended to it: what he actually wrote. */
export const withoutBridgeNotes = (text: string): string => text.replace(MID_RUN, '').replace(BUDGET_NOTE, '');

export const words = (text: string): number => text.match(/\S+/g)?.length ?? 0;
