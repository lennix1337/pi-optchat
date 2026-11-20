#!/usr/bin/env node
// Read-only baseline: seven Brasília calendar days including today; heuristics are not an audit.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSessions, tallyScoreboard, scoreboardLine } from '../src/intervention-scoreboard.ts';

const now = Date.now();
const since = new Date(now - 6 * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const query = 'query($q:String!, $cursor:String){search(query:$q,type:ISSUE,first:100,after:$cursor){issueCount pageInfo{hasNextPage endCursor} nodes{... on PullRequest{mergedAt}}}}';
const gh = args => new Promise((resolve, reject) => execFile('gh', args, { timeout: 30000, maxBuffer: 4 << 20, windowsHide: true }, (err, stdout) => err ? reject(err) : resolve(stdout)));
try {
  const prs = [];
  let cursor = '';
  do {
    const raw = await gh(['api', 'graphql', '-f', `query=${query}`, '-f', `q=owner:lennix1337 is:pr is:merged merged:>=${since}`, '-f', `cursor=${cursor}`]);
    const search = JSON.parse(raw).data.search;
    if (search.issueCount > 1000) throw new Error('GitHub search excedeu o limite de 1000 PRs; contagem incompleta');
    if (!Array.isArray(search.nodes) || search.nodes.some(pr => typeof pr.mergedAt !== 'string')) throw new Error('Resposta GitHub incompleta');
    prs.push(...search.nodes);
    cursor = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : '';
    if (search.pageInfo.hasNextPage && !cursor) throw new Error('GitHub não forneceu cursor');
  } while (cursor);
  const result = tallyScoreboard(readSessions(join(homedir(), '.pi', 'agent', 'sessions')), prs, now);
  console.log(JSON.stringify(result));
  console.log(scoreboardLine(result));
} catch (error) {
  console.error(`Placar indisponível: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
