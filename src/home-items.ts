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
export type HomeWork = { prs: PrItem[]; commitments: CommitmentItem[]; jobs: string[] };
export const NO_WORK: HomeWork = { prs: [], commitments: [], jobs: [] };

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
export function readHomeWork(dir: string, jobs: readonly string[], now: number): HomeWork {
  return { prs: readPrItems(dir), commitments: commitmentItems(readCommitments(dir), now), jobs: [...jobs] };
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** One line, at most `max` characters; whitespace that would break the bullet is folded first. */
const clip = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}\u2026` : flat;
};

const prLine = (p: PrItem) => `\u2022 <${p.url}|${escape(`${p.repo.split('/').pop()}#${p.number} ${clip(p.title, 80)}`)}> \u00b7 checks ${p.checks}`;
const commitLine = (c: CommitmentItem) => `\u2022 ${c.url ? `<${c.url}|${escape(clip(c.text, 140))}>` : escape(clip(c.text, 140))} \u00b7 ${c.status}`;
const jobLine = (j: string) => `\u2022 ${escape(clip(j, 120))}`;

/** The title, then whole lines while they fit in SECTION_CHARS (at most LIMIT); the rest is counted in one `… mais` line. */
function section(title: string, lines: readonly string[]): string {
  const kept: string[] = [];
  let left = SECTION_CHARS - title.length - 1;
  for (const line of lines.slice(0, LIMIT)) {
    if (line.length + 1 > left) break;
    kept.push(line);
    left -= line.length + 1;
  }
  const more = lines.length - kept.length;
  return [title, ...kept, ...more ? [`\u2026 mais ${more}`] : []].join('\n');
}

/** The sections with something in them, one after another; an empty Home part is empty text. */
export function renderWork(work: HomeWork): string {
  const parts: string[] = [];
  if (work.prs.length) parts.push(section(`*PRs abertas* (${work.prs.length})`, work.prs.map(prLine)));
  if (work.commitments.length) parts.push(section(`*Compromissos abertos* (${work.commitments.length})`, work.commitments.map(commitLine)));
  if (work.jobs.length) parts.push(section(`*Rodando agora* (${work.jobs.length})`, work.jobs.map(jobLine)));
  return parts.join('\n\n');
}
