import { join } from 'node:path';
import { attention, readCommitments } from './commitments.ts';
import { localDate, PRS, type PrSeen, type Post, type ReportOwner } from './slack-reports.ts';
import { slackWeek, type SlackWeek } from './slack-metrics.ts';
import { atomicWrite, envDir, readJsonOr } from './store.ts';

/**
 * The weekly Jarvis scoreboard in #harness: did the operator have to chase ("e aí?"), how fast Slack answered, what
 * got stuck, how many events never woke the model, what merged green. Every number comes from a local record; a metric
 * with no record says so instead of showing zero.
 */
const WEEK_MS = 7 * 86_400_000;
const STATE = 'slack-scoreboard.json';

type Routing = { since: number; woke: number; quiet: number };
type Saved = { week?: string; routing?: Routing };
export type ScoreInputs = {
  from: number; to: number; slack: SlackWeek;
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

export function composeScoreboard({ from, to, slack, commitments, routing, merged }: ScoreInputs): string {
  const lines = [`📊 *Placar Jarvis* · semana ${day(from)}–${day(to - 1)}`];
  if (slack.recordingSince === undefined) lines.push('• "E aí?" e primeira resposta no Slack: não medidos ainda (o registro começa com a próxima mensagem do operador)');
  else {
    const partial = slack.recordingSince > from ? ` · registro só desde ${day(slack.recordingSince)}` : '';
    lines.push(`• "E aí?" do operador no Slack: *${slack.nudges}* (meta 0)${partial}`);
    lines.push(slack.medianMs === undefined
    ? `• Primeira resposta no Slack: sem pares mensagem→resposta registrados (${slack.received} recebidas)`
    : `• Primeira resposta no Slack: mediana *${minutes(slack.medianMs)}*, pior ${minutes(slack.worstMs!)} (${slack.answered} de ${slack.received} respondidas${slack.waiting ? `, ${slack.waiting} sem resposta` : ''})`);
  }
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
  gitwatchFile = join(envDir('PI_GITWATCH_DIR', '.pi', 'agent', 'gitwatch'), 'state.json')): { inputs: ScoreInputs; routing?: Routing } {
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
  return { inputs: { from, to: now, slack: slackWeek(dir, from), commitments, routing: delta, merged }, routing };
}

export class WeeklyScoreboard {
  constructor(private readonly owner: () => ReportOwner | undefined, private readonly post: Post,
    private readonly options: { weekday?: number; at?: number; until?: number; now?: () => number; gitwatchFile?: string } = {}) {}

  /** Posts once a week, the first check on `weekday` (Monday) between `at` (09h) and `until` (noon) local time. */
  async maybePost(): Promise<boolean> {
    const owner = this.owner();
    const now = (this.options.now ?? Date.now)();
    const local = new Date(now);
    if (!owner || local.getDay() !== (this.options.weekday ?? 1) || local.getHours() < (this.options.at ?? 9) || local.getHours() >= (this.options.until ?? 12)) return false;
    const file = join(owner.dir, STATE), saved = readJsonOr<Saved>(file, {}), week = localDate(now);
    if (saved.week === week) return false;
    const { inputs, routing } = weekInputs(owner.dir, now, saved, this.options.gitwatchFile);
    atomicWrite(file, JSON.stringify({ week, ...routing ? { routing } : {} })); // Before posting: a crash mid-post must not post twice.
    await this.post(composeScoreboard(inputs), 'harness');
    return true;
  }
}
