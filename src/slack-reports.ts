import { donePredictions } from './predictions.ts';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { activityLines, githubActivity, harnessCost, type Activity } from './briefing-sources.ts';
import { logBackgroundFailure } from './exec-log.ts';
import { loadEconomy } from './quota-load.ts';
import { accountLines, weeklyLines } from './quota-format.ts';
import { tallySession } from './machine-turn-share.ts';
import { wakeYield } from './wake-yield.ts';

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


const DAY = 'slack-day.jsonl';
type DayEntry = { at: number; channel: string | null; line: string };
export function logSent(dir: string, channel: string | null, text: string, now = Date.now()): void {
  if (/^(?:⏸|☀️)/u.test(text)) return;
  appendRecent<DayEntry>(join(dir, DAY), { at: now, channel, line: one(text.replace(/^\*Wake\* · /, ''), 200) }, 256 * 1024, 3 * 86_400_000);
}
export const readDay = (dir: string, since: number): DayEntry[] => readJsonl<DayEntry>(join(dir, DAY), e => e.at >= since);

/** One PR runs through opened, CI green and merged: the day's list keeps its latest post, so four lines are four things done. */
export function latestPerLink(day: DayEntry[]): DayEntry[] {
  const key = (e: DayEntry) => /<(https:\/\/github\.com\/[^|>]+)\|/.exec(e.line)?.[1];
  const last = new Map<string, number>();
  day.forEach((e, i) => { const k = key(e); if (k) last.set(k, i); });
  return day.filter((e, i) => { const k = key(e); return !k || last.get(k) === i; });
}


type Gh = (args: string[]) => Promise<string>;
const DROPPED = /dial tcp|TLS handshake timeout|connectex|connection (?:reset|refused)|i\/o timeout|EOF/i;
const defaultGh: Gh = args => new Promise((resolve, reject) => execFile('gh', args, { timeout: 30_000, windowsHide: true, maxBuffer: 4 << 20 }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr })) : resolve(stdout)));
const PR_QUERY = `query($q:String!){search(query:$q,type:ISSUE,first:50){nodes{... on PullRequest{number title url state isDraft createdAt updatedAt repository{name nameWithOwner} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;
type PrNode = { number: number; title: string; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; isDraft: boolean; createdAt: string; updatedAt?: string; repository: { name: string; nameWithOwner: string }; commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] } };
/** `since`: when `sig` was first seen; `flips`: how often CI went from green to red or back; `verdict`: the last green/red seen. */
export type PrSeen = { sig: string; seen: number; title: string; url: string; channel: string; since?: number; flips?: number; verdict?: 'green' | 'red'; updated?: number };

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
export const outlook = (p: PrSeen): PrOutlook => ({ title: p.title, url: p.url, ci: p.sig.split(':')[1] ?? 'NONE', since: p.since ?? p.seen, flips: p.flips ?? 0, ...(p.updated ? { updated: p.updated } : {}) });

export class PrWatch {
  constructor(private readonly owner: () => ReportOwner | undefined, private readonly post: Post, private readonly gh: Gh = defaultGh, private readonly now: () => number = Date.now) {}

  open(dir: string): PrSeen[] {
    return Object.values(this.read(dir)).filter(p => p.sig.startsWith('OPEN:'));
  }

  /** One pass; the first ever only records what exists, so a fresh install posts nothing. */
  async poll(): Promise<number> {
    const owner = this.owner();

    if (!owner || !existsSync(join(owner.dir, 'assistant.json'))) return 0;
    const now = this.now();
    const since = new Date(now - 2 * 86_400_000).toISOString().slice(0, 10);

    const read = async (q: string) => {
      const args = ['api', 'graphql', '-f', `query=${PR_QUERY}`, '-f', `q=${q}`];

      try { return await this.gh(args); }
      catch (error) {
        const e = error as { message?: string; stderr?: string };
        if (!DROPPED.test(`${e?.stderr ?? ''} ${e?.message ?? ''}`)) throw error;
        await new Promise(done => setTimeout(done, 1500));
        return this.gh(args);
      }
    };
    const search = async (q: string) => ((JSON.parse(await read(q)) as { data?: { search?: { nodes?: PrNode[] } } })
      .data?.search?.nodes ?? []).filter(n => typeof n?.number === 'number');
    const byKey = new Map<string, PrNode>();

    const [open, updated] = await Promise.all([search('is:pr author:@me is:open'), search(`is:pr author:@me updated:>=${since}`)]);
    for (const n of [...open, ...updated]) byKey.set(`${n.repository.nameWithOwner}#${n.number}`, n);
    const nodes = [...byKey.values()];
    let known: Record<string, PrSeen> | undefined;
    try { known = JSON.parse(readFileSync(join(owner.dir, PRS), 'utf8')); } catch { known = undefined; }

    const next: Record<string, PrSeen> = Object.fromEntries(Object.entries(known ?? {})
      .filter(([key, p]) => now - p.seen < PR_KEEP_MS && (byKey.has(key) || !p.sig.startsWith('OPEN:'))));
    let posted = 0;
    for (const pr of nodes) {
      const channel = projectOfRepo(pr.repository.name);
      if (!channel) continue;
      const key = `${pr.repository.nameWithOwner}#${pr.number}`;
      const ci = pr.commits.nodes[0]?.commit.statusCheckRollup?.state ?? 'NONE';
      const sig = `${pr.state}:${ci}`;
      const change = known && prChange(known[key]?.sig, { state: pr.state, ci, createdAt: Date.parse(pr.createdAt) }, now);
      next[key] = { sig, seen: now, title: one(pr.title, 120), url: pr.url, channel, ...nextSeen(known?.[key], sig, now), ...(pr.updatedAt ? { updated: Date.parse(pr.updatedAt) } : {}) };
      if (!change) continue;
      try { await this.post(`${change} · <${pr.url}|${pr.repository.name}#${pr.number}> ${one(pr.title, 120)}${pr.isDraft && pr.state === 'OPEN' ? ' (draft)' : ''}`, channel, `pr:${key}`); posted++; }
      catch {   }
    }
    atomicWrite(join(owner.dir, PRS), JSON.stringify(next));
    return posted;
  }

  private read(dir: string): Record<string, PrSeen> {
    try { return JSON.parse(readFileSync(join(dir, PRS), 'utf8')); } catch { return {}; }
  }
}


