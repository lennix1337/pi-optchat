#!/usr/bin/env node




import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { defaultManifestPath, readMetricFromFile, recordChange } from './change-manifest.mjs';

import { findingLine, remotePaths, reviewBody, reviewChange } from './ship-review.mjs';

const PR_FIELDS = 'number,url,state,mergeStateStatus,autoMergeRequest,statusCheckRollup,headRefOid,title,body';

const TIMEOUT_MS = { local: 60_000, commit: 1_200_000, push: 180_000, gh: 60_000, create: 120_000 };
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;
const SAFE_GH_ARG = /^[A-Za-z0-9._/,:=-]+$/;
const SAFE_METRIC = /^[A-Za-z0-9._:/-]{1,120}$/;
const EXIT = { queued: 0, merged: 0, synced: 0, pr_open: 0, pushed: 0, dry_run: 0, failed: 1, refused: 2, not_queued: 3, uncertain: 4 };
const FORBIDDEN_HINT = {
  '--force': 'ship não força push', '-f': 'ship não força push', '--force-with-lease': 'ship não força push',
  '--no-verify': 'ship não pula hooks', '--admin': 'merge com --admin é decisão do operador',
};
const USAGE = `uso: node scripts/ship.mjs [-m "assunto"] [-b "descrição" | --body-file ARQ] [caminhos... | --all] [--title "título da PR"] [--pr N] [--no-auto] [--subscriber RUN] [--metric NOME (--before NUM | --metrics-file ARQ) [--direction lower|higher] [--manifest ARQ]] [--direct-main] [--branch NOME] [--base BRANCH] [--wait S] [--dry-run] | --sync
  -m, --message TEXTO  assunto do commit (obrigatório com caminhos ou --all)
  --title TEXTO        título da PR (padrão: o assunto do commit, ou o nome da branch com vários commits)
  -b, --body TEXTO     descrição da PR e corpo do commit: o problema, a mudança, o que falta e a evidência
                       (obrigatória quando a branch ainda não tem PR aberta)
  --body-file ARQ      a mesma descrição, lida de um arquivo
  --all                git add -A antes do commit
  --pr N               só enfileira o auto-merge da PR N (sem commit, push ou PR)
  --no-auto            abre a PR sem enfileirar o auto-merge
  --skip-review MOTIVO pula só o revisor de modelo e registra o motivo na PR
  --allow-rules        permite mudanças em arquivos de regras, mas nunca em segredos
  --subscriber RUN     a PR é de um worker: o CI vermelho volta a ele (o gitwatch roteia pelo id)
  --metric NOME        registra a mudança no manifesto local com a métrica-alvo (fora do controle de versão)
  --before NUM         valor anterior da métrica-alvo (usado com --metric)
  --metrics-file ARQ   lê o valor anterior da métrica-alvo de um JSON (usado com --metric)
  --direction MODO     direção da métrica: lower (padrão) ou higher (inferida de --metrics-file quando disponível)
  --manifest ARQ       caminho do JSON do manifesto (padrão: perfil ativo fora do git)
  --closes-verified    permite fixes/closes #N na descrição: a falha foi reproduzida e a reprodução passa
  --direct-main        envia a branch padrão direto, sem PR
  --branch NOME        estando na branch padrão, cria a branch NOME com as mudanças atuais e envia por ela
  --base BRANCH        base da PR (padrão: branch padrão do origin)
  --wait S             espera até S segundos pelos checks (padrão 20)
  --dry-run            roda a revisão determinística e mostra o plano; não chama o modelo nem altera a branch ou o index
  --sync               depois do merge: vai para a branch padrão, puxa só com fast-forward e apaga a branch local anterior se o git a considera mesclada; num worktree, atualiza o checkout principal e deixa o worktree
saída: "status" final. exit 0 feito · 1 falhou · 2 recusado antes de qualquer efeito · 3 PR aberta sem auto-merge · 4 efeito incerto: reconcilie, não repita`;


class Stop extends Error {
  constructor(status, fields) { super(status); this.status = status; this.fields = fields; }
}
// external: GitHub closing keywords close linked issues when a PR merges.
const CLOSING_KEYWORD = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s+(?:[\w.-]+\/[\w.-]+)?#\d+/i;
const refuse = (error, hint) => new Stop('refused', { error, hint });
const failed = (stage, result, next) => new Stop('failed', { stage, detail: tail(result.err || result.out), next });
const uncertain = (stage, next) => new Stop('uncertain', { stage, next });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const firstLine = text => (text.trim().split(/\r?\n/)[0] ?? '').slice(0, 200);
const tail = text => text.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 300);

const timeoutFor = kind => Number(process.env[`SHIP_${kind.toUpperCase()}_TIMEOUT_MS`] || (kind === 'commit' ? undefined : process.env.SHIP_TIMEOUT_MS)) || TIMEOUT_MS[kind];


