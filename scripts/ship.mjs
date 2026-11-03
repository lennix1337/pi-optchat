#!/usr/bin/env node
// ship: the PR flow in one call. It commits the selected paths, pushes the branch, opens the PR (or reuses the open
// one), queues auto-merge only where GitHub waits for the checks, and reports the state. Stdout is one flat
// `key: value` object (AXI-compact; a TOON subset for flat scalar objects); stderr carries usage only. It never forces
// a push, never skips hooks and never merges with --admin.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const PR_FIELDS = 'number,url,state,mergeStateStatus,autoMergeRequest,statusCheckRollup';
const TIMEOUT_MS = { local: 60_000, push: 180_000, gh: 60_000, create: 120_000 };
const SAFE_REF = /^[A-Za-z0-9._/-]+$/;
const SAFE_GH_ARG = /^[A-Za-z0-9._/,:=-]+$/;
const EXIT = { queued: 0, merged: 0, pr_open: 0, pushed: 0, dry_run: 0, failed: 1, refused: 2, not_queued: 3, uncertain: 4 };
const FORBIDDEN_HINT = {
  '--force': 'ship não força push', '-f': 'ship não força push', '--force-with-lease': 'ship não força push',
  '--no-verify': 'ship não pula hooks', '--admin': 'merge com --admin é decisão do operador',
};
const USAGE = `uso: node scripts/ship.mjs [-m "assunto"] [caminhos... | --all] [--pr N] [--no-auto] [--direct-main] [--base BRANCH] [--wait S] [--dry-run]
  -m, --message TEXTO  assunto do commit (obrigatório com caminhos ou --all)
  --all                git add -A antes do commit
  --pr N               só enfileira o auto-merge da PR N (sem commit, push ou PR)
  --no-auto            abre a PR sem enfileirar o auto-merge
  --direct-main        envia a branch padrão direto, sem PR
  --base BRANCH        base da PR (padrão: branch padrão do origin)
  --wait S             espera até S segundos pelos checks (padrão 20)
  --dry-run            mostra o plano, sem efeitos
saída: "status" final. exit 0 feito · 1 falhou · 2 recusado antes de qualquer efeito · 3 PR aberta sem auto-merge · 4 efeito incerto: reconcilie, não repita`;

/** A stop with a final status and its fields. Refusals stop before any effect; uncertain stops name the stage to reconcile. */
class Stop extends Error {
  constructor(status, fields) { super(status); this.status = status; this.fields = fields; }
}
const refuse = (error, hint) => new Stop('refused', { error, hint });
const failed = (stage, result, next) => new Stop('failed', { stage, detail: tail(result.err || result.out), next });
const uncertain = (stage, next) => new Stop('uncertain', { stage, next });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const firstLine = text => (text.trim().split(/\r?\n/)[0] ?? '').slice(0, 200);
const tail = text => text.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 300);
const timeoutFor = kind => Number(process.env.SHIP_TIMEOUT_MS) || TIMEOUT_MS[kind];

// --- output: a flat key: value object; values that could be misread (colons, quotes, numeric text) are quoted ---
const TOON_ESCAPE = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' };
function toon(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  const quote = text === '' || /^\s|\s$/.test(text) || /^(true|false|null)$/.test(text) || /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(text)
    || /^-(\s|$)/.test(text) || /[:"\\[\]{},\n\r\t]/.test(text);
  return quote ? `"${text.replace(/[\\"\n\r\t]/g, ch => TOON_ESCAPE[ch])}"` : text;
}
function emit(status, fields) {
  const lines = Object.entries({ status, ...fields })
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${toon(value)}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return EXIT[status];
}

// --- processes: git and gh run without a shell; gh falls back to one only when it is a .cmd shim that execFile cannot start alone ---
function run(file, args, kind, shell = false) {
  return new Promise(resolve => {
    execFile(file, args, { cwd: process.cwd(), shell, windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: timeoutFor(kind) }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 127) : 0,
        killed: Boolean(error?.killed),
        out: String(stdout),
        err: String(stderr || error?.message || ''),
      });
    });
  });
}
const git = (args, kind = 'local') => run('git', args, kind);
// The first gh on PATH, directory by directory as the shell would pick it. Only a .cmd/.bat shim needs a shell (arguments passed SAFE_GH_ARG,
// so it cannot reinterpret them); a real executable runs without cmd.exe and without Node's DEP0190 warning.
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
function gh(args, kind = 'gh') {
  if (!args.every(arg => SAFE_GH_ARG.test(arg))) throw refuse('unsafe_argument', 'argumento fora do formato seguro para o gh');
  const found = findGh();
  return run(found.file, args, kind, found.shell);
}