type Briefing = { localDate: string; items: { section: string; title: string; urgency: string }[]; sources: { sourceId: string; state: string }[] };
type Request = (owner: ReportOwner, path: string, body?: unknown, timeoutMs?: number) => Promise<unknown>;
const defaultRequest: Request = (owner, path, body, timeoutMs = 20_000) => assistantRequest(assistantConfig(owner), path, body, timeoutMs);
const DAILY = 'slack-daily.json';
export const localDate = (at: number) => new Date(at).toLocaleDateString('sv-SE');

export type SummaryInputs = { predictions?: { text: string; link: string }[]; day: DayEntry[]; waiting: string[]; prs: PrSeen[]; briefing?: Briefing; approvals: number; commitments?: { waiting: string[]; attention: string[] }; health?: string[]; pc?: string[]; quota?: string[]; accounts?: string[]; risks?: string[]; fixes?: string[]; github?: Activity; cost?: string; weekly?: string[]; opusMachineShare?: string; wakeWithoutDelivery?: string; interventionScoreboard?: string };
/**
 * The 07:00 briefing, most actionable first: what needs him today, a short plan, what closed in the last day, what
 * the harness did and noticed, then state (production, PC, quotas, PRs, agenda) and its cost. A source that failed
 * is named at the end.
 */
export function composeSummary({ day, waiting, prs, briefing, approvals, commitments, health, pc, quota, accounts, risks, fixes, github, cost, weekly, predictions, opusMachineShare, wakeWithoutDelivery, interventionScoreboard }: SummaryInputs): string {
  const lines = ['☀️ *Bom dia! Resumo das últimas 24h*'];
  const act = github ? activityLines(github) : { needs: [], closed: [] };
  const wait = [...(approvals ? [`${approvals} aprovação(ões) pendente(s) no terminal/Slack`] : []), ...waiting.map(t => `Pergunta minha: ${one(t, 140)}`),
    ...(commitments?.waiting ?? []).map(t => `Pendência: ${one(t, 160)}`), ...act.needs.map(n => one(n, 260))];
  lines.push('', '*Precisa de você hoje*', ...(wait.length ? wait.map(w => `• ${w}`) : ['• Nada.']));
  const plan = [...wait.slice(0, 3), ...(risks ?? []).slice(0, Math.max(0, 3 - wait.length))];
  if (plan.length) lines.push('', '*Plano do dia*', ...plan.map((p, i) => `${i + 1}. ${one(p.replace(/<([^|>]+)\|([^>]+)>/g, '$2'), 160)}`));
  if (act.closed.length) lines.push('', '*Fechado nas últimas 24h*', ...act.closed);
  if (predictions?.length) lines.push('', '*Antecipei*', ...predictions.map(p => `• Você ia pedir: ${one(p.text, 200)} — feito: ${p.link}`));
  if (fixes?.length) lines.push('', '*Resolvi sozinho*', ...fixes.slice(-8).map(f => `• ${one(f, 200)}`));
  const byChannel = new Map<string, string[]>();
  for (const e of latestPerLink(day)) if (e.channel) byChannel.set(e.channel, [...byChannel.get(e.channel) ?? [], e.line]);
  lines.push('', '*Feito*');
  if (!byChannel.size) lines.push('• Nada reportado nos canais.');
  for (const [channel, entries] of byChannel) {
    lines.push(`• #${channel} (${entries.length}):`);
    for (const line of entries.slice(-4)) lines.push(`   – ${one(line, 160)}`);
  }
  if (risks) lines.push('', '*Pode dar problema hoje*', ...(risks.length ? risks.slice(0, 10).map(r => `• ${one(r, 220)}`) : ['• Nada previsto.']));
  if (health?.length) lines.push('', '*Produção agora*', ...health.map(h => `\u2022 ${h}`));
  if (pc?.length) lines.push('', '*Este PC*', ...pc.map(h => `\u2022 ${h}`));
  if (quota?.length || accounts?.length) lines.push('', '*Cotas dos modelos*', ...quota?.map(h => `\u2022 ${one(h, 450)}`) ?? [], ...accounts?.map(h => one(h, 450)) ?? []);
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
  if (cost || weekly?.length || opusMachineShare || wakeWithoutDelivery) lines.push('', '*Custo do harness*', ...cost ? [`• ${cost}`] : [], ...weekly?.map(h => `• ${one(h, 450)}`) ?? [], ...opusMachineShare ? [`• ${opusMachineShare}`] : [], ...wakeWithoutDelivery ? [`• ${wakeWithoutDelivery}`] : []);
  if (interventionScoreboard) lines.push('', `• ${interventionScoreboard}`);
  if (github?.failed.length) lines.push(`_Fontes incompletas: ${github.failed.join(', ')}_`);
  return lines.join('\n');
}