const TOON_ESCAPE = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
function toon(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  const quote = text === '' || /^\s|\s$/.test(text) || /^(true|false|null)$/.test(text) || /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(text)
    || /^-(\s|$)/.test(text) || /[:"\\[\]{},\n\r\t]/.test(text);
  return quote ? `"${text.replace(/[\\"\n\r\t]/g, ch => TOON_ESCAPE[ch])}"` : text;
}

const spent = { commit: 0, push: 0, gh: 0 };
const STARTED = Date.now();
const timingOf = () => (Object.values(spent).some(Boolean)
  ? `commit ${spent.commit}ms, push ${spent.push}ms, gh ${spent.gh}ms, total ${Date.now() - STARTED}ms`
  : undefined);

function emit(status, fields) {
  const lines = Object.entries({ status, ...fields, timing: timingOf() })
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${toon(value)}`);
  const code = EXIT[status];

  process.stdout.write(`${lines.join('\n')}\nrc: ${code}\n`);
  return code;
}


function run(file, args, kind, { shell = false, env = process.env, input } = {}) {
  return new Promise(resolve => {
    const began = Date.now();
    const child = execFile(file, args, { cwd: process.cwd(), shell, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: timeoutFor(kind) }, (error, stdout, stderr) => {
      const bucket = kind === 'commit' || kind === 'push' ? kind : file === 'git' ? undefined : 'gh';
      if (bucket) spent[bucket] += Date.now() - began;
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 127) : 0,
        killed: Boolean(error?.killed),
        out: String(stdout),
        err: String(stderr || error?.message || ''),
      });
    });
    if (input !== undefined) {
      child.stdin.on('error', () => {}); // external: gh's exit status reports an early exit even if stdin gets EPIPE.
      child.stdin.end(input);
    }
  });
}
const git = (args, kind = 'local') => run('git', args, kind);

function hasCheckScript() {
  try { return typeof JSON.parse(readFileSync('package.json', 'utf8')).scripts?.check === 'string'; } catch { return false; }
}
// external: Windows .cmd/.bat shims require a shell; Node warns about shell arguments in DEP0190.
let ghFound;
function findGh() {
  if (ghFound) return ghFound;
  const win = process.platform === 'win32';
  const names = win ? ['gh.exe', 'gh.cmd', 'gh.bat'] : ['gh'];
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  for (const dir of (process.env[pathKey] ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = join(dir, name);
      if (existsSync(file)) return (ghFound = { file, shell: /\.(cmd|bat)$/i.test(name) });
    }
  }
  return (ghFound = { file: 'gh', shell: win });
}

function gh(args, kind = 'gh', free, input) {
  const found = findGh();
  if (!args.every(arg => SAFE_GH_ARG.test(arg) || (arg === free && !found.shell))) throw refuse('unsafe_argument', 'argumento fora do formato seguro para o gh');
  return run(found.file, args, kind, { shell: found.shell, input });
}



const DROPPED = /dial tcp|TLS handshake timeout|connectex|connection (?:reset|refused)|i\/o timeout|EOF/i;
async function viewPr(ref) {
  const args = ['pr', 'view', String(ref), '--json', PR_FIELDS];
  let r = await gh(args);
  if (r.code !== 0 && DROPPED.test(r.err)) { await new Promise(done => setTimeout(done, 1500)); r = await gh(args); }
  if (r.code === 0) {
    try { return { pr: JSON.parse(r.out) }; } catch { return { error: { ...r, err: 'gh devolveu JSON inválido' } }; }
  }
  if (/no pull requests? found/i.test(r.err)) return { none: true };
  return { error: r };
}

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
function summarizeChecks(rollup) {
  const checks = rollup ?? [];
  const summary = { total: checks.length, pass: 0, pending: 0, failed: [] };
  for (const check of checks) {
    const name = check.name ?? check.context ?? '?';
    if (check.__typename === 'StatusContext' || (check.state !== undefined && check.status === undefined)) {
      if (['FAILURE', 'ERROR'].includes(check.state)) summary.failed.push(name);
      else if (check.state === 'SUCCESS') summary.pass++;
      else summary.pending++;
    } else if (check.status !== 'COMPLETED') summary.pending++;
    else if (PASSED.has(check.conclusion)) summary.pass++;
    else if (check.conclusion) summary.failed.push(name);
    else summary.pending++;
  }
  return summary;
}
const checksText = summary => (summary.total === 0 ? 'none reported' : `${summary.pass} pass / ${summary.pending} pending / ${summary.failed.length} fail`);

// external: GitHub auto-merge waits for required checks only in BLOCKED state; otherwise it may merge immediately.
function decide(pr) {
  if (pr.state === 'MERGED') return { action: 'merged' };
  if (pr.state !== 'OPEN') return { action: 'stop', reason: 'pr_closed' };
  if (pr.autoMergeRequest) return { action: 'queued' };
  const checks = summarizeChecks(pr.statusCheckRollup);
  if (checks.failed.length) return { action: 'stop', reason: 'checks_failed', detail: checks.failed.slice(0, 5).join(', ') };
  if (pr.mergeStateStatus === 'BLOCKED') return { action: 'enqueue' };
  // external: GitHub refuses to queue auto-merge when nothing remains to wait for.
  if (pr.mergeStateStatus === 'CLEAN' && checks.total > 0 && checks.pending === 0) return { action: 'merge_now' };
  const reason = {
    CLEAN: checks.total ? 'merge_would_be_immediate' : 'checks_not_reported',
    UNSTABLE: 'merge_state_unstable', DIRTY: 'merge_conflict', BEHIND: 'branch_behind_base', DRAFT: 'draft', UNKNOWN: 'merge_state_unknown',
  }[pr.mergeStateStatus] ?? `merge_state_${String(pr.mergeStateStatus).toLowerCase()}`;
  return { action: 'stop', reason };
}


async function settle(number, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  for (;;) {
    const view = await viewPr(number);
    if (view.error || view.none) return view;
    const pr = view.pr;
    const unsettled = pr.state === 'OPEN' && !pr.autoMergeRequest
      && (pr.mergeStateStatus === 'UNKNOWN' || (pr.mergeStateStatus === 'CLEAN' && !pr.statusCheckRollup?.length));
    const left = deadline - Date.now();
    if (!unsettled || left <= 0) return view;
    await sleep(Math.min(1000, left));
  }
}

function classifyEnqueueError(text) {
  if (/clean status/i.test(text)) return 'merge_would_be_immediate';
  if (/auto[- ]?merge/i.test(text) && /not allowed|not enabled|disabled|isn'?t enabled|not available/i.test(text)) return 'auto_merge_disabled';
  return 'auto_merge_refused';
}

async function enqueue(number, head) {
  const q = await gh(['pr', 'merge', String(number), '--squash', '--auto', '--match-head-commit', head]);
  if (!q.killed && q.code !== 0) return { reason: classifyEnqueueError(q.err), detail: firstLine(q.err) };
  const after = await viewPr(number);
  if (after.pr && (after.pr.state === 'MERGED' || after.pr.autoMergeRequest)) return { pr: after.pr };
  if (q.killed) return { uncertain: true };
  return { reason: 'auto_merge_unverified', detail: after.error ? firstLine(after.error.err) : 'gh aceitou, mas a PR não mostra auto-merge', pr: after.pr };
}

async function mergeNow(number, head) {
  const m = await gh(['pr', 'merge', String(number), '--squash', '--delete-branch', '--match-head-commit', head]);
  const after = await viewPr(number);
  if (after.pr?.state === 'MERGED') return { auto: 'merged', pr: after.pr };
  if (m.killed) return { auto: 'uncertain' };
  return { auto: 'not_queued', reason: 'merge_refused', detail: firstLine(m.err), pr: after.pr };
}

async function autoMerge(number, waitSeconds, head) {
  const settled = await settle(number, waitSeconds);
  if (settled.error) return { auto: 'not_queued', reason: 'pr_unreadable', detail: tail(settled.error.err) };
  if (settled.none) return { auto: 'not_queued', reason: 'pr_not_found' };
  if (settled.pr.headRefOid !== head) return { auto: 'not_queued', reason: 'review_head_changed', pr: settled.pr };
  const decision = decide(settled.pr);
  if (decision.action === 'merged') return { auto: 'merged', pr: settled.pr };
  if (decision.action === 'queued') return { auto: 'queued', pr: settled.pr };
  if (decision.action === 'stop') return { auto: 'not_queued', reason: decision.reason, detail: decision.detail, pr: settled.pr };
  if (decision.action === 'merge_now') return mergeNow(number, head);
  const queued = await enqueue(number, head);
  if (queued.uncertain) return { auto: 'uncertain' };
  if (queued.reason) return { auto: 'not_queued', reason: queued.reason, detail: queued.detail, pr: queued.pr };
  return { auto: queued.pr.state === 'MERGED' ? 'merged' : 'queued', pr: queued.pr };
}

function nextFor(reason, number) {
  switch (reason) {
    case 'checks_not_reported': return `quando os checks aparecerem: node scripts/ship.mjs --pr ${number}`;
    case 'checks_failed': return `corrija o CI da PR ${number} e rode: node scripts/ship.mjs --pr ${number}`;
    case 'review_changes': return `corrija os pontos do Revisor e rode: node scripts/ship.mjs --pr ${number}`;
    case 'merge_would_be_immediate':
    case 'merge_state_unstable': return `sem check obrigatório o GitHub não enfileira o auto-merge (repetir --pr não muda isso): espere os checks ficarem verdes (o gitwatch avisa) e mescle com: gh pr merge ${number} --squash --delete-branch`;
    case 'auto_merge_disabled': return 'o repositório desligou o auto-merge: decida com o operador';
    default: return `resolva o motivo e rode: node scripts/ship.mjs --pr ${number}`;
  }
}






let followSubscriber;
function requestFollow(url) {
  const m = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/.exec(url ?? '');
  if (!m) return 'not_requested';
  try {
    const dir = join(process.env.PI_GITWATCH_DIR ?? join(homedir(), '.pi', 'agent', 'gitwatch'), 'follow');
    mkdirSync(dir, { recursive: true });
    const name = `${m[1].replace('/', '__')}#${m[2]}`, tmp = join(dir, `${name}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ repo: m[1], pr: Number(m[2]), ...followSubscriber ? { subscriber: followSubscriber } : {} }));
    renameSync(tmp, join(dir, `${name}.json`));
    return 'requested';
  } catch { return 'request_failed'; }
}

