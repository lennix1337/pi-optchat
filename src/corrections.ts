import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { FROM_SLACK } from './slack-bridge.ts';
import { appendRecent, readJsonl } from './store.ts';

/**
 * Operator corrections become tests or rules. When an operator message reads as a correction ("já falei", "não era
 * isso", "para de…"), the next tool result of that run carries one reminder to turn it into a regression test or a rule,
 * and the time and origin are logged (never the text) for the weekly scoreboard. Detection is a cue match, so the
 * scoreboard counts "possible corrections", not verified ones.
 */
export const CORRECTIONS = 'corrections.jsonl';
const KEEP_MS = 35 * 86_400_000;
type Entry = { at: number; origin: 'tui' | 'slack' };

const CUE = new RegExp([
  String.raw`n[aã]o\s+(?:era|é|e|foi)\s+(?:isso|assim|pra|para|o\s+que)`,
  String.raw`(?:t[aá]|est[aá]|ficou)\s+errad[oa]`, String.raw`(?:voc[eê]|vc)\s+errou`, String.raw`errou\s+de\s+novo`,
  String.raw`j[aá]\s+(?:te\s+)?(?:falei|disse|pedi|avisei|expliquei)`, String.raw`eu\s+(?:te\s+)?(?:falei|disse|pedi)\s+(?:pra|para|que|n[aã]o)`,
  String.raw`(?:para|pare)\s+de\s+\p{L}`, String.raw`n[aã]o\s+(?:fa[cç]a|faz|fazer)\s+(?:isso|mais)`, String.raw`nunca\s+(?:mais\s+)?(?:fa[cç]a|faz)`,
  String.raw`de\s+novo\s+(?:isso|esse|essa|o\s+mesmo)`, String.raw`sem\s+(?:eu\s+)?(?:pedir|autoriza[cç][aã]o|permiss[aã]o)`,
  String.raw`that'?s\s+(?:wrong|not\s+what)`, String.raw`not\s+what\s+i\s+(?:asked|said|meant)`, String.raw`i\s+(?:already\s+)?(?:told|said)\s+(?:you|to|not)`,
  String.raw`stop\s+(?:doing|\w+ing)`, String.raw`don'?t\s+do\s+that`,
].map(p => `(?<![\\p{L}\\p{N}])(?:${p})`).join('|'), 'iu');

/** The operator's own words without a `[Slack]` marker; undefined for inputs that are not his (wakes, reports, goal events). */
export function operatorText(text: string, source: string): { text: string; origin: Entry['origin'] } | undefined {
  if (source === 'interactive') return { text, origin: 'tui' };
  const slack = FROM_SLACK.exec(text);
  return slack ? { text: text.slice(slack[0].length), origin: 'slack' } : undefined;
}
export const isCorrection = (text: string) => CUE.test(text);

export const recordCorrection = (dir: string, origin: Entry['origin'], now = Date.now()) =>
  appendRecent<Entry>(join(dir, CORRECTIONS), { at: now, origin }, 64 * 1024, KEEP_MS);

/** Possible corrections since `since`; `recordingSince` is undefined when nothing was ever logged (unmeasured, not zero). */
export function correctionsWeek(dir: string, since: number): { count: number; recordingSince?: number } {
  const all = readJsonl<Entry>(join(dir, CORRECTIONS), e => Number.isFinite(e.at));
  const first = all.reduce((min, e) => Math.min(min, e.at), Infinity);
  return { count: all.filter(e => e.at >= since).length, ...Number.isFinite(first) ? { recordingSince: first } : {} };
}

export const CORRECTION_NOTICE = '[OptChat correction] The operator\'s latest message reads as a correction. Before this run ends, turn it into a regression test that fails without the fix, or a rule in CODING_STANDARDS.md or AGENTS.md (automated where a check can), or say in your reply why it does not generalize.';

/** Logs operator corrections and reminds the run that received one, once, on its next tool result. */
export function registerCorrections(pi: ExtensionAPI, owner: () => { dir: string } | undefined, now: () => number = Date.now) {
  let due = false;
  pi.on('input', event => {
    const o = owner(), words = operatorText(event.text, event.source);
    if (!o || !words || !isCorrection(words.text)) return;
    due = true;
    try { recordCorrection(o.dir, words.origin, now()); }
    catch (error) { console.error(`Correction log not written: ${error instanceof Error ? error.message : String(error)}`); }
  });
  pi.on('tool_result', event => {
    if (!due) return;
    due = false; // A profile closed meanwhile drops it: the correction was said to that profile's run.
    if (!owner()) return;
    return { content: [...event.content, { type: 'text' as const, text: `\n${CORRECTION_NOTICE}` }] };
  });
}
