import { predictionWeek } from './predictions.ts';
import { join } from 'node:path';
import { attention, readCommitments } from './commitments.ts';
import { localDate, PRS, type PrSeen, type Post, type ReportOwner } from './slack-reports.ts';
import { weeklyCostLine } from './cost-delivery.ts';
import { logBackgroundFailure } from './exec-log.ts';
import { slackWeek, type SlackWeek } from './slack-metrics.ts';
import { correctionsWeek } from './corrections.ts';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { atomicWrite, envDir, readJsonOr } from './store.ts';






const WEEK_MS = 7 * 86_400_000;
const STATE = 'slack-scoreboard.json';

type Routing = { since: number; woke: number; quiet: number };
type Saved = { week?: string; routing?: Routing; downloads?: number };
/** The product whose traction the weekly post reports: a GitHub `owner/name` and an npm package, set in the profile config (`businessTrack`). */
export type BusinessTrack = { label: string; repo: string; npm: string };
export type Business = { label?: string; downloads: number; stars: number; previous?: number; issues?: { open: number; closedWeek: number } };
export type ScoreInputs = {
  predictions?: { hits: number; total: number };
  /** Wake councils decided this week and how many the debate changed ("Mudou: sim"); undefined without a record. */
  council?: { changed: number; total: number };
  from: number; to: number; slack: SlackWeek;
  corrections: { count: number; recordingSince?: number };
  ruleViolations?: number;
  business?: Business;
  commitments?: { stuck: number; overdue: number };
  /** Gitwatch routing decisions this week; undefined without a baseline from the previous post. */
  routing?: { woke: number; quiet: number };
  merged: { green: number; other: number };
};