function reportAuto(ctx, result) {
  const pr = result.pr;
  if ((pr?.state ?? 'OPEN') === 'OPEN' && result.auto !== 'merged') ctx.gitwatch = requestFollow(pr?.url ?? ctx.url);
  const common = { ...ctx, state: pr?.state, url: pr?.url ?? ctx.url, checks: pr ? checksText(summarizeChecks(pr.statusCheckRollup)) : undefined };
  if (result.auto === 'queued') return emit('queued', { ...common, auto_merge: 'queued', next: 'gitwatch avisa no CI verde e na fusão; não consulte o gh em loop' });
  if (result.auto === 'merged') return emit('merged', { ...common, auto_merge: 'merged' });
  if (result.auto === 'uncertain') {
    return emit('uncertain', { ...common, stage: 'auto_merge', next: `gh pr view ${ctx.pr} --json autoMergeRequest,state para reconciliar; não repita o merge` });
  }
  return emit('not_queued', { ...common, auto_merge: 'not_queued', reason: result.reason, detail: result.detail, next: nextFor(result.reason, ctx.pr) });
}


async function openPr(branch, base, body, title) {
  const file = (await git(['rev-parse', '--git-path', 'SHIP_PR_BODY'])).out.trim();
  writeFileSync(file, `${body.trim()}\n`);
  const c = await gh(['pr', 'create', ...(title ? ['--title', title] : ['--fill']), '--body-file', file, '--base', base, '--head', branch], 'create', title)
    .finally(() => rmSync(file, { force: true }));
  if (c.killed) {
    const found = await viewPr(branch);
    if (found.pr?.state === 'OPEN') return found.pr;
    throw uncertain('pr_create', `gh pr view ${branch} para reconciliar; não repita o gh pr create`);
  }
  if (c.code) throw failed('pr_create', c, 'a PR não foi aberta: confira o motivo em detail e rode de novo');
  const url = c.out.match(/https:\/\/\S+\/pull\/\d+/)?.[0];
  if (url) return { number: Number(url.match(/(\d+)$/)[1]), url, state: 'OPEN' };
  const found = await viewPr(branch);
  if (found.pr) return found.pr;
  throw uncertain('pr_create', `gh pr view ${branch} para reconciliar; não repita o gh pr create`);
}


async function review(opts, ctx, input) {
  let result;
  try { result = await reviewChange({ ...input, dryRun: opts.dryRun, allowRules: opts.allowRules, skipReason: opts.skipReview }); }
  catch (e) { throw refuse('review_unavailable', firstLine(e.message)); }
  ctx.review = result.verdict;
  if (result.findings.length) ctx.review_findings = result.findings.map(findingLine).join('\n');
  if (result.verdict === 'block') throw new Stop('refused', {
    error: 'review_blocked', review: result.verdict, review_findings: ctx.review_findings,
    hint: 'Revisor bloqueou: remova o problema e revise novamente.',
  });
  return result;
}

