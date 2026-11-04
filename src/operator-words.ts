import type { Entry } from './memory.ts';

/** His Slack messages arrive as `[Slack] ` or `[Slack #channel] ` text; every other bracketed head is a machine notice. */
const SLACK_HEAD = /^\[Slack(?: #[\w-]+)?\]\s+/;
/**
 * What the operator himself wrote, or undefined for a machine notice that also arrives as a user message (gitwatch,
 * shell ends, reload resumes, status notes, Slack approval relays) or an approval token. Counting notices let a
 * release order fall out of the window after four gitwatch notices (03/11: three refusals of a requested delete).
 */
export function operatorWords(raw: string): string | undefined {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text || /^approve-(?:effect|standing)\b/.test(text)) return undefined;
  if (SLACK_HEAD.test(text)) { const said = text.replace(SLACK_HEAD, ''); return /^\(aprova\u00e7\u00e3o\)/.test(said) ? undefined : said; }
  return text.startsWith('[') ? undefined : text;
}

/** The operator's latest own message in memory. The message that started the current turn is not in the view yet,
 * so tools that cite a source accept "latest" for it instead of an id the model cannot see. */
export function latestOperatorMessage(root: readonly Entry[]): Entry | undefined {
  for (let i = root.length - 1; i >= 0; i--) {
    const entry = root[i];
    if (entry?.kind === 'user' && !entry.origin && operatorWords(entry.text)) return entry;
  }
  return undefined;
}