const minutes = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}min` : `${Math.floor(m / 60)}h${m % 60 ? `${String(m % 60).padStart(2, '0')}` : ''}`;
};
const day = (at: number) => new Date(at).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });

const partial = (recordingSince: number, from: number) => recordingSince > from ? ` · registro só desde ${day(recordingSince)}` : '';
const correctionsLine = ({ count, recordingSince }: ScoreInputs['corrections'], from: number) => recordingSince === undefined
  ? '• Correções do operador: não medidas ainda (o registro começa com a próxima correção)'
  : `• Possíveis correções do operador: *${count}* (cada uma recebeu lembrete de virar teste ou regra)${partial(recordingSince, from)}`;


function councilWeek(dir: string, from: number, to: number): ScoreInputs['council'] {
  let raw: string;
  try { raw = readFileSync(join(dir, 'council.jsonl'), 'utf8'); } catch { return undefined; }
  const rows = raw.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) as { at?: string; changed?: boolean | null }; } catch { return undefined; } })
    .filter(r => { const at = Date.parse(r?.at ?? ''); return at >= from && at < to; });
  return rows.length ? { changed: rows.filter(r => r?.changed === true).length, total: rows.length } : undefined;
}

export function composeScoreboard({ from, to, slack, corrections, ruleViolations, business, commitments, routing, merged, predictions, council }: ScoreInputs): string {
  const lines = [`📊 *Placar Jarvis* · semana ${day(from)}–${day(to - 1)}`];
  if (slack.recordingSince === undefined) lines.push('• "E aí?" e primeira resposta no Slack: não medidos ainda (o registro começa com a próxima mensagem do operador)');
  else {
    lines.push(`• "E aí?" do operador no Slack: *${slack.nudges}* (meta 0)${partial(slack.recordingSince, from)}`);
    lines.push(slack.medianMs === undefined
    ? `• Primeira resposta no Slack: sem pares mensagem→resposta registrados (${slack.received} recebidas)`
    : `• Primeira resposta no Slack: mediana *${minutes(slack.medianMs)}*, pior ${minutes(slack.worstMs!)} (${slack.answered} de ${slack.received} respondidas${slack.waiting ? `, ${slack.waiting} sem resposta` : ''})`);
  }
  lines.push(correctionsLine(corrections, from));
  lines.push(ruleViolations === undefined ? '• Regras violadas (7d): não medido' : `• Regras violadas (7d): *${ruleViolations}* candidatos (meta 0; detectores aproximados)`);
  lines.push(predictions?.total ? `• Previsões acertadas (7d): *${predictions.hits}* de *${predictions.total}*` : '• Previsões acertadas (7d): não medido');
  lines.push(council ? `• Conselho do wake (7d): mudou minha decisão em *${council.changed}* de *${council.total}*` : '• Conselho do wake (7d): não medido');
  lines.push(business
    ? `• ${business.label ?? 'Produto'}: *${business.downloads}* downloads npm na semana${business.previous === undefined ? '' : ` (${business.downloads >= business.previous ? '+' : '−'}${Math.abs(business.downloads - business.previous)} vs. semana anterior)`}, ${business.stars} estrelas${business.issues ? `, *${business.issues.open}* issues abertas (${business.issues.closedWeek} fechadas na semana)` : ''}`
    : '• Tração do produto: não medida (sem `businessTrack` no perfil, ou npm/GitHub fora do ar)');
  lines.push('• Receita: não medida (sem leitura automática de Stripe/GA4; só o operador decide gasto)');
  lines.push(commitments
    ? `• Pendências minhas travadas agora: *${commitments.stuck}* sem progresso há 24h+, *${commitments.overdue}* atrasadas (meta 0)`
    : '• Pendências: compromissos ilegíveis, não medido');
  if (routing) {
    const total = routing.woke + routing.quiet;
    lines.push(total
      ? `• Eventos do Gitwatch resolvidos sem acordar o modelo: *${routing.quiet} de ${total}* (${Math.round(100 * routing.quiet / total)}%); são decisões de roteamento, não turnos medidos`
      : '• Eventos do Gitwatch: nenhum na semana');
  } else lines.push('• Eventos do Gitwatch sem modelo: sem linha de base ainda (o próximo placar compara com este)');
  lines.push(`• PRs mergeados: *${merged.green}* com CI verde${merged.other ? `, ${merged.other} sem CI verde` : ''} (CI verde não prova o fluxo real)`);
  lines.push('• Ações sem autorização: não medido (há registro de pedidos de aprovação, não auditoria dos efeitos executados)');
  return lines.join('\n');
}

/** This week's numbers from disk, and the Gitwatch counters to save as the next week's baseline. */
export function weekInputs(dir: string, now: number, saved: Saved,
  gitwatchFile = join(envDir('PI_GITWATCH_DIR', '.pi', 'agent', 'gitwatch'), 'state.json'), ruleViolations?: number): { inputs: ScoreInputs; routing?: Routing } {
  const from = now - WEEK_MS;
  let commitments: ScoreInputs['commitments'];
  try {
    const flags = readCommitments(dir).filter(c => c.owner === 'optchat' && c.status !== 'waiting_operator').map(c => attention(c, now)).filter(Boolean) as string[];
    commitments = { overdue: flags.filter(f => f.startsWith('OVERDUE')).length, stuck: flags.filter(f => !f.startsWith('OVERDUE')).length };
  } catch { commitments = undefined; }
  const prs = Object.values(readJsonOr<Record<string, PrSeen>>(join(dir, PRS), {}))
    .filter(p => p.sig.startsWith('MERGED:') && (p.since ?? p.seen) >= from && (p.since ?? p.seen) < now);
  const merged = { green: prs.filter(p => p.sig === 'MERGED:SUCCESS').length, other: prs.filter(p => p.sig !== 'MERGED:SUCCESS').length };
  const current = readJsonOr<{ stats?: Partial<Routing> }>(gitwatchFile, {}).stats;
  const routing = current && Number.isFinite(current.since) && Number.isFinite(current.woke) && Number.isFinite(current.quiet) ? current as Routing : undefined;
  const before = saved.routing;
  const delta = routing && before && before.since === routing.since && routing.woke >= before.woke && routing.quiet >= before.quiet
    ? { woke: routing.woke - before.woke, quiet: routing.quiet - before.quiet } : undefined;
  return { inputs: { predictions: predictionWeek(dir, from, now), council: councilWeek(dir, from, now), from, to: now, slack: slackWeek(dir, from), corrections: correctionsWeek(dir, from), ruleViolations, commitments, routing: delta, merged }, routing };
}

/** Traction of the configured product from public endpoints: npm downloads of the last week, GitHub stars and, when the search API answers, open and weekly-closed issues. Undefined when npm or the repo read fails. */
export async function fetchBusiness(track: BusinessTrack, get: (url: string) => Promise<Response> = url => fetch(url, { signal: AbortSignal.timeout(10_000) }), now = Date.now()): Promise<Omit<Business, 'previous'> | undefined> {
  const json = async <T>(url: string) => {
    const res = await get(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return await res.json() as T;
  };
  const count = async (query: string) => (await json<{ total_count?: number }>(`https://api.github.com/search/issues?per_page=1&q=${encodeURIComponent(`repo:${track.repo} is:issue ${query}`)}`)).total_count;
  try {
    const since = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
    const [npm, repo, open, closedWeek] = await Promise.all([
      json<{ downloads?: number }>(`https://api.npmjs.org/downloads/point/last-week/${track.npm}`),
      json<{ stargazers_count?: number }>(`https://api.github.com/repos/${track.repo}`),
      count('state:open').catch(() => undefined),
      count(`closed:>=${since}`).catch(() => undefined),
    ]);
    if (!Number.isFinite(npm.downloads) || !Number.isFinite(repo.stargazers_count)) return undefined;
    const issues = Number.isFinite(open) && Number.isFinite(closedWeek) ? { issues: { open: open!, closedWeek: closedWeek! } } : {};
    return { label: track.label, downloads: npm.downloads!, stars: repo.stargazers_count!, ...issues };
  } catch { return undefined; }
}