async function updatePrReview(pr, result) {
  const body = reviewBody(pr.body, result);
  if (body === (pr.body ?? '').trim()) return;
  const r = await gh(['pr', 'edit', String(pr.number), '--body-file', '-'], 'gh', undefined, `${body}\n`);
  if (r.killed) throw uncertain('pr_edit', `gh pr view ${pr.number} --json body para reconciliar; não repita a edição`);
  if (r.code) throw failed('pr_edit', r, 'não consegui registrar a revisão na PR; auto-merge não foi solicitado');
}

async function autoMergeOnly(opts, ctx) {
  const view = await viewPr(ctx.pr);
  if (view.error) throw failed('pr_lookup', view.error, 'gh pr view falhou antes da revisão');
  if (!view.pr) throw refuse('pr_not_found', 'não encontrei a PR para revisar');
  const pr = view.pr;
  if (pr.state !== 'OPEN') return reportAuto(ctx, pr.state === 'MERGED' ? { auto: 'merged', pr } : { auto: 'not_queued', reason: 'pr_closed', pr });
  const result = await reviewRemotePr(opts, ctx, pr);
  if (opts.dryRun) return emit('dry_run', { ...ctx, plan: `Revisor (prévia determinística) > ${result.verdict === 'changes' ? 'não enfileirar' : 'ver checks para auto-merge'}` });
  if (result.verdict === 'changes' && pr.autoMergeRequest) throw refuse('review_already_queued', 'a PR já tem auto-merge; desative-o antes de prosseguir');
  const same = await viewPr(ctx.pr);
  if (same.pr?.headRefOid !== pr.headRefOid || same.pr.body !== pr.body || same.pr.title !== pr.title) throw refuse('review_head_changed', 'a PR mudou durante a revisão; revise novamente');
  await updatePrReview(pr, result);
  if (result.verdict === 'changes') return reportAuto(ctx, { auto: 'not_queued', reason: 'review_changes', pr });
  return reportAuto(ctx, await autoMerge(ctx.pr, opts.wait, pr.headRefOid));
}


const isCommitSha = sha => typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha);

async function remoteHistory(pr) {
  const repo = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+$/.exec(pr.url ?? '')?.[1];
  if (!repo) throw refuse('review_history_unavailable', 'não consegui identificar o repositório para ler os commits da PR');
  const root = `repos/${repo}`;
  const list = await gh(['api', '--paginate', '--slurp', `${root}/pulls/${pr.number}/commits`]);
  let commits;
  try { if (!list.code) commits = JSON.parse(list.out).flat(); } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
  }
  // external: The GitHub pull-commits endpoint caps results at 250 even when paginated.
  if (!commits?.length || commits.length >= 250 || commits.at(-1)?.sha !== pr.headRefOid
    || commits.some(c => !isCommitSha(c?.sha) || typeof c.commit?.message !== 'string')) {
    throw refuse('review_history_unavailable', 'não consegui confirmar o intervalo completo da PR; se o histórico exceder o limite do GitHub, revise a partir da branch local');
  }
  const patches = [];
  let bytes = 0;
  for (const { sha } of commits) {
    const patch = await gh(['api', `${root}/commits/${sha}`, '--header=Accept:application/vnd.github.diff']);
    bytes += Buffer.byteLength(patch.out);
    if (patch.code || bytes > 16 * 1024 * 1024) throw refuse('review_history_unavailable', 'não consegui ler todos os patches do intervalo da PR; nada foi enviado');
    patches.push(patch.out);
  }
  return { history: patches.join('\n'), commitMessages: commits.map(({ sha, commit }) => ({ sha, message: commit.message })) };
}

async function reviewRemotePr(opts, ctx, pr) {
  if (!isCommitSha(pr.headRefOid)) throw refuse('review_head_unknown', 'não consegui identificar o commit da PR');
  const [patch, names, range] = await Promise.all([gh(['pr', 'diff', String(pr.number)]), gh(['pr', 'diff', String(pr.number), '--name-only']), remoteHistory(pr)]);
  if (patch.code || names.code) throw failed('review_diff', patch.code ? patch : names, 'não consegui ler o diff da PR');
  const paths = [...remotePaths(patch.out, names.out), ...remotePaths(range.history, '')];
  return review(opts, ctx, { ...range, diff: patch.out, paths, body: pr.body, title: pr.title, head: pr.headRefOid, checksHead: pr.headRefOid, checks: pr.statusCheckRollup });
}

async function mainCheckoutOf() {
  const [dir, common, list] = await Promise.all([
    git(['rev-parse', '--path-format=absolute', '--git-dir']),
    git(['rev-parse', '--path-format=absolute', '--git-common-dir']),
    git(['worktree', 'list', '--porcelain']),
  ]);
  if (dir.code || common.code || dir.out.trim() === common.out.trim()) return undefined;
  return /^worktree (.+)$/m.exec(list.out)?.[1]?.trim();
}


async function syncMainCheckout(main, branch, base) {
  const next = `este worktree (${branch}) continua: remova-o a partir do checkout principal (skill worktree-cleanup)`;
  const [onR, dirtyR] = await Promise.all([git(['-C', main, 'symbolic-ref', '--quiet', '--short', 'HEAD']), git(['-C', main, 'status', '--porcelain'])]);
  const on = onR.out.trim();
  const skip = on !== base ? `skipped: on ${on || 'detached HEAD'}` : dirtyR.out.trim() ? 'skipped: dirty' : undefined;
  if (skip) return emit('synced', { branch, main_checkout: skip, next });
  const pull = await git(['-C', main, 'pull', '-q', '--ff-only'], 'push');
  if (pull.code) return emit('synced', { branch, main_checkout: 'skipped: diverged', detail: firstLine(pull.err), next });
  const head = (await git(['-C', main, 'log', '--oneline', '-1'])).out.trim();
  return emit('synced', { branch, head, main_checkout: 'fast-forwarded', local_branch: `kept ${branch}`, next });
}


