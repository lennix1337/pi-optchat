import { brasiliaDayTime } from './pc-health.ts';
import { readDay as readRuns, type DayRun } from './home-day.ts';
import { lastInboundAt, readUnansweredMessages } from './slack-metrics.ts';
import { latestPerLink, readDay as readPosts } from './slack-reports.ts';

/**
 * What the operator missed while away, for the `resumo` command: everything recorded since his last message that
 * reached the agent (the posts Jarvis sent, with their links, and the runs that worked), and the one next action the
 * records point to. Only recorded data: nothing is asked of a model or of GitHub, so it answers at once and never
 * invents. Without a recorded message it covers the last 24 hours and says so.
 */
export interface Recap { since: number; known: boolean; works: number; workMs: number; posts: string[]; nextAction: string }

const DAY_MS = 86_400_000;
const LISTED = 6;
const SPACE = /\s+/g;

const duration = (ms: number) => { const m = Math.round(ms / 60_000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`; };

/** The one thing to do next, from what was posted: a red CI first, then a green PR waiting for merge, then an unanswered message. */
export function nextAction(posts: readonly string[], waiting: number): string {
  const red = posts.find(line => line.startsWith('❌'));
  if (red) return `ver o CI vermelho: ${red.replace(/^❌[^·]*·\s*/u, '')}`;
  const green = posts.find(line => line.startsWith('✅ CI verde'));
  if (green) return `revisar e mergear: ${green.replace(/^✅[^·]*·\s*/u, '')}`;
  if (waiting > 0) return `${waiting === 1 ? 'há 1 mensagem sua sem resposta' : `há ${waiting} mensagens suas sem resposta`}; responda ou mande *status*`;
  return 'nada pendente nos registros (isso não prova que nada precisa de você)';
}

export function buildRecap(input: { now: number; lastMessage: number | undefined; runs: readonly DayRun[]; posts: readonly { at: number; line: string }[]; waiting: number }): Recap {
  const known = input.lastMessage !== undefined;
  const since = input.lastMessage ?? input.now - DAY_MS;
  const runs = input.runs.filter(r => r.end >= since);
  const posts = latestPerLink(input.posts.filter(p => p.at >= since).map(p => ({ at: p.at, channel: null, line: p.line }))).map(p => p.line);
  return { since, known, works: runs.length, workMs: runs.reduce((total, r) => total + Math.max(0, r.end - Math.max(r.start, since)), 0), posts, nextAction: nextAction(posts, input.waiting) };
}

export function renderRecap(recap: Recap, now: number): string {
  const when = `${brasiliaDayTime(recap.since)} (há ${duration(now - recap.since)})`;
  const head = recap.known ? `*Desde sua última mensagem* · ${when}` : `*Últimas 24h* · sem mensagem sua registrada; desde ${when}`;
  const work = recap.works ? `${recap.works} trabalho${recap.works === 1 ? '' : 's'} · ${duration(recap.workMs)} trabalhando` : 'nenhum trabalho registrado';
  const sent = recap.posts.length ? `${recap.posts.length} aviso${recap.posts.length === 1 ? '' : 's'} enviado${recap.posts.length === 1 ? '' : 's'}` : 'nenhum aviso enviado';
  const shown = recap.posts.slice(-LISTED).reverse().map(line => `• ${line.replace(SPACE, ' ')}`);
  return [head, `${work} · ${sent}`, ...shown, ...recap.posts.length > LISTED ? [`… e mais ${recap.posts.length - LISTED} antes destes`] : [], `*Próximo passo:* ${recap.nextAction}`].join('\n');
}

/** The recap from the profile's records at `dir`. */
export function awayRecap(dir: string, now: number): string {
  const lastMessage = lastInboundAt(dir);
  const since = lastMessage ?? now - DAY_MS;
  const waiting = readUnansweredMessages(dir).reduce((n, m) => n + (m.count ?? 1), 0);
  return renderRecap(buildRecap({ now, lastMessage, runs: readRuns(dir, now), posts: readPosts(dir, since), waiting }), now);
}