/** Candidate rule violations of the last 7 days, scanned in a child process: the sessions are hundreds of MB. */
export function scanRuleViolations(env: NodeJS.ProcessEnv = process.env): Promise<number | undefined> {
  const script = fileURLToPath(new URL('../scripts/correction-scan.mjs', import.meta.url));
  const args = ['--experimental-transform-types', '--no-warnings', script, '--since', '7d'];
  return new Promise(resolve => execFile(process.execPath, args, { env, timeout: 120_000, maxBuffer: 1 << 20, windowsHide: true }, (error, stdout) => {
    if (error) { console.error('Correction rules scan failed:', error.message); return resolve(undefined); }
    try { resolve((JSON.parse(stdout.trim().split('\n').at(-1)!) as { count: number; afterGuard?: number }[]).reduce((sum, rule) => sum + (rule.afterGuard ?? rule.count), 0)); }
    catch { resolve(undefined); }
  }));
}

async function configuredBusiness(dir: string): Promise<Omit<Business, 'previous'> | undefined> {
  const track = readJsonOr<{ businessTrack?: Partial<BusinessTrack> }>(join(dir, 'config.json'), {}).businessTrack;
  if (!track || typeof track.label !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(track.repo ?? '') || !/^(@[\w.-]+\/)?[\w.-]+$/.test(track.npm ?? '')) return undefined;
  return fetchBusiness(track as BusinessTrack);
}

export class WeeklyScoreboard {
  private scanning = false;
  constructor(private readonly owner: () => ReportOwner | undefined, private readonly post: Post,
    private readonly options: { weekday?: number; at?: number; until?: number; now?: () => number; gitwatchFile?: string; scan?: () => Promise<number | undefined>; business?: (dir: string) => Promise<Omit<Business, 'previous'> | undefined>; cost?: typeof weeklyCostLine } = {}) {}

  /** Posts once a week, the first check on `weekday` (Monday) between `at` (09h) and `until` (noon) local time. */
  async maybePost(): Promise<boolean> {
    const owner = this.owner();
    const now = (this.options.now ?? Date.now)();
    const local = new Date(now);
    if (!owner || local.getDay() !== (this.options.weekday ?? 1) || local.getHours() < (this.options.at ?? 9) || local.getHours() >= (this.options.until ?? 12)) return false;
    const file = join(owner.dir, STATE), saved = readJsonOr<Saved>(file, {}), week = localDate(now);
    if (saved.week === week) return false;
    if (this.scanning) return false;
    this.scanning = true;
    try {
      const violations = await (this.options.scan ?? scanRuleViolations)();
      const { inputs, routing } = weekInputs(owner.dir, now, saved, this.options.gitwatchFile, violations);
      const traction = await (this.options.business ?? configuredBusiness)(owner.dir);
      if (traction) inputs.business = { ...traction, previous: saved.downloads };
      const cost = await (this.options.cost ?? weeklyCostLine)(owner.dir, now).catch(error => {
        logBackgroundFailure(owner.dir, 'weekly-cost', error);
        return 'Custo de API por entrega: fontes indisponíveis nesta semana.';
      });
      atomicWrite(file, JSON.stringify({ week, ...routing ? { routing } : {}, ...traction ? { downloads: traction.downloads } : saved.downloads === undefined ? {} : { downloads: saved.downloads } }));
      await this.post(composeScoreboard(inputs) + (cost ? `\n• ${cost}` : ''), 'harness');
      return true;
    } finally { this.scanning = false; }
  }
}