// --- pull requests and checks ---
async function viewPr(ref) {
  const r = await gh(['pr', 'view', String(ref), '--json', PR_FIELDS]);
  if (r.code === 0) {
    try { return { pr: JSON.parse(r.out) }; } catch { return { error: { ...r, err: 'gh devolveu JSON inválido' } }; }
  }
  if (/no pull requests? found/i.test(r.err)) return { none: true };
  return { error: r };
}

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
function summarizeChecks(rollup = []) {
  const summary = { total: rollup.length, pass: 0, pending: 0, failed: [] };
  for (const check of rollup) {
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

/**
 * Whether auto-merge may be queued. GitHub queues an --auto request and waits for the required checks only when the
 * merge state is BLOCKED; in any other state (CLEAN with no checks, or checks that are not required) it would merge at
 * once without the validation the operator asks for. A failing check always stops the queue.
 */
function decide(pr) {
  if (pr.state === 'MERGED') return { action: 'merged' };
  if (pr.state !== 'OPEN') return { action: 'stop', reason: 'pr_closed' };
  if (pr.autoMergeRequest) return { action: 'queued' };
  const checks = summarizeChecks(pr.statusCheckRollup);
  if (checks.failed.length) return { action: 'stop', reason: 'checks_failed', detail: checks.failed.slice(0, 5).join(', ') };
  if (pr.mergeStateStatus === 'BLOCKED') return { action: 'enqueue' };
  const reason = {
    CLEAN: checks.total ? 'merge_would_be_immediate' : 'checks_not_reported',
    UNSTABLE: 'merge_state_unstable', DIRTY: 'merge_conflict', BEHIND: 'branch_behind_base', DRAFT: 'draft', UNKNOWN: 'merge_state_unknown',
  }[pr.mergeStateStatus] ?? `merge_state_${String(pr.mergeStateStatus).toLowerCase()}`;
  return { action: 'stop', reason };
}

/** Reads the PR until GitHub has settled its state, up to `waitSeconds`: UNKNOWN, or CLEAN before any check shows up. */
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
    await sleep(Math.min(3000, left));
  }
}