function scanInterventions(): Promise<string> {
  const script = fileURLToPath(new URL('../scripts/scoreboard.mjs', import.meta.url));
  return new Promise(resolve => execFile(process.execPath, [script], { timeout: 120_000, maxBuffer: 1 << 20, windowsHide: true }, (error, stdout) => {
    if (error) { console.error('Intervention scoreboard failed:', error.message); resolve('Intervenções por PR: indisponível (sessões ou GitHub).'); return; }
    const line = stdout.trim().split('\n').at(-1);
    resolve(line?.startsWith('Intervenções: ') ? line : 'Intervenções por PR: resposta inválida.');
  }));
}

export class DailySummary {
  constructor(private readonly owner: () => ReportOwner | undefined, private readonly post: Post, private readonly prs: PrWatch,
    private readonly approvals: () => number, private readonly options: { at?: string; until?: number; now?: () => number; request?: Request; quotaFile?: string; gh?: Gh; sessionsDir?: string; interventionScoreboard?: () => Promise<string> } = {}) {}

  /** Posts once a day, the first check after `at` (07:00) and before `until` (noon): a late start skips the day. */
  async maybePost(): Promise<boolean> {
    const owner = this.owner();
    const now = (this.options.now ?? Date.now)();
    const [hh, mm] = (this.options.at ?? '07:00').split(':').map(Number);
    const local = new Date(now);
    const minutes = local.getHours() * 60 + local.getMinutes();
    if (!owner || minutes < hh! * 60 + mm! || local.getHours() >= (this.options.until ?? 12)) return false;
    const today = localDate(now), file = join(owner.dir, DAILY);
    try { if ((JSON.parse(readFileSync(file, 'utf8')) as { date?: string }).date === today) return false; } catch {   }
    atomicWrite(file, JSON.stringify({ date: today }));
    const remote = await assistantInputs(owner, today, this.options.request ?? defaultRequest);
    const github = await githubInputs(this.options.gh ?? defaultGh, now);
    const interventionScoreboard = await (this.options.interventionScoreboard ?? scanInterventions)();
    const sent = await this.post(composeSummary({ interventionScoreboard, ...remote, ...withQuota(localInputs(owner.dir, now, this.prs.open(owner.dir)), owner.dir, now, this.options.quotaFile ?? QUOTA_FILE),
      approvals: this.approvals(), github, cost: harnessCost(owner.dir, now), ...sessionShares(this.options.sessionsDir ?? join(homedir(), '.pi', 'agent', 'sessions'), now), ...quotaSection(owner.dir, now, this.options.quotaFile ?? QUOTA_FILE) }), null);

    const ts = (sent as { ts?: unknown } | undefined)?.ts;
    atomicWrite(file, JSON.stringify({ date: today, sentAt: (this.options.now ?? Date.now)(), ...(typeof ts === 'string' ? { ts } : {}) }));
    return true;
  }
}

