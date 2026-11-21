import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { openCommitments, readCommitments, type Commitment } from './commitments.ts';
import { PRS, type PrSeen } from './slack-reports.ts';

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

// external: Slack views impose section and view size limits.
const LIMIT = 4;
const SECTION_CHARS = 280;
const URL_IN = /https:\/\/[^\s<>|)]+/;
const STATUS: Record<string, string> = { open: 'em aberto', blocked: 'bloqueado' };
const RED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED', 'STARTUP_FAILURE']);
const FAILING_FIRST: Record<PrItem['checks'], number> = { vermelhos: 0, pendentes: 1, verdes: 2, 'sem checks': 3 };

const checksOf = (ci: string): PrItem['checks'] => ci === 'SUCCESS' ? 'verdes' : RED.has(ci) ? 'vermelhos' : ci === 'NONE' || !ci ? 'sem checks' : 'pendentes';


function openPr(key: string, seen: PrSeen): PrItem | undefined {
  const match = /^(.+)#(\d+)$/.exec(key);
  if (!seen || typeof seen.sig !== 'string' || !seen.sig.startsWith('OPEN:') || !match || typeof seen.url !== 'string') return undefined;
  return { repo: match[1]!, number: Number(match[2]), title: String(seen.title ?? ''), url: seen.url, checks: checksOf(seen.sig.split(':')[1] ?? '') };
}

/** The open PRs of the watch, failing CI first. A missing or damaged watch file lists nothing. */
export function readPrItems(dir: string): PrItem[] {
  const watch = readWatch(dir);
  const items = Object.entries(watch).map(([key, seen]) => openPr(key, seen)).filter((item): item is PrItem => item !== undefined);
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

/** A worker or job as the Home lists it: what it is doing and for how long ("agy Neon: 3 candidatos · há 12 min"). */
export function runningItem(title: string, started: number, now: number): string {
  const m = Math.max(0, Math.round((now - started) / 60_000));
  return `${title} \u00b7 h\u00e1 ${m < 120 ? `${m} min` : `${Math.round(m / 60)} h`}`;
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

  return clip(list.length > words ? `${list.slice(0, words).join(' ').replace(/[,.;:]$/, '')}\u2026` : head.replace(/[,.;:]$/, ''), 80);
}


const CHECK_DOT: Record<PrItem['checks'], string> = { vermelhos: '\ud83d\udd34', pendentes: '\ud83d\udfe1', verdes: '\ud83d\udfe2', 'sem checks': '\u26aa' };
const prLine = (p: PrItem) => `\u2022 <${p.url}|${escape(`${p.repo.split('/').pop()}#${p.number} ${headline(p.title)}`)}> \u00b7 ${CHECK_DOT[p.checks]} checks ${p.checks}`;
const commitLine = (c: CommitmentItem) => `\u2022 ${c.url ? `<${c.url}|${escape(headline(c.text))}>` : escape(headline(c.text))} \u00b7 ${c.status}`;
const jobLine = (j: string) => `\u2022 ${escape(clip(j, 120))}`;


const EXPANDED = { limit: 30, chars: 3_000 };


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

    ...running.length ? [section(`\u2699\ufe0f *Rodando agora* (${running.length})`, running.map(jobLine), expanded)] : [],
    ...work.prs.length ? [section(`\ud83d\udd00 *PRs abertas* (${work.prs.length})`, work.prs.map(prLine), expanded)] : [],
    ...work.commitments.length ? [section(`\ud83d\udccc *Compromissos abertos* (${work.commitments.length})`, work.commitments.map(commitLine), expanded)] : [],
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

  if (running) return `\u23f3 *Em segundo plano* (${running} rodando${ci ? `; esperando ${ci}` : ''})`;
  return ci ? `\u23f3 *Parado, esperando ${escape(ci)}*` : '';
}


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

export let watchReadBytes = 0;
const watchCache = new Map<string, { stamp: string; value: Record<string, PrSeen> }>();

export function readWatch(dir: string): Record<string, PrSeen> {
  const file = join(dir, PRS);
  let stamp: string;
  try { const s = statSync(file); stamp = `${s.size}:${s.mtimeMs}`; } catch { watchCache.delete(file); return {}; }
  const hit = watchCache.get(file);
  if (hit?.stamp === stamp) return hit.value;
  let value: Record<string, PrSeen> = {};
  try { const raw = readFileSync(file, 'utf8'); watchReadBytes += Buffer.byteLength(raw); value = JSON.parse(raw) ?? {}; } catch { value = {}; }
  if (watchCache.size >= 16) watchCache.delete(watchCache.keys().next().value!);
  watchCache.set(file, { stamp, value });
  return value;
}
