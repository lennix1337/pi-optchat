import { join } from 'node:path';
import { appendJsonl, readJsonl } from './store.ts';

/**
 * What the operator's Slack conversation shows about Jarvis: how long his messages wait for a first answer, and how
 * often he has to ask "e aí?" because nothing reached him. The bridge records each message as it arrives and each answer
 * it delivers (the run's final answer or a slack_send); automatic posts (PR watch, morning summary, approvals) are not
 * answers. Only times, channels and the nudge flag are stored, never message text. Read by the weekly scoreboard.
 */
export const SLACK_METRICS = 'slack-metrics.jsonl';
const KEEP_MS = 35 * 86_400_000;
type Entry = { at: number; kind: 'in' | 'out'; channel: string | null; nudge?: true };

/** A short message that only asks where things stand: "e aí", "cadê", "como tá", "alguma novidade?", "status?". */
const NUDGE = /^(?:e\s+a[ií]|cad[eê]|como\s+(?:t[aá]|est[aá]|anda|ficou)|(?:alguma\s+)?novidades?|status|e\s+ent[aã]o)(?![\p{L}\p{N}])/iu;
export const isNudge = (text: string) => { const t = text.trim(); return t.length <= 60 && NUDGE.test(t); };

const append = (dir: string, entry: Entry) => appendJsonl<Entry>(join(dir, SLACK_METRICS), entry, 256 * 1024, e => e.at >= entry.at - KEEP_MS);
export const recordInbound = (dir: string, channel: string | null, text: string, now = Date.now()) =>
  append(dir, { at: now, kind: 'in', channel, ...isNudge(text) ? { nudge: true as const } : {} });
export const recordAnswer = (dir: string, channel: string | null, now = Date.now()) => append(dir, { at: now, kind: 'out', channel });

const readEntries = (dir: string, since: number) =>
  readJsonl<Entry>(join(dir, SLACK_METRICS), e => Number.isFinite(e.at) && e.at >= since && (e.kind === 'in' || e.kind === 'out'));

/**
 * The week's numbers: each message pairs with the first answer in the same channel after it. `recordingSince` is the
 * oldest record kept; without it nothing was ever recorded, so every count here is unmeasured rather than zero.
 */
export type SlackWeek = { received: number; answered: number; waiting: number; nudges: number; medianMs?: number; worstMs?: number; recordingSince?: number };
export function slackWeek(dir: string, since: number): SlackWeek {
  const pending = new Map<string, number[]>();
  const delays: number[] = [];
  let received = 0, nudges = 0;
  const all = readEntries(dir, 0).sort((a, b) => a.at - b.at);
  for (const e of all.filter(e => e.at >= since)) {
    const key = e.channel ?? '';
    if (e.kind === 'in') {
      received++;
      if (e.nudge) nudges++;
      pending.set(key, [...pending.get(key) ?? [], e.at]);
    } else {
      for (const at of pending.get(key) ?? []) delays.push(e.at - at);
      pending.delete(key);
    }
  }
  delays.sort((a, b) => a - b);
  const waiting = [...pending.values()].reduce((n, list) => n + list.length, 0);
  return { received, answered: delays.length, waiting, nudges,
    ...delays.length ? { medianMs: delays[Math.floor((delays.length - 1) / 2)], worstMs: delays.at(-1) } : {},
    ...all.length ? { recordingSince: all[0]!.at } : {} };
}
