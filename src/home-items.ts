import { join } from 'node:path';
import { openCommitments, readCommitments, type Commitment } from './commitments.ts';
import { PRS, type PrSeen } from './slack-reports.ts';
import { readJsonOr } from './store.ts';

/**
 * The App Home shows the work as domain items, not chat sessions: the operator's open PRs (the PR watch), the open
 * commitments this chat keeps, and the background jobs running now. Read-only: an item links to its PR, or to a URL the
 * commitment names. Items the operator must decide are listed by the bridge's "Esperando você", not here.
 */
export type PrItem = { repo: string; number: number; title: string; url: string; checks: 'verdes' | 'vermelhos' | 'pendentes' | 'sem checks' };
export type CommitmentItem = { text: string; status: string; url?: string };
/** `jobs`: background shells running now; `agents`: subagents running now. Either one means the agent is not idle. */
export type HomeWork = { prs: PrItem[]; commitments: CommitmentItem[]; jobs: string[]; agents?: string[] };
export const NO_WORK: HomeWork = { prs: [], commitments: [], jobs: [], agents: [] };

/**
 * Items per section and characters per section: the rest is counted, not listed, so the Home keeps room for its waiting
 * list, the day and its commands within Slack's section limit (three sections at most, each with its own budget).
 */
const LIMIT = 4;
const SECTION_CHARS = 280;
const URL_IN = /https:\/\/[^\s<>|)]+/;
const STATUS: Record<string, string> = { open: 'em aberto', blocked: 'bloqueado' };
const RED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED', 'STARTUP_FAILURE']);
const FAILING_FIRST: Record<PrItem['checks'], number> = { vermelhos: 0, pendentes: 1, verdes: 2, 'sem checks': 3 };

const checksOf = (ci: string): PrItem['checks'] => ci === 'SUCCESS' ? 'verdes' : RED.has(ci) ? 'vermelhos' : ci === 'NONE' || !ci ? 'sem checks' : 'pendentes';

/** One open PR of the watch; anything else (merged, closed, no key, no link) is not an item. */
function openPr(key: string, seen: PrSeen): PrItem | undefined {
  const match = /^(.+)#(\d+)$/.exec(key);
  if (!seen || typeof seen.sig !== 'string' || !seen.sig.startsWith('OPEN:') || !match || typeof seen.url !== 'string') return undefined;
  return { repo: match[1]!, number: Number(match[2]), title: String(seen.title ?? ''), url: seen.url, checks: checksOf(seen.sig.split(':')[1] ?? '') };
}

/** The open PRs of the watch, failing CI first. A missing or damaged watch file lists nothing. */
export function readPrItems(dir: string): PrItem[] {
  const watch = readJsonOr<Record<string, PrSeen>>(join(dir, PRS), {});
  const items = Object.entries(watch ?? {}).map(([key, seen]) => openPr(key, seen)).filter((item): item is PrItem => item !== undefined);
  return items.sort((a, b) => FAILING_FIRST[a.checks] - FAILING_FIRST[b.checks]);
}

/** The open commitments the operator is not waited on for: those are in "Esperando você". */
export function commitmentItems(items: readonly Commitment[], now: number): CommitmentItem[] {
  return openCommitments(items, now)
    .filter(c => c.owner !== 'operator' && c.status !== 'waiting_operator')
    .map(c => {
      const link = URL_IN.exec([c.text, c.next, c.evidence].filter(Boolean).join(' '));
      return { text: c.text, status: STATUS[c.status] ?? c.status, ...(link ? { url: link[0] } : {}) };
    });
}

/** Everything the Home shows as work, read from the profile's files; `jobs` are the background shells running now. */
export function readHomeWork(dir: string, jobs: readonly string[], now: number, agents: readonly string[] = []): HomeWork {
  return { prs: readPrItems(dir), commitments: commitmentItems(readCommitments(dir), now), jobs: [...jobs], agents: [...agents] };
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** One line, at most `max` characters; whitespace that would break the bullet is folded first. */
const clip = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
};

/**
 * A title the phone reads at a glance: the words before the first aside ("(...)", ": ", " — ") once they say enough,
 * then at most `words` words. 03/11: PR titles and commitments went out cut mid-sentence, with the internal detail.
 */
export function headline(text: string, words = 8): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const aside = /\s\(|:\s|\s[\u2014\u2013-]\s/.exec(flat);
  const head = aside && flat.slice(0, aside.index).split(' ').length >= 3 ? flat.slice(0, aside.index) : flat;
  const list = head.split(' ');
  // Words are the measure, characters the bound: a run-on token (a URL, a path) must not take the section's budget.
  return clip(list.length > words ? `${list.slice(0, words).join(' ').replace(/[,.;:]$/, '')}\u2026` : head.replace(/[,.;:]$/, ''), 80);
}

