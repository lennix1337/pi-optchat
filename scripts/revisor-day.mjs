#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { findingLine, remotePaths, reviewChange } from './ship-review.mjs';
import { IncompletePrHistory, remoteHistory } from './ship-pr-history.mjs';

const args = process.argv.slice(2);
const repoAt = args.indexOf('--repo');
const repo = repoAt === -1 ? undefined : args.splice(repoAt, 2)[1];
const model = args.includes('--model');
if (model) args.splice(args.indexOf('--model'), 1);
const [day] = args;
const parsed = /^\d{4}-\d{2}-\d{2}$/.test(day ?? '') ? new Date(`${day}T00:00:00Z`) : new Date(NaN);
if (args.length !== 1 || !Number.isFinite(+parsed) || parsed.toISOString().slice(0, 10) !== day
  || (repoAt !== -1 && !/^[\w.-]+\/[\w.-]+$/.test(repo ?? ''))) {
  console.error('Uso: node scripts/revisor-day.mjs AAAA-MM-DD [--repo DONO/REPO] [--model] (dia em UTC)');
  process.exit(2);
}

function gh(args) {
  return execFileSync('gh', [...args, ...(repo && args[0] === 'pr' ? ['--repo', repo] : [])], {
    encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

try {
  const prs = JSON.parse(gh(['pr', 'list', '--state', 'merged', '--search', `merged:${day}`, '--limit', '1000', '--json', 'number,url,title,body,mergedAt,headRefOid,statusCheckRollup']));
  let reviewed = 0, count = 0, errors = 0;
  console.log(`Revisor — ${day} UTC (${model ? 'pré-checagem + modelo' : 'pré-checagem sem modelo'})`);
  for (const pr of prs) {
    if (!pr.mergedAt?.startsWith(`${day}T`) || !Number.isSafeInteger(pr.number) || pr.number < 1) continue;
    try {
      const diff = gh(['pr', 'diff', String(pr.number)]);
      const range = await remoteHistory(pr, args => {
        try { return gh(args); } catch (error) { throw new IncompletePrHistory({ cause: error }); }
      });
      const paths = [...remotePaths(diff, gh(['pr', 'diff', String(pr.number), '--name-only'])), ...remotePaths(range.history, '')];
      const result = await reviewChange({ ...range, diff, paths, title: pr.title, body: pr.body, head: pr.headRefOid, checksHead: pr.headRefOid, checks: pr.statusCheckRollup, merged: true, dryRun: !model });
      reviewed++;
      for (const finding of result.findings) {
        console.log(`- PR #${pr.number}: ${findingLine(finding)}`);
        count++;
      }
    } catch (error) {
      errors++;
      const finding = error instanceof IncompletePrHistory
        ? '[review_history_unavailable] histórico incompleto → confira o acesso aos commits ou revise a partir da branch local.'
        : 'revisão indisponível → confira o acesso ao diff e a configuração do Revisor.';
      console.error(`- PR #${pr.number}: ${finding}`);
    }
  }
  if (prs.length >= 1000) { errors++; console.error('A busca atingiu o limite do GitHub; o relatório pode estar incompleto.'); }
  console.log(`${reviewed} PR(s) revisada(s); ${count} achado(s); ${errors} erro(s).`);
  if (errors) process.exitCode = 1;
} catch {
  console.error('Revisor: não consegui listar as PRs. Confira o repositório e o acesso do gh.');
  process.exitCode = 1;
}
