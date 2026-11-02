import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Extra senses for the 07:00 briefing, read at posting time: what GitHub says happened around the operator in the
 * last day (closed work, review requests, notifications, new comments by others on his PRs) and what the harness
 * cost. Each source fails on its own and is named in the summary, never silently dropped.
 */
export type Gh = (args: string[]) => Promise<string>;
export type Activity = {
  closed: { repo: string; number: number; title: string; url: string; merged: boolean; kind: 'pr' | 'issue' }[];
  reviews: { repo: string; number: number; title: string; url: string }[];
  mentions: { repo: string; title: string; reason: string }[];
  comments: { repo: string; number: number; title: string; url: string; who: string[] }[];
  failed: string[];
};

/** Notification reasons worth his attention; CI runs, state changes and his own activity are already elsewhere. */
const REASONS = new Set(['mention', 'team_mention', 'review_requested', 'assign', 'comment']);
const SEARCH = `query($q:String!){search(query:$q,type:ISSUE,first:40){nodes{__typename ... on PullRequest{number title url state repository{nameWithOwner}
 comments(last:10){nodes{author{login} createdAt}} reviews(last:10){nodes{author{login} createdAt}}}
 ... on Issue{number title url state repository{nameWithOwner}}}}}`;
type Node = { __typename: string; number: number; title: string; url: string; state: string; repository: { nameWithOwner: string };
  comments?: { nodes: { author: { login: string } | null; createdAt: string }[] }; reviews?: { nodes: { author: { login: string } | null; createdAt: string }[] } };

const search = async (gh: Gh, q: string): Promise<Node[]> =>
  (JSON.parse(await gh(['api', 'graphql', '-f', `query=${SEARCH}`, '-f', `q=${q}`])) as { data: { search: { nodes: Node[] } } }).data.search.nodes.filter(n => n?.number);

export async function githubActivity(gh: Gh, now: number, me: string): Promise<Activity> {
  const since = new Date(now - 86_400_000), day = since.toISOString().slice(0, 10);
  const out: Activity = { closed: [], reviews: [], mentions: [], comments: [], failed: [] };
  const step = async (name: string, run: () => Promise<void>) => { try { await run(); } catch { out.failed.push(name); } };
  await Promise.all([
    step('GitHub fechados', async () => {
      for (const n of await search(gh, `involves:@me closed:>=${day}`))
        out.closed.push({ repo: n.repository.nameWithOwner, number: n.number, title: n.title, url: n.url, merged: n.state === 'MERGED', kind: n.__typename === 'Issue' ? 'issue' : 'pr' });
    }),
    step('GitHub revisões', async () => {
      for (const n of await search(gh, 'is:open is:pr review-requested:@me'))
        out.reviews.push({ repo: n.repository.nameWithOwner, number: n.number, title: n.title, url: n.url });
    }),
    step('GitHub comentários', async () => {
      for (const n of await search(gh, 'is:open is:pr author:@me')) {
        const who = [...n.comments?.nodes ?? [], ...n.reviews?.nodes ?? []]
          .filter(c => c.author && c.author.login !== me && !/\[bot\]$/.test(c.author.login) && Date.parse(c.createdAt) >= since.getTime())
          .map(c => c.author!.login);
        if (who.length) out.comments.push({ repo: n.repository.nameWithOwner, number: n.number, title: n.title, url: n.url, who: [...new Set(who)] });
      }
    }),
    step('GitHub notificações', async () => {
      const list = JSON.parse(await gh(['api', '-X', 'GET', 'notifications', '-f', `since=${since.toISOString()}`, '-f', 'participating=true'])) as
        { reason: string; subject: { title: string }; repository: { full_name: string } }[];
      for (const n of list) if (REASONS.has(n.reason))
        out.mentions.push({ repo: n.repository.full_name, title: n.subject.title, reason: n.reason });
    }),
  ]);
  // A PR already listed as commented, awaiting review or closed is not repeated as a notification.
  // A thread already closed is reported once, under what closed.
  const seen = new Set([...out.comments, ...out.reviews, ...out.closed].map(p => `${p.repo}:${p.title}`));
  out.mentions = out.mentions.filter(m => !seen.has(`${m.repo}:${m.title}`));
  return out;
}

const REASON: Record<string, string> = { mention: 'te mencionaram', team_mention: 'mencionaram seu time', review_requested: 'pediram sua revisão',
  assign: 'atribuído a você', comment: 'comentário novo', author: 'atividade no seu', state_change: 'mudou de estado' };
const short = (repo: string) => repo.split('/')[1] ?? repo;

/** Lines for "Precisa de você" (reviews, comments by others, notifications) and "Fechado nas últimas 24h". */
export function activityLines(a: Activity): { needs: string[]; closed: string[] } {
  const needs = [
    ...a.reviews.map(r => `👀 Revisão pedida: <${r.url}|${short(r.repo)}#${r.number}> ${r.title}`),
    ...a.comments.map(c => `💬 ${c.who.join(', ')} comentou em <${c.url}|${short(c.repo)}#${c.number}> ${c.title}`),
    ...a.mentions.slice(0, 5).map(m => `🔔 ${REASON[m.reason] ?? m.reason}: ${short(m.repo)} · ${m.title}`),
    ...a.mentions.length > 5 ? [`🔔 +${a.mentions.length - 5} notificações no GitHub`] : [],
  ];
  const byRepo = new Map<string, string[]>();
  for (const c of a.closed) byRepo.set(short(c.repo), [...byRepo.get(short(c.repo)) ?? [],
    `${c.kind === 'issue' ? '📌' : c.merged ? '🟣' : '⚪'} <${c.url}|#${c.number}> ${c.title}${c.kind === 'pr' && !c.merged ? ' (fechado sem merge)' : ''}`]);
  const closed = [...byRepo].flatMap(([repo, items]) => [`• ${repo} (${items.length}):`, ...items.slice(0, 6).map(i => `   – ${i}`), ...items.length > 6 ? [`   – +${items.length - 6}`] : []]);
  return { needs, closed };
}

/** What the harness spent in the last 24h, from the profile's usage.jsonl, by model. Reads only the file's tail. */
export function harnessCost(dir: string, now: number, file = 'usage.jsonl'): string | undefined {
  let text: string;
  try { text = readFileSync(join(dir, file), 'utf8'); } catch { return undefined; }
  const since = now - 86_400_000, by = new Map<string, number>();
  let total = 0;
  for (const line of text.slice(-8 << 20).split('\n')) {
    if (!line.includes('"cost"')) continue;
    try {
      const e = JSON.parse(line) as { date?: string | number; model?: string; usage?: { cost?: { total?: number } } };
      const at = typeof e.date === 'number' ? e.date : Date.parse(e.date ?? '');
      const usd = e.usage?.cost?.total ?? 0;
      if (!(at >= since) || !usd) continue;
      const m = (e.model ?? '?').replace(/^claude-/, '');
      by.set(m, (by.get(m) ?? 0) + usd); total += usd;
    } catch { /* a torn line */ }
  }
  if (!total) return undefined;
  const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, v]) => `${m} US$${v.toFixed(2)}`).join(', ');
  return `US$${total.toFixed(2)} nas últimas 24h (${top})`;
}