const prLine = (p: PrItem) => `\u2022 <${p.url}|${escape(`${p.repo.split('/').pop()}#${p.number} ${headline(p.title)}`)}> \u00b7 checks ${p.checks}`;
const commitLine = (c: CommitmentItem) => `\u2022 ${c.url ? `<${c.url}|${escape(headline(c.text))}>` : escape(headline(c.text))} \u00b7 ${c.status}`;
const jobLine = (j: string) => `\u2022 ${escape(clip(j, 120))}`;

/** Expanded (the Home's Ver tudo): every item, still within Slack's view size. */
const EXPANDED = { limit: 30, chars: 3_000 };

/** The title, then whole lines while they fit in the budget (at most `limit`); the rest is counted in one `… mais` line. */
function section(title: string, lines: readonly string[], expanded: boolean): { text: string; hidden: number } {
  const kept: string[] = [];
  const { limit, chars } = expanded ? EXPANDED : { limit: LIMIT, chars: SECTION_CHARS };
  let left = chars - title.length - 1;
  for (const line of lines.slice(0, limit)) {
    if (line.length + 1 > left) break;
    kept.push(line);
    left -= line.length + 1;
  }
  const more = lines.length - kept.length;
  return { text: [title, ...kept, ...more ? [`\u2026 mais ${more} (toque em *Ver tudo*)`] : []].join('\n'), hidden: more };
}

/** The sections with something in them, one after another, and how many items were left out (the Home then offers Ver tudo). */
export function renderWorkParts(work: HomeWork, expanded = false): { text: string; hidden: number } {
  const running = [...work.agents ?? [], ...work.jobs];
  const parts = [
    ...work.prs.length ? [section(`*PRs abertas* (${work.prs.length})`, work.prs.map(prLine), expanded)] : [],
    ...work.commitments.length ? [section(`*Compromissos abertos* (${work.commitments.length})`, work.commitments.map(commitLine), expanded)] : [],
    ...running.length ? [section(`*Rodando agora* (${running.length})`, running.map(jobLine), expanded)] : [],
  ];
  return { text: parts.map(p => p.text).join('\n\n'), hidden: parts.reduce((n, p) => n + p.hidden, 0) };
}

export function renderWork(work: HomeWork, expanded = false): string { return renderWorkParts(work, expanded).text; }

/** What still runs in the background, in words ("2 subagentes e 1 comando"); empty when nothing does. */
export function backgroundSummary(work: HomeWork): string {
  const agents = work.agents?.length ?? 0, jobs = work.jobs.length;
  return [agents ? `${agents} subagente${agents === 1 ? '' : 's'}` : '', jobs ? `${jobs} comando${jobs === 1 ? '' : 's'}` : ''].filter(Boolean).join(' e ');
}

/** The PRs whose CI is still running, in words ("CI de pi-optchat#88", "CI de 3 PRs"); empty when none. */
export function pendingCi(work: HomeWork): string {
  const pending = work.prs.filter(p => p.checks === 'pendentes');
  if (!pending.length) return '';
  return pending.length <= 2 ? `CI de ${pending.map(p => `${p.repo.split('/').pop()}#${p.number}`).join(' e ')}` : `CI de ${pending.length} PRs`;
}

/**
 * The status line when the chat is idle but the agent is not: what runs in the background and what it waits for, so
 * the operator tells "waiting on CI" from "doing nothing". Empty when nothing runs or is awaited (the Home says Livre).
 */
export function idleLine(work: HomeWork): string {
  const running = backgroundSummary(work), ci = pendingCi(work);
  // One state, not two: "Esperando CI" next to "chat livre" read as a contradiction (03/11).
  if (running) return `\u23f3 *Em segundo plano* (${running} rodando${ci ? `; esperando ${ci}` : ''})`;
  return ci ? `\u23f3 *Parado, esperando ${escape(ci)}*` : '';
}

/** The PRs a text names (`Genexus18MCP#843`, `pi-optchat #92`), as watch keys' repo name and number. */
const PR_REF = /([A-Za-z][\w.-]*)\s?#(\d+)/g;

/**
 * Drops what waits on the operator once its subject is over: an item whose every PR it names that the watch knows is
 * merged or closed. An item naming no known PR stays. 03/11: the Home asked him to check #843 hours after it merged.
 */
export function stillWaiting<T extends { text: string; ask?: string }>(items: readonly T[], watch: Record<string, Pick<PrSeen, 'sig'>>): T[] {
  const byRef = new Map(Object.entries(watch).map(([key, seen]) => [key.split('/').pop()!.toLowerCase(), String(seen?.sig ?? '')]));
  return items.filter(item => {
    const states = [...`${item.text} ${item.ask ?? ''}`.matchAll(PR_REF)].map(([, repo, n]) => byRef.get(`${repo!.toLowerCase()}#${n}`)).filter((s): s is string => s !== undefined);
    return !states.length || states.some(s => s.startsWith('OPEN:'));
  });
}

export function readWatch(dir: string): Record<string, PrSeen> { return readJsonOr<Record<string, PrSeen>>(join(dir, PRS), {}) ?? {}; }