function classifyEnqueueError(text) {
  if (/clean status/i.test(text)) return 'merge_would_be_immediate';
  if (/auto[- ]?merge/i.test(text) && /not allowed|not enabled|disabled|isn'?t enabled|not available/i.test(text)) return 'auto_merge_disabled';
  return 'auto_merge_refused';
}

async function enqueue(number) {
  const q = await gh(['pr', 'merge', String(number), '--squash', '--auto']);
  if (!q.killed && q.code !== 0) return { reason: classifyEnqueueError(q.err), detail: firstLine(q.err) };
  const after = await viewPr(number);
  if (after.pr && (after.pr.state === 'MERGED' || after.pr.autoMergeRequest)) return { pr: after.pr };
  if (q.killed) return { uncertain: true };
  return { reason: 'auto_merge_unverified', detail: after.error ? firstLine(after.error.err) : 'gh aceitou, mas a PR não mostra auto-merge', pr: after.pr };
}

async function autoMerge(number, waitSeconds) {
  const settled = await settle(number, waitSeconds);
  if (settled.error) return { auto: 'not_queued', reason: 'pr_unreadable', detail: tail(settled.error.err) };
  if (settled.none) return { auto: 'not_queued', reason: 'pr_not_found' };
  const decision = decide(settled.pr);
  if (decision.action === 'merged') return { auto: 'merged', pr: settled.pr };
  if (decision.action === 'queued') return { auto: 'queued', pr: settled.pr };
  if (decision.action === 'stop') return { auto: 'not_queued', reason: decision.reason, detail: decision.detail, pr: settled.pr };
  const queued = await enqueue(number);
  if (queued.uncertain) return { auto: 'uncertain' };
  if (queued.reason) return { auto: 'not_queued', reason: queued.reason, detail: queued.detail, pr: queued.pr };
  return { auto: queued.pr.state === 'MERGED' ? 'merged' : 'queued', pr: queued.pr };
}

function nextFor(reason, number) {
  switch (reason) {
    case 'checks_not_reported': return `quando os checks aparecerem: node scripts/ship.mjs --pr ${number}`;
    case 'checks_failed': return `corrija o CI da PR ${number} e rode: node scripts/ship.mjs --pr ${number}`;
    case 'merge_would_be_immediate': return `o GitHub faria o merge na hora: espere os checks e rode node scripts/ship.mjs --pr ${number}`;
    case 'auto_merge_disabled': return 'o repositório desligou o auto-merge: decida com o operador';
    default: return `resolva o motivo e rode: node scripts/ship.mjs --pr ${number}`;
  }
}

/**
 * Asks pi-gitwatch's poller to follow the PR (a file in its `follow/` folder, the format of pi-gitwatch
 * src/follow-requests.ts). Its bash hook never sees this process's `gh pr create`, so without this the merge of a
 * shipped PR woke nobody (03/11: #91, #92, #94).
 */
function requestFollow(url) {
  const m = /github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/.exec(url ?? '');
  if (!m) return 'not_requested';
  try {
    const dir = join(process.env.PI_GITWATCH_DIR ?? join(homedir(), '.pi', 'agent', 'gitwatch'), 'follow');
    mkdirSync(dir, { recursive: true });
    const name = `${m[1].replace('/', '__')}#${m[2]}`, tmp = join(dir, `${name}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ repo: m[1], pr: Number(m[2]) }));
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

async function openPr(branch, base) {
  const c = await gh(['pr', 'create', '--fill', '--base', base, '--head', branch], 'create');
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

// --- the flow ---
async function autoMergeOnly(opts, ctx) {
  if (opts.dryRun) return emit('dry_run', { ...ctx, plan: 'ver checks > enfileirar auto-merge se o GitHub esperar os checks' });
  return reportAuto(ctx, await autoMerge(ctx.pr, opts.wait));
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
  const branch = branchR.out.trim();
  const base = opts.base ?? (originR.code === 0 ? originR.out.trim().replace(/^origin\//, '') : 'main');
  const staged = stagedR.out.trim();
  const selecting = opts.all || opts.paths.length > 0;
  ctx.branch = branch;

  if (!opts.directMain && branch === base) throw refuse('default_branch', `a branch é ${base}: crie uma branch, ou passe --direct-main para enviar direto`);
  if (opts.directMain && branch !== base) throw refuse('direct_main_not_default', `--direct-main só vale na branch padrão (${base}); você está em ${branch}`);
  if (!opts.directMain && !SAFE_REF.test(branch)) throw refuse('branch_name_unsupported', `nome de branch fora do formato aceito pelo gh: ${branch}`);
  if (!selecting && staged && opts.message === undefined) throw refuse('message_required', 'há mudanças staged: passe -m "assunto"');

  // The read-only lookups overlap with staging and the commit; their results are needed only before a push or a PR.
  const aheadP = git(['rev-list', '--count', `origin/${base}..HEAD`]);
  const existingP = opts.directMain ? Promise.resolve(undefined) : viewPr(branch);

  if (opts.dryRun) {
    const [, existing] = await Promise.all([aheadP, existingP]);
    if (existing?.error) throw failed('pr_lookup', existing.error, 'gh pr view falhou: confira a conexão e rode de novo');
    const existingOpen = existing?.pr?.state === 'OPEN' ? existing.pr : undefined;
    const plan = [
      selecting && (opts.all ? 'stage --all' : `stage ${opts.paths.join(' ')}`),
      'commit',
      opts.directMain ? `push ${base}` : `push ${branch}`,
      !opts.directMain && (existingOpen ? `reusar PR ${existingOpen.number}` : 'abrir PR'),
      !opts.directMain && !opts.noAuto && 'auto-merge',
    ].filter(Boolean).join(' > ');
    return emit('dry_run', { ...ctx, base, pr: existingOpen?.number, plan });
  }

  let commit;
  let commitNeeded = !selecting && staged !== '';
  if (selecting) {
    const add = await git(opts.all ? ['add', '-A'] : ['add', '--', ...opts.paths]);
    if (add.code) throw failed('stage', add, 'git add recusou os caminhos: nada foi commitado; confira os nomes');
    commitNeeded = (await git(['diff', '--cached', '--name-only', ...(opts.all ? [] : ['--', ...opts.paths])])).out.trim() !== '';
  }
  if (commitNeeded) {
    const headBefore = headR.out.trim();
    const c = await git(['commit', '-m', opts.message, ...(selecting && !opts.all ? ['--', ...opts.paths] : [])]);
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

  const [ahead, existing] = await Promise.all([aheadP, existingP]);
  if (existing?.error) throw failed('pr_lookup', existing.error, 'gh pr view falhou antes do push: confira a conexão e rode de novo');
  const aheadCount = ahead.code === 0 ? Number(ahead.out) : null;
  const existingOpen = existing?.pr?.state === 'OPEN' ? existing.pr : undefined;
  if (!commitNeeded && aheadCount === 0 && !existingOpen) {
    throw refuse('nothing_to_ship', 'nada para commitar, nada à frente da base e nenhuma PR aberta para esta branch');
  }

  const target = opts.directMain ? base : branch;
  const p = await git(['push', '-u', 'origin', `HEAD:refs/heads/${target}`], 'push');
  if (p.killed) {
    const remote = (await git(['ls-remote', 'origin', `refs/heads/${target}`])).out.split(/\s/)[0];
    const local = (await git(['rev-parse', '--verify', '--quiet', 'HEAD'])).out.trim();
    if (!remote || remote !== local) throw uncertain('push', `git ls-remote origin refs/heads/${target} para reconciliar; não repita o push`);
    ctx.push = 'sent';
  } else if (p.code) {
    throw failed('push', p, 'o remoto recusou a branch (não forcei): git pull --rebase e rode de novo');
  } else {
    ctx.push = /Everything up-to-date/i.test(`${p.err}${p.out}`) ? 'up_to_date' : 'sent';
  }

  if (opts.directMain) return emit('pushed', { ...ctx, branch: target });

  const pr = existingOpen ?? await openPr(branch, base);
  ctx.pr = pr.number;
  ctx.url = pr.url;
  if (opts.noAuto) return emit('pr_open', { ...ctx, gitwatch: requestFollow(pr.url), state: pr.state, url: pr.url, auto_merge: 'skipped', next: `node scripts/ship.mjs --pr ${pr.number} quando quiser enfileirar` });
  return reportAuto(ctx, await autoMerge(pr.number, opts.wait));
}

// --- arguments and entry ---
function parseArgs(argv) {
  const opts = { paths: [], all: false, pr: undefined, noAuto: false, directMain: false, base: undefined, wait: 20, dryRun: false, message: undefined, help: false };
  const valueOf = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('-')) throw refuse('missing_value', `${flag} precisa de um valor`);
    return value;
  };
  const digits = (value, flag) => {
    if (!/^\d+$/.test(value)) throw refuse('invalid_value', `${flag} pede um número`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '-m' || arg === '--message') { opts.message = valueOf(arg, i); i++; }
    else if (arg === '--all') opts.all = true;
    else if (arg === '--pr') { opts.pr = digits(valueOf(arg, i), arg); i++; }
    else if (arg === '--no-auto') opts.noAuto = true;
    else if (arg === '--direct-main') opts.directMain = true;
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
  if (opts.all && opts.paths.length) throw refuse('conflicting_args', '--all e caminhos juntos: escolha um');
  if ((opts.all || opts.paths.length) && opts.message === undefined) throw refuse('message_required', 'com caminhos ou --all, passe -m "assunto"');
  if (opts.message !== undefined && !opts.message.trim()) throw refuse('message_required', '-m não pode ser vazio');
  if (opts.pr !== undefined && (opts.all || opts.paths.length || opts.message !== undefined || opts.directMain || opts.noAuto || opts.base !== undefined)) {
    throw refuse('conflicting_args', '--pr só enfileira o auto-merge de uma PR existente');
  }
  if (opts.directMain && opts.noAuto) throw refuse('conflicting_args', '--direct-main não abre PR: --no-auto não se aplica');
  return opts;
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
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
    return opts.pr !== undefined
      ? await autoMergeOnly(opts, { pr: Number(opts.pr) })
      : await shipBranch(opts, ctx);
  } catch (error) {
    if (error instanceof Stop) return emit(error.status, { ...ctx, ...error.fields });
    return emit('failed', { ...ctx, stage: 'internal', detail: firstLine(error instanceof Error ? error.message : String(error)) });
  }
}

process.exitCode = await main(process.argv.slice(2));
