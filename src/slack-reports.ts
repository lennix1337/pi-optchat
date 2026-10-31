import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { assistantConfig, assistantRequest } from './assistant-client.ts';
import { readCommitments, summaryLines, type Commitment } from './commitments.ts';
import { forecast, type PrOutlook } from './forecast.ts';
import { healthLines, PC_FILE, readHealth } from './prod-health.ts';
import { fixLines, readFixes } from './self-fix.ts';
import { projectOfRepo } from './projects.ts';
import { appendRecent, atomicWrite, readJsonl, readJsonOr } from './store.ts';
import { QUOTA_FILE, QUOTA_HEALTH_FILE, quotaRisks } from './quota-health.ts';
import { WeeklyScoreboard } from './scoreboard.ts';

/**
 * What the operator hears on Slack without asking, each in its project's channel: his PRs changing (CI green or red,
 * merged, closed; one thread per PR), a 07:00 DM summing up the previous day with what waits for him and his agenda, and the
 * Monday scoreboard in #harness (scoreboard.ts).
 * Shell and subagent completions are not posted: the operator asked for messages only, and the run's own report says
 * what they proved. Best effort: a failed post is dropped, never retried in a loop.
 */
export type Post = (text: string, channel: string | null, topic?: string) => Promise<unknown>;
export type ReportOwner = { dir: string; name: string };