async function syncAfterMerge(opts, ctx) {
  const [branchR, originR, dirtyR] = await Promise.all([
    git(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
    git(['status', '--porcelain']),
  ]);
  if (dirtyR.code === 128) throw refuse('not_a_git_repo', 'rode dentro de um repositório git');
  if (branchR.code !== 0) throw refuse('detached_head', 'HEAD solto: troque para uma branch antes');
  const branch = branchR.out.trim();
  const base = opts.base ?? (originR.code === 0 ? originR.out.trim().replace(/^origin\//, '') : 'main');
  ctx.branch = branch;
  if (dirtyR.out.trim()) throw refuse('dirty_tree', 'há mudanças não commitadas: commite ou guarde antes de --sync');
  const main = await mainCheckoutOf();
  if (opts.dryRun) return emit('dry_run', { ...ctx, plan: main ? `fetch > pull --ff-only no checkout principal (${main}); este worktree fica` : `switch ${base} > pull --ff-only > branch -d ${branch === base ? '(nada)' : branch}` });
  const fetched = await git(['fetch', '-q', 'origin'], 'push');
  if (fetched.code) throw failed('fetch', fetched, 'git fetch falhou: confira a conexão e rode de novo');
  if (main) return syncMainCheckout(main, branch, base);
  if (branch !== base) {
    const sw = await git(['switch', '-q', base]);
    if (sw.code) throw failed('switch', sw, `não consegui trocar para ${base}`);
  }
  const pull = await git(['pull', '-q', '--ff-only'], 'push');
  if (pull.code) throw failed('pull', pull, `${base} divergiu do origin: resolva à mão, ship não força`);
  const head = (await git(['log', '--oneline', '-1'])).out.trim();
  if (branch === base) return emit('synced', { branch: base, head, local_branch: 'none' });
  const del = await git(['branch', '-d', branch]);
  return emit('synced', { branch: base, head, local_branch: del.code === 0 ? `deleted ${branch}` : `kept ${branch}`, detail: del.code === 0 ? undefined : firstLine(del.err), next: del.code === 0 ? undefined : `a branch ${branch} tem commits fora de ${base}: confira a PR antes de apagar` });
}

async function recordShippedManifest(opts, ctx, details) {
  if (!opts.metric) return;
  try {
    const subject = (opts.title ?? opts.message ?? (await git(['log', '-1', '--format=%s'])).out.trim()) || details.branch;
    const commit = ctx.commit ?? ((await git(['rev-parse', '--short', 'HEAD'])).out.trim() || undefined);
    const targetPath = opts.manifest ?? defaultManifestPath();
    const recorded = recordChange(targetPath, {
      change: subject,
      metric: opts.metric,
      before: opts.before,
      direction: opts.direction,
      unit: opts.unit,
      branch: details.branch,
      commit,
      pr: details.pr,
      url: details.url,
    });
    ctx.manifest = 'recorded';
    ctx.manifest_entry = recorded.entry.id;
  } catch (error) {
    ctx.manifest = 'failed';
    ctx.manifest_error = firstLine(error instanceof Error ? error.message : String(error));
  }
}

const PATCH_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-relative', '--ignore-submodules=none', '--text', '-U0'];

async function reviewGit(args, env = process.env) {
  const r = await run('git', args, 'local', { env });
  if (r.code) throw failed('review_diff', r, 'não consegui preparar o diff completo do Revisor; nada foi enviado');
  return r.out;
}

async function previewTree(opts, head) {
  const original = (await reviewGit(['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();
  const dir = mkdtempSync(join(tmpdir(), 'ship-index-'));
  const index = join(dir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    if (!opts.paths.length && existsSync(original)) copyFileSync(original, index);
    else await reviewGit(['read-tree', head], env);
    if (opts.all || opts.paths.length) await reviewGit(opts.all ? ['add', '-A'] : ['add', '--', ...opts.paths], env);
    return (await reviewGit(['write-tree'], env)).trim();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function reviewSnapshot(opts, ctx, { base, head, existing }) {
  const mergeBase = (await reviewGit(['merge-base', `refs/remotes/origin/${base}`, head])).trim();
  const tree = await previewTree(opts, head);
  const range = `${mergeBase}..${head}`;
  const status = ['--no-renames', '--no-relative', '--name-status', '-z'];
  const [diff, pending, history, names, stagedNames, pastNames, messages] = await Promise.all([
    reviewGit(['diff', ...PATCH_FLAGS, mergeBase, tree, '--']),
    reviewGit(['diff', ...PATCH_FLAGS, head, tree, '--']),
    reviewGit(['log', '--format=', '--diff-merges=first-parent', '-p', ...PATCH_FLAGS, range, '--']),
    reviewGit(['diff', ...status, mergeBase, tree, '--']),
    reviewGit(['diff', ...status, head, tree, '--']),
    reviewGit(['log', '--format=', '--diff-merges=first-parent', '--no-renames', '--no-relative', '--name-only', '--diff-filter=ACMRTUXB', '-z', range, '--']),
    reviewGit(['log', '-z', '--format=%H%x00%B', range, '--']),
  ]);
  const paths = pastNames.split('\0').filter(Boolean).map(file => ({ file }));
  for (const data of [names, stagedNames]) {
    const parts = data.split('\0');
    for (let i = 0; i + 1 < parts.length; i += 2) paths.push({ file: parts[i + 1], deleted: parts[i] === 'D' });
  }
  const commitMessages = [];
  const parts = messages.split('\0');
  for (let i = 0; i + 1 < parts.length; i += 2) commitMessages.push({ sha: parts[i], message: parts[i + 1] });
  const result = await review(opts, ctx, { diff, history: [pending, history].join('\n'), paths, title: opts.title ?? existing?.title ?? opts.message, body: existing?.body ?? opts.body, head: tree === (await reviewGit(['rev-parse', `${head}^{tree}`])).trim() ? head : undefined, checksHead: existing?.headRefOid, checks: existing?.statusCheckRollup, commitMessage: `${opts.message ?? ''}\n${opts.body ?? ''}`, commitMessages });
  return { tree, result };
}

async function shipBranch(opts, ctx) {
  const [branchR, headR, stagedR, originR] = await Promise.all([
    git(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    git(['rev-parse', '--verify', '--quiet', 'HEAD']),
    git(['diff', '--cached', '--name-only']),
    git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
  ]);
  if (branchR.code === 128) throw refuse('not_a_git_repo', 'rode dentro de um repositório git');
  if (branchR.code !== 0) throw refuse('detached_head', 'HEAD solto: crie uma branch (git switch -c NOME)');
  let branch = branchR.out.trim();
  const base = opts.base ?? (originR.code === 0 ? originR.out.trim().replace(/^origin\//, '') : 'main');
  const staged = stagedR.out.trim();
  const selecting = opts.all || opts.paths.length > 0;
  ctx.branch = branch;

  const creating = opts.branch !== undefined && branch !== opts.branch;
  if (creating) {
    if (branch !== base) throw refuse('branch_flag_not_on_base', `--branch só cria a partir da branch padrão (${base}); você está em ${branch}`);
    if ((await git(['rev-parse', '--verify', '--quiet', `refs/heads/${opts.branch}`])).code === 0) throw refuse('branch_exists', `a branch ${opts.branch} já existe: troque para ela e rode sem --branch`);
    branch = opts.branch;
  }
  if (!creating && !opts.directMain && branch === base) {
    const hint = `a branch é ${base}: passe --branch NOME para criar uma, ou --direct-main para enviar direto`;

    if (opts.body !== undefined) throw refuse('default_branch', hint);
    throw new Stop('refused', { error: 'default_branch', also: 'body_required', hint: `${hint}; com --branch, a PR nova também precisa de -b "problema, mudança, pendências e evidência" ou --body-file ARQ` });
  }
  if (opts.directMain && branch !== base) throw refuse('direct_main_not_default', `--direct-main só vale na branch padrão (${base}); você está em ${branch}`);
  if (!opts.directMain && !SAFE_REF.test(branch)) throw refuse('branch_name_unsupported', `nome de branch fora do formato aceito pelo gh: ${branch}`);
  if (!selecting && staged && opts.message === undefined) throw refuse('message_required', 'há mudanças staged: passe -m "assunto"');


  const aheadP = git(['rev-list', '--count', `origin/${base}..HEAD`]);
  const existingP = opts.directMain ? Promise.resolve(undefined) : viewPr(branch);
  if (!opts.directMain && opts.body === undefined) {
    const existing = await existingP;
    if (!existing?.error && existing?.pr?.state !== 'OPEN') {
      throw refuse('body_required', 'a PR nova precisa de descrição: passe -b "problema, mudança, pendências e evidência" ou --body-file ARQ');
    }
  }

  const [ahead, existing] = await Promise.all([aheadP, existingP]);
  if (existing?.error) throw failed('pr_lookup', existing.error, 'gh pr view falhou antes do push: confira a conexão e rode de novo');
  const aheadCount = ahead.code === 0 ? Number(ahead.out) : null;
  const existingOpen = existing?.pr?.state === 'OPEN' ? existing.pr : undefined;
  const head = headR.out.trim();
  if (!head) throw refuse('review_head_unknown', 'não consegui identificar o commit local para revisão');
  const { tree, result } = await reviewSnapshot(opts, ctx, { base, head, existing: existingOpen });
  if (result.verdict === 'changes' && opts.directMain) throw refuse('review_changes_requires_pr', 'Revisor pediu mudanças: abra uma PR, não envie direto à base');
  // external: GitHub can merge a newly pushed head if auto-merge is already enabled.
  if (result.verdict === 'changes' && existingOpen?.autoMergeRequest) throw refuse('review_already_queued', 'a PR já tem auto-merge; desative-o antes de prosseguir');
  if (opts.dryRun) {
    const plan = [
      'Revisor (prévia determinística)',
      creating && `criar branch ${branch}`,
      selecting && (opts.all ? 'stage --all' : `stage ${opts.paths.join(' ')}`),
      'commit',
      opts.directMain ? `push ${base}` : `push ${branch}`,
      !opts.directMain && (existingOpen ? `reusar PR ${existingOpen.number}` : 'abrir PR'),
      opts.metric && `manifesto (${opts.metric}=${opts.before})`,
      !opts.directMain && !opts.noAuto && (result.verdict === 'changes' ? 'não enfileirar' : 'auto-merge'),
    ].filter(Boolean).join(' > ');
    return emit('dry_run', { ...ctx, base, pr: existingOpen?.number, plan });
  }

  if (hasCheckScript()) {
    const check = await run('npm', ['run', '-s', 'check'], 'commit', { shell: process.platform === 'win32' });
    if (check.code) throw failed('check', check, 'npm run check falhou (lint/tipos): corrija antes do push; nada foi commitado');
  }

  if (creating) {
    const sw = await git(['switch', '-c', opts.branch]);
    if (sw.code) throw failed('branch', sw, 'git switch -c recusou: nada foi commitado; confira o nome e o estado do repositório');
    ctx.branch = branch;
  }

  let commit;
  let commitNeeded = !selecting && staged !== '';
  if (selecting) {
    const add = await git(opts.all ? ['add', '-A'] : ['add', '--', ...opts.paths]);
    if (add.code) {
      const locked = /index\.lock/.test(`${add.err}${add.out}`);
      throw failed('stage', add, locked
        ? 'o git está com .git/index.lock: um git ou hook interrompido o deixou. Nada foi commitado. Confira que nenhum processo git/pre-commit está vivo; só então remova o index.lock e rode de novo'
        : 'git add recusou os caminhos: nada foi commitado; confira os nomes');
    }
    commitNeeded = (await git(['diff', '--cached', '--name-only', ...(opts.all ? [] : ['--', ...opts.paths])])).out.trim() !== '';
  }
  if (commitNeeded) {
    const headBefore = headR.out.trim();
    const c = await git(['commit', '-m', opts.message, ...(opts.body ? ['-m', opts.body] : []), ...(selecting && !opts.all ? ['--', ...opts.paths] : [])], 'commit');
    if (c.killed) {
      const head = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'])).out.trim();
      if (head === headBefore || !head) throw uncertain('commit', 'git log -1 para reconciliar; não repita o commit');
      commit = head.slice(0, 7);
    } else if (c.code) {
      throw failed('commit', c, 'o commit foi recusado (hook ou validação): nada foi enviado; corrija e rode de novo com os mesmos caminhos');
    } else {
      commit = c.out.match(/\s([0-9a-f]{7,40})\]/)?.[1]?.slice(0, 7) ?? (await git(['rev-parse', '--short', 'HEAD'])).out.trim();
    }
    ctx.commit = commit;
  }

  if (!commitNeeded && aheadCount === 0 && !existingOpen) {
    if (creating) { await git(['switch', base]); await git(['branch', '-d', branch]); }
    throw refuse('nothing_to_ship', 'nada para commitar, nada à frente da base e nenhuma PR aberta para esta branch');
  }

  const reviewedHead = (await reviewGit(['rev-parse', '--verify', 'HEAD'])).trim();
  const [actualTree, parents] = (await reviewGit(['show', '-s', '--format=%T %P', reviewedHead])).trim().split(/ (?=[0-9a-f])/);
  if (actualTree !== tree || (commitNeeded ? parents !== head : reviewedHead !== head)) {
    throw refuse('review_snapshot_changed', 'o commit mudou após a revisão (por exemplo, um hook): nada foi enviado; revise novamente');
  }
  if (commitNeeded) {
    const message = await reviewGit(['show', '-s', '--format=%B', reviewedHead]);
    try { await review({ ...opts, dryRun: true }, {}, { commitMessages: [{ sha: reviewedHead, message }] }); }
    catch (error) {
      if (!(error instanceof Stop) || error.fields.error !== 'review_blocked') throw error;
      throw new Stop('refused', { ...error.fields, hint: 'A mensagem gravada pelo Git contém um segredo; corrija o commit local. Nada foi enviado.' });
    }
  }
  const target = opts.directMain ? base : branch;
  const p = await git(['push', 'origin', `${reviewedHead}:refs/heads/${target}`], 'push');
  if (p.killed) {
    const remote = (await git(['ls-remote', 'origin', `refs/heads/${target}`])).out.split(/\s/)[0];
    if (!remote || remote !== reviewedHead) throw uncertain('push', `git ls-remote origin refs/heads/${target} para reconciliar; não repita o push`);
    ctx.push = 'sent';
  } else if (p.code) {
    throw failed('push', p, 'o remoto recusou a branch (não forcei): git pull --rebase e rode de novo');
  } else {
    ctx.push = /Everything up-to-date/i.test(`${p.err}${p.out}`) ? 'up_to_date' : 'sent';
  }

  const upstream = await git(['branch', `--set-upstream-to=origin/${target}`, branch]);
  if (upstream.code) ctx.upstream = 'not_set';
  if (opts.directMain) {
    await recordShippedManifest(opts, ctx, { branch: target });
    return emit('pushed', { ...ctx, branch: target });
  }

  const pr = existingOpen ?? await openPr(branch, base, reviewBody(opts.body, result), opts.title);
  if (existingOpen) await updatePrReview(existingOpen, result);
  ctx.pr = pr.number;
  ctx.url = pr.url;
  await recordShippedManifest(opts, ctx, { branch, pr: pr.number, url: pr.url });
  if (result.verdict === 'changes') return reportAuto(ctx, { auto: 'not_queued', reason: 'review_changes', pr });
  if (opts.noAuto) return emit('pr_open', { ...ctx, gitwatch: requestFollow(pr.url), state: pr.state, url: pr.url, auto_merge: 'skipped', next: `node scripts/ship.mjs --pr ${pr.number} quando quiser enfileirar` });
  return reportAuto(ctx, await autoMerge(pr.number, opts.wait, reviewedHead));
}


function parseArgs(argv) {
  const opts = { paths: [], all: false, pr: undefined, noAuto: false, directMain: false, sync: false, branch: undefined, base: undefined, wait: 20, dryRun: false, message: undefined, title: undefined, body: undefined, closesVerified: false, metric: undefined, before: undefined, metricsFile: undefined, direction: undefined, unit: undefined, manifest: undefined, help: false };
  const valueOf = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('-')) throw refuse('missing_value', `${flag} precisa de um valor`);
    return value;
  };
  const numericValueOf = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || (value.startsWith('-') && !/^-\d/.test(value))) throw refuse('missing_value', `${flag} precisa de um número`);
    const parsed = Number(value.trim());
    if (!value.trim() || !Number.isFinite(parsed)) throw refuse('invalid_value', `${flag} pede um número finito`);
    return parsed;
  };
  const digits = (value, flag) => {
    if (!/^\d+$/.test(value)) throw refuse('invalid_value', `${flag} pede um número`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '-m' || arg === '--message') { opts.message = valueOf(arg, i); i++; }
    else if (arg === '-b' || arg === '--body') {

      if (argv[i + 1] === undefined) throw refuse('missing_value', `${arg} precisa de um valor`);
      opts.body = argv[++i];
    }
    else if (arg === '--body-file') {
      const path = valueOf(arg, i); i++;
      try { opts.body = readFileSync(path, 'utf8'); } catch { throw refuse('body_file_unreadable', `não consegui ler ${path}`); }
    }
    else if (arg === '--title') { opts.title = valueOf(arg, i); i++; }
    else if (arg === '--all') opts.all = true;
    else if (arg === '--pr') { opts.pr = digits(valueOf(arg, i), arg); i++; }
    else if (arg === '--no-auto') opts.noAuto = true;
    else if (arg === '--allow-rules') opts.allowRules = true;
    else if (arg === '--skip-review') {
      opts.skipReview = valueOf(arg, i++).trim();
      if (!opts.skipReview) throw refuse('missing_value', '--skip-review exige um motivo explícito');
    }
    else if (arg === '--subscriber') {
      opts.subscriber = valueOf(arg, i); i++;
      if (!/^[A-Za-z0-9._:-]{1,64}$/.test(opts.subscriber)) throw refuse('invalid_value', `${arg} pede até 64 letras, dígitos, ponto, dois-pontos, sublinhado ou hífen`);
    }
    else if (arg === '--metric') {
      opts.metric = valueOf(arg, i); i++;
      if (!SAFE_METRIC.test(opts.metric)) throw refuse('invalid_value', `${arg} pede um nome de métrica válido (sem espaços)`);
    }
    else if (arg === '--before') { opts.before = numericValueOf(arg, i); i++; }
    else if (arg === '--metrics-file') { opts.metricsFile = resolve(valueOf(arg, i)); i++; }
    else if (arg === '--direction') {
      opts.direction = valueOf(arg, i); i++;
      if (opts.direction !== 'lower' && opts.direction !== 'higher') throw refuse('invalid_value', '--direction aceita lower ou higher');
    }
    else if (arg === '--manifest') { opts.manifest = resolve(valueOf(arg, i)); i++; }
    else if (arg === '--closes-verified') opts.closesVerified = true;
    else if (arg === '--sync') opts.sync = true;
    else if (arg === '--direct-main') opts.directMain = true;
    else if (arg === '--branch') {
      opts.branch = valueOf(arg, i); i++;
      if (!SAFE_REF.test(opts.branch)) throw refuse('branch_name_unsupported', `nome de branch fora do formato aceito pelo gh: ${opts.branch}`);
    }
    else if (arg === '--base') {
      opts.base = valueOf(arg, i); i++;
      if (!SAFE_REF.test(opts.base)) throw refuse('base_name_unsupported', `nome de base fora do formato aceito: ${opts.base}`);
    } else if (arg === '--wait') {
      opts.wait = Number(digits(valueOf(arg, i), arg)); i++;
      if (opts.wait > 120) throw refuse('invalid_value', '--wait vai até 120 segundos');
    } else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('-')) throw refuse('unknown_flag', FORBIDDEN_HINT[arg] ?? `flag desconhecida: ${arg} (veja --help)`);
    else opts.paths.push(arg);
  }
  if (opts.help) return opts;
  if ((opts.sync && (opts.skipReview || opts.allowRules)) || (opts.directMain && opts.skipReview)) {
    throw refuse('conflicting_args', '--skip-review exige uma PR para registrar o motivo; --sync não faz revisão');
  }
  const hasManifestOpts = opts.before !== undefined || opts.metricsFile !== undefined || opts.direction !== undefined || opts.manifest !== undefined;
  if (!opts.metric && hasManifestOpts) {
    throw refuse('conflicting_args', '--before, --metrics-file, --direction e --manifest exigem --metric NOME');
  }
  if (opts.sync && (opts.all || opts.paths.length || opts.pr !== undefined || opts.message !== undefined || opts.body !== undefined || opts.directMain || opts.noAuto || opts.branch !== undefined || opts.metric !== undefined)) {
    throw refuse('conflicting_args', '--sync só sincroniza depois do merge (aceita --base e --dry-run)');
  }
  if (opts.all && opts.paths.length) throw refuse('conflicting_args', '--all e caminhos juntos: escolha um');
  if ((opts.all || opts.paths.length) && opts.message === undefined) throw refuse('message_required', 'com caminhos ou --all, passe -m "assunto"');
  if (opts.message !== undefined && !opts.message.trim()) throw refuse('message_required', '-m não pode ser vazio');
  if (opts.title !== undefined && (!opts.title.trim() || /[\r\n]/.test(opts.title))) throw refuse('invalid_value', '--title é uma linha só, não vazia');
  if (opts.body !== undefined && !opts.body.trim()) throw refuse('body_required', 'a descrição (-b/--body-file) não pode ser vazia');
  if (opts.body !== undefined && !opts.closesVerified && CLOSING_KEYWORD.test(opts.body)) {
    throw refuse('closing_keyword', 'a descrição fecha uma issue sozinha (fixes/closes/resolves #N): uma correção ainda não reproduzida usa "refs #N"; com a reprodução vista passar, acrescente --closes-verified');
  }
  if (opts.pr !== undefined && (opts.all || opts.paths.length || opts.message !== undefined || opts.body !== undefined || opts.directMain || opts.noAuto || opts.branch !== undefined || opts.base !== undefined || opts.metric !== undefined)) {
    throw refuse('conflicting_args', '--pr só enfileira o auto-merge de uma PR existente');
  }
  if (opts.directMain && opts.branch !== undefined) throw refuse('conflicting_args', '--direct-main e --branch juntos: escolha um');
  if (opts.directMain && opts.noAuto) throw refuse('conflicting_args', '--direct-main não abre PR: --no-auto não se aplica');
  if (opts.metric !== undefined) {
    if (opts.before !== undefined && opts.metricsFile !== undefined) {
      throw refuse('conflicting_args', '--before e --metrics-file juntos: escolha um');
    }
    if (opts.before === undefined && opts.metricsFile === undefined) {
      throw refuse('before_required', '--metric precisa de --before NUM ou --metrics-file ARQ');
    }
    if (opts.metricsFile !== undefined) {
      let sample;
      try { sample = readMetricFromFile(opts.metricsFile, opts.metric); } catch (error) {
        throw refuse('metric_unavailable', error instanceof Error ? error.message : String(error));
      }
      opts.before = sample.value;
      opts.unit = sample.unit;
      if (opts.direction === undefined && sample.lowerIsBetter !== undefined) {
        opts.direction = sample.lowerIsBetter ? 'lower' : 'higher';
      }
    }
    opts.direction ??= 'lower';
  }
  return opts;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
    followSubscriber = opts.subscriber;
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    process.stderr.write(`${USAGE}\n`);
    return emit(error.status, error.fields);
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const ctx = {};
  try {
    if (opts.title !== undefined && (opts.sync || opts.pr !== undefined || opts.directMain)) throw refuse('conflicting_args', '--title só vale ao abrir uma PR nova');
    if (opts.sync) return await syncAfterMerge(opts, ctx);
    if (opts.pr !== undefined) {
      ctx.pr = Number(opts.pr);
      return await autoMergeOnly(opts, ctx);
    }
    return await shipBranch(opts, ctx);
  } catch (error) {
    if (error instanceof Stop) return emit(error.status, { ...ctx, ...error.fields });
    return emit('failed', { ...ctx, stage: 'internal', detail: firstLine(error instanceof Error ? error.message : String(error)) });
  }
}

process.exitCode = await main(process.argv.slice(2));