/** A failed or incomplete session scan cannot support a trustworthy share. */
export function sessionShares(root: string, now: number): Pick<SummaryInputs, 'opusMachineShare' | 'wakeWithoutDelivery'> {
  let total = 0, machine = 0, wakes = 0, without = 0;
  const scan = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const jsonl = readFileSync(path, 'utf8');
        const { models } = tallySession(jsonl, now - 86_400_000, undefined, now);
        const yieldSummary = wakeYield(jsonl, now - 86_400_000, now).summary;
        wakes += yieldSummary.wakes;
        without += yieldSummary.without;
        for (const [model, counts] of models) if (model.startsWith('claude-opus')) {
          machine += counts.machine;
          total += counts.human + counts.machine + counts.heartbeat + counts.unknown + counts.worker;
        }
      }
    }
  };
  try { scan(root); } catch { return {}; }
  return {
    opusMachineShare: total ? `Opus em avisos de máquina: ${machine}/${total} (${Number((100 * machine / total).toFixed(1))}%) — meta: perto de 0 depois do #447` : undefined,
    wakeWithoutDelivery: wakes ? `Wakes sem entrega: ${without}/${wakes} (${Math.round(100 * without / wakes)}%) — um wake sem PR/commit/spawn conta como vazio` : undefined,
  };
}


async function githubInputs(gh: Gh, now: number): Promise<Activity> {
  let me: string;
  try { me = (await gh(['api', 'user', '--jq', '.login'])).trim(); }
  catch { return { closed: [], reviews: [], mentions: [], comments: [], failed: ['GitHub (gh sem login)'] }; }
  return githubActivity(gh, now, me);
}


async function assistantInputs(owner: ReportOwner, today: string, request: Request): Promise<Pick<SummaryInputs, 'briefing' | 'waiting'>> {
  let briefing: Briefing | undefined;
  try {
    briefing = await request(owner, '/v1/briefing') as Briefing;
    if (briefing.localDate !== today) briefing = await request(owner, '/v1/briefing', {}, 120_000) as Briefing;
  } catch { briefing = undefined; }
  let waiting: string[] = [];
  try { waiting = ((await request(owner, '/v1/tasks?limit=50')) as { tasks: { status: string; title: string }[] }).tasks.filter(t => t.status === 'needs_input').map(t => t.title); }
  catch {   }
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
  return { predictions: donePredictions(dir, localDate(now)), day: readDay(dir, now - 86_400_000), prs, commitments, health: healthLines(health), pc: healthLines(pc), risks, fixes: fixLines(readFixes(dir), now) };
}


function quotaSection(dir: string, now: number, cacheFile: string): Pick<SummaryInputs, 'accounts' | 'weekly'> {
  try {
    const state = readJsonOr<unknown>(cacheFile, {}), economy = loadEconomy({ dir, now, weeks: 2, cacheFile });
    return { accounts: accountLines(state, now, economy), weekly: weeklyLines(economy) };
  } catch (error) { logBackgroundFailure(dir, 'quota-economy', error); return {}; }
}

function withQuota<T extends { risks?: string[] }>(inputs: T, dir: string, now: number, file: string): T & { quota: string[]; risks: string[] } {
  return { ...inputs, quota: healthLines(readHealth(dir, QUOTA_HEALTH_FILE)), risks: [...inputs.risks ?? [], ...quotaRisks(readJsonOr<unknown>(file, {}), now)] };
}

export const BACKGROUND_FAILURE_TYPE = 'optchat-background-failure';

/** Failures of the timed reports. Every one goes to the exec log; the agent hears of each job once per session, in a hidden
 * message at its next turn. Nothing is printed: console output lands over the terminal UI the operator is reading. */
export class BackgroundFailures {
  private readonly warned = new Set<string>();
  private pending: string[] = [];
  constructor(private readonly dir: () => string | undefined) {}
  pass(label: string, run: () => Promise<unknown>) {
    return () => void run().catch(error => {
      logBackgroundFailure(this.dir(), label, error);
      if (this.warned.has(label)) return;
      this.warned.add(label);
      this.pending.push(`OptChat ${label} failed (later failures of this job go only to exec-log.jsonl): ${one(error instanceof Error ? error.message : String(error), 600)}`);
    });
  }
  take() {
    if (!this.pending.length) return undefined;
    const content = `${this.pending.splice(0).join('\n')}\nMachine notice, not the operator's words.`;
    return { message: { customType: BACKGROUND_FAILURE_TYPE, content, display: false } };
  }
}

/** Timers for the PR watch (every 3 min) and the morning summary (checked every minute), per session. */
export function registerSlackReports(pi: ExtensionAPI, owner: () => ReportOwner | undefined, post: Post, approvals: () => number) {
  const prs = new PrWatch(owner, post);
  const daily = new DailySummary(owner, post, prs, approvals);
  const weekly = new WeeklyScoreboard(owner, post);
  let timers: ReturnType<typeof setInterval>[] = [];
  const failures = new BackgroundFailures(() => owner()?.dir);
  const pass = failures.pass.bind(failures);
  pi.on('before_agent_start', () => failures.take());
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