const one = (s: string, max: number) => {
  const t = s.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// ---- Day log: every channel post, so the morning summary can say what was done. ----
const DAY = 'slack-day.jsonl';
type DayEntry = { at: number; channel: string | null; line: string };
export function logSent(dir: string, channel: string | null, text: string, now = Date.now()): void {
  if (/^(?:⏸|☀️)/u.test(text)) return; // Approval prompts and the summary itself are not work done.
  appendRecent<DayEntry>(join(dir, DAY), { at: now, channel, line: one(text.replace(/^\*Wake\* · /, ''), 200) }, 256 * 1024, 3 * 86_400_000);
}
export const readDay = (dir: string, since: number): DayEntry[] => readJsonl<DayEntry>(join(dir, DAY), e => e.at >= since);

// ---- The operator's PRs. ----
type Gh = (args: string[]) => Promise<string>;
const defaultGh: Gh = args => new Promise((resolve, reject) => execFile('gh', args, { timeout: 30_000, windowsHide: true, maxBuffer: 4 << 20 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
const PR_QUERY = `query($q:String!){search(query:$q,type:ISSUE,first:50){nodes{... on PullRequest{number title url state isDraft createdAt repository{name nameWithOwner} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;
type PrNode = { number: number; title: string; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; isDraft: boolean; createdAt: string; repository: { name: string; nameWithOwner: string }; commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] } };
/** `since`: when `sig` was first seen; `flips`: how often CI went from green to red or back; `verdict`: the last green/red seen. */
export type PrSeen = { sig: string; seen: number; title: string; url: string; channel: string; since?: number; flips?: number; verdict?: 'green' | 'red' };

const VERDICT = new Set(['SUCCESS', 'FAILURE', 'ERROR']);
/**
 * The next record of a PR: `since` survives while its state and CI hold; `flips` counts changes of CI verdict, so
 * green, pending, red is one flip (the pending run in between does not hide it).
 */
export function nextSeen(before: PrSeen | undefined, sig: string, now: number): Pick<PrSeen, 'since' | 'flips' | 'verdict'> {
  const ci = sig.split(':')[1] ?? '';
  const verdict = VERDICT.has(ci) ? (ci === 'SUCCESS' ? 'green' : 'red') : before?.verdict;
  const flips = (before?.flips ?? 0) + (before?.verdict && verdict !== before.verdict ? 1 : 0);
  return { since: before?.sig === sig ? before.since ?? now : now, flips, ...verdict ? { verdict } : {} };
}
export const PRS = 'pr-watch.json';
const PR_KEEP_MS = 14 * 86_400_000;

/** What changed between two sightings of one PR, as a post; undefined when nothing worth saying. */
export function prChange(before: string | undefined, pr: { state: string; ci: string; createdAt: number }, now: number): string | undefined {
  const [state, ci] = before?.split(':') ?? [];
  if (pr.state !== state && before !== undefined) {
    if (pr.state === 'MERGED') return '🟣 Mergeado';
    if (pr.state === 'CLOSED') return '⚪ Fechado sem merge';
  }
  if (before === undefined && pr.state === 'OPEN' && now - pr.createdAt < 6 * 3_600_000) return '🆕 PR aberto';
  if (pr.state === 'OPEN' && pr.ci !== ci && before !== undefined) {
    if (pr.ci === 'SUCCESS') return '✅ CI verde';
    if (pr.ci === 'FAILURE' || pr.ci === 'ERROR') return '❌ CI vermelho';
  }
  return undefined;
}

/** The forecast's view of a recorded PR. */
export const outlook = (p: PrSeen): PrOutlook => ({ title: p.title, url: p.url, ci: p.sig.split(':')[1] ?? 'NONE', since: p.since ?? p.seen, flips: p.flips ?? 0 });

export class PrWatch {
  constructor(private readonly owner: () => ReportOwner | undefined, private readonly post: Post, private readonly gh: Gh = defaultGh, private readonly now: () => number = Date.now) {}

  open(dir: string): PrSeen[] {
    return Object.values(this.read(dir)).filter(p => p.sig.startsWith('OPEN:'));
  }

  /** One pass; the first ever only records what exists, so a fresh install posts nothing. */
  async poll(): Promise<number> {
    const owner = this.owner();
    // Posts go through the assistant service; a profile without it would spend a GitHub call every pass for nothing.
    if (!owner || !existsSync(join(owner.dir, 'assistant.json'))) return 0;
    const now = this.now();
    const since = new Date(now - 2 * 86_400_000).toISOString().slice(0, 10);
    const out = JSON.parse(await this.gh(['api', 'graphql', '-f', `query=${PR_QUERY}`, '-f', `q=is:pr author:@me updated:>=${since}`])) as { data?: { search?: { nodes?: PrNode[] } } };
    const nodes = (out.data?.search?.nodes ?? []).filter(n => typeof n?.number === 'number');
    let known: Record<string, PrSeen> | undefined;
    try { known = JSON.parse(readFileSync(join(owner.dir, PRS), 'utf8')); } catch { known = undefined; }
    const next: Record<string, PrSeen> = Object.fromEntries(Object.entries(known ?? {}).filter(([, p]) => now - p.seen < PR_KEEP_MS));
    let posted = 0;
    for (const pr of nodes) {
      const channel = projectOfRepo(pr.repository.name);
      if (!channel) continue;
      const key = `${pr.repository.nameWithOwner}#${pr.number}`;
      const ci = pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? 'NONE';
      const sig = `${pr.state}:${ci}`;
      const change = known && prChange(known[key]?.sig, { state: pr.state, ci, createdAt: Date.parse(pr.createdAt) }, now);
      next[key] = { sig, seen: now, title: one(pr.title, 120), url: pr.url, channel, ...nextSeen(known?.[key], sig, now) };
      if (!change) continue;
      try { await this.post(`${change} · <${pr.url}|${pr.repository.name}#${pr.number}> ${one(pr.title, 120)}${pr.isDraft && pr.state === 'OPEN' ? ' (draft)' : ''}`, channel, `pr:${key}`); posted++; }
      catch { /* the next pass sees no change; a lost post is not resent */ }
    }
    atomicWrite(join(owner.dir, PRS), JSON.stringify(next));
    return posted;
  }

  private read(dir: string): Record<string, PrSeen> {
    try { return JSON.parse(readFileSync(join(dir, PRS), 'utf8')); } catch { return {}; }
  }
}

// ---- Morning summary in the DM. ----
type Briefing = { localDate: string; items: { section: string; title: string; urgency: string }[]; sources: { sourceId: string; state: string }[] };
type Request = (owner: ReportOwner, path: string, body?: unknown, timeoutMs?: number) => Promise<unknown>;
const defaultRequest: Request = (owner, path, body, timeoutMs = 20_000) => assistantRequest(assistantConfig(owner), path, body, timeoutMs);
const DAILY = 'slack-daily.json';
export const localDate = (at: number) => new Date(at).toLocaleDateString('sv-SE');

export type SummaryInputs = { day: DayEntry[]; waiting: string[]; prs: PrSeen[]; briefing?: Briefing; approvals: number; commitments?: { waiting: string[]; attention: string[] }; health?: string[]; pc?: string[]; quota?: string[]; risks?: string[]; fixes?: string[] };
export function composeSummary({ day, waiting, prs, briefing, approvals, commitments, health, pc, quota, risks, fixes }: SummaryInputs): string {
  const lines = ['☀️ *Bom dia! Resumo das últimas 24h*'];
  if (fixes?.length) lines.push('', '*Resolvi sozinho*', ...fixes.slice(-8).map(f => `• ${one(f, 200)}`));
  const byChannel = new Map<string, string[]>();
  for (const e of day) if (e.channel) byChannel.set(e.channel, [...byChannel.get(e.channel) ?? [], e.line]);
  lines.push('', '*Feito*');
  if (!byChannel.size) lines.push('• Nada reportado nos canais.');
  for (const [channel, entries] of byChannel) {
    lines.push(`• #${channel} (${entries.length}):`);
    for (const line of entries.slice(-4)) lines.push(`   – ${one(line, 160)}`);
  }
  const wait = [...(approvals ? [`${approvals} aprovação(ões) pendente(s) no terminal/Slack`] : []), ...waiting.map(t => `Pergunta minha: ${one(t, 140)}`),
    ...(commitments?.waiting ?? []).map(t => `Pendência: ${one(t, 160)}`)];
  lines.push('', '*Esperando você*', ...(wait.length ? wait.map(w => `• ${w}`) : ['• Nada.']));
  if (risks) lines.push('', '*Pode dar problema hoje*', ...(risks.length ? risks.slice(0, 10).map(r => `• ${one(r, 220)}`) : ['• Nada previsto.']));
  if (health?.length) lines.push('', '*Produção agora*', ...health.map(h => `\u2022 ${h}`));
  if (pc?.length) lines.push('', '*Este PC*', ...pc.map(h => `\u2022 ${h}`));
  if (quota?.length) lines.push('', '*Cotas dos modelos*', ...quota.map(h => `\u2022 ${one(h, 450)}`));
  if (commitments?.attention.length) lines.push('', `*Compromissos meus atrasados ou parados (${commitments.attention.length})*`, ...commitments.attention.slice(0, 8).map(t => `• ${one(t, 160)}`));
  if (prs.length) {
    lines.push('', `*PRs abertos (${prs.length})*`);
    const ci: Record<string, string> = { SUCCESS: '✅', FAILURE: '❌', ERROR: '❌', PENDING: '⏳', EXPECTED: '⏳', NONE: '·' };
    for (const pr of prs.slice(0, 10)) lines.push(`• ${ci[pr.sig.split(':')[1]!] ?? '·'} <${pr.url}|${pr.url.replace(/^https:\/\/github\.com\//, '').replace('/pull/', '#')}> ${pr.title}`);
  }
  if (briefing) {
    const agenda = briefing.items.filter(i => i.section === 'agenda').slice(0, 8);
    const mail = briefing.items.filter(i => i.section === 'messages' && (i.urgency === 'urgent' || i.urgency === 'high')).slice(0, 5);
    lines.push('', '*Agenda de hoje*', ...(agenda.length ? agenda.map(i => `• ${one(i.title, 140)}`) : ['• Nada na agenda.']));
    if (mail.length) lines.push('', '*E-mails que parecem urgentes*', ...mail.map(i => `• ${one(i.title, 140)}`));
    const off = briefing.sources.filter(s => s.state !== 'ok').map(s => `${s.sourceId} ${s.state}`);
    if (off.length) lines.push(`_Fontes incompletas: ${off.join(', ')}_`);
  } else lines.push('', '_Briefing do Google indisponível agora._');
  return lines.join('\n');
}

export class DailySummary {
  constructor(private readonly owner: () => ReportOwner | undefined, private readonly post: Post, private readonly prs: PrWatch,
    private readonly approvals: () => number, private readonly options: { at?: string; until?: number; now?: () => number; request?: Request; quotaFile?: string } = {}) {}

  /** Posts once a day, the first check after `at` (07:00) and before `until` (noon): a late start skips the day. */
  async maybePost(): Promise<boolean> {
    const owner = this.owner();
    const now = (this.options.now ?? Date.now)();
    const [hh, mm] = (this.options.at ?? '07:00').split(':').map(Number);
    const local = new Date(now);
    const minutes = local.getHours() * 60 + local.getMinutes();
    if (!owner || minutes < hh! * 60 + mm! || local.getHours() >= (this.options.until ?? 12)) return false;
    const today = localDate(now), file = join(owner.dir, DAILY);
    try { if ((JSON.parse(readFileSync(file, 'utf8')) as { date?: string }).date === today) return false; } catch { /* first day */ }
    atomicWrite(file, JSON.stringify({ date: today })); // Before posting: a crash mid-post must not post twice.
    const remote = await assistantInputs(owner, today, this.options.request ?? defaultRequest);
    await this.post(composeSummary({ ...remote, ...withQuota(localInputs(owner.dir, now, this.prs.open(owner.dir)), owner.dir, now, this.options.quotaFile ?? QUOTA_FILE), approvals: this.approvals() }), null);
    return true;
  }
}

/** What the assistant service knows: today's Google briefing and the panel's questions. Both are optional. */
async function assistantInputs(owner: ReportOwner, today: string, request: Request): Promise<Pick<SummaryInputs, 'briefing' | 'waiting'>> {
  let briefing: Briefing | undefined;
  try {
    briefing = await request(owner, '/v1/briefing') as Briefing;
    if (briefing.localDate !== today) briefing = await request(owner, '/v1/briefing', {}, 120_000) as Briefing;
  } catch { briefing = undefined; }
  let waiting: string[] = [];
  try { waiting = ((await request(owner, '/v1/tasks?limit=50')) as { tasks: { status: string; title: string }[] }).tasks.filter(t => t.status === 'needs_input').map(t => t.title); }
  catch { /* the panel is optional */ }
  return { briefing, waiting };
}

/**
 * What this profile recorded on disk (the day's reports, commitments, production health, PRs) and the forecast drawn
 * from it. A new sense adds its section here.
 */
export function localInputs(dir: string, now: number, prs: PrSeen[]): Omit<SummaryInputs, 'briefing' | 'waiting' | 'approvals'> {
  let items: Commitment[] = [];
  let commitments: SummaryInputs['commitments'];
  try { items = readCommitments(dir); commitments = summaryLines(items, now); } catch { commitments = undefined; }
  const health = readHealth(dir), pc = readHealth(dir, PC_FILE);
  const risks = forecast({ commitments: items, prs: prs.map(outlook), health, pc, now });
  return { day: readDay(dir, now - 86_400_000), prs, commitments, health: healthLines(health), pc: healthLines(pc), risks, fixes: fixLines(readFixes(dir), now) };
}

function withQuota<T extends { risks?: string[] }>(inputs: T, dir: string, now: number, file: string): T & { quota: string[]; risks: string[] } {
  return { ...inputs, quota: healthLines(readHealth(dir, QUOTA_HEALTH_FILE)), risks: [...inputs.risks ?? [], ...quotaRisks(readJsonOr<unknown>(file, {}), now)] };
}

/** Timers for the PR watch (every 3 min) and the morning summary (checked every minute), per session. */
export function registerSlackReports(pi: ExtensionAPI, owner: () => ReportOwner | undefined, post: Post, approvals: () => number) {
  const prs = new PrWatch(owner, post);
  const daily = new DailySummary(owner, post, prs, approvals);
  const weekly = new WeeklyScoreboard(owner, post);
  let timers: ReturnType<typeof setInterval>[] = [];
  const warned = new Set<string>();
  /** A report that keeps failing says so once per session, not every pass. */
  const pass = (label: string, run: () => Promise<unknown>) => () => void run().catch(error => {
    if (warned.has(label)) return;
    warned.add(label);
    console.error(`OptChat ${label}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const prPass = pass('PR watch', () => prs.poll());
  pi.on('session_start', () => {
    for (const t of timers) clearInterval(t);
    const first = setTimeout(prPass, 30_000); first.unref?.();
    timers = [first, setInterval(prPass, 3 * 60_000), setInterval(pass('morning summary', () => daily.maybePost()), 60_000),
      setInterval(pass('weekly scoreboard', () => weekly.maybePost()), 5 * 60_000)];
    for (const t of timers) t.unref?.();
  });
  pi.on('session_shutdown', () => { for (const t of timers) clearInterval(t); timers = []; });
  return { prs, daily, weekly };
}
