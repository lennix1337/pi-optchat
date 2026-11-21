import { record } from './cache.ts';
import { browserConsentEffect, browserScriptEffects, commandExternalEffects, pageScriptEffects, scriptFileEffects } from './external-effects.ts';

/** High-impact effects the autonomy contract decides on. */
export const ACTIONS = ['push', 'push-main', 'force-push', 'merge', 'publish', 'deploy', 'production-write', 'paid',
  'discard', 'recursive-delete', 'global-install', 'message', 'consent', 'merge-bypass', 'process-kill', 'database-destructive'] as const;
/**
 * Effects that cannot be taken back once they reach the world: without a rule of the operator's own in autonomy.json
 * they always wait for him.
 */
export const IRREVERSIBLE: readonly Action[] = ['force-push', 'publish', 'deploy', 'production-write', 'message', 'consent', 'merge-bypass', 'database-destructive'];
export type Action = typeof ACTIONS[number];
/** One effect a call would have, with what it touches: lowercase paths, `owner/repo` slugs, `ssh:<host>` or a kind. */
export interface Effect { action: Action; targets: string[] }
/** `slug` of the named remote (a push to `fork` lands in the fork, not in `origin`), defaulting to origin. */
export interface Repo {
  slug(path: string, remote?: string): string | undefined; branch(path: string): string | undefined;
  /** A local script's source (bounded), to tell a script that calls models from one that does not. */
  script?(path: string): string | undefined;
  /** Whether the branch of the checkout at `path` is already merged into the default branch (so deleting it loses nothing). Unknown or failing: false. */
  merged?(path: string, branch: string): boolean;
  /** The branch a worktree has checked out and whether it has no modified or untracked files; undefined when it cannot tell. */
  worktree?(path: string): { branch: string; clean: boolean } | undefined;
}

/** The same repository queries, awaited by live hooks; injected synchronous readers keep pure classification cheap. */
export type AsyncRepo = { [K in keyof Repo]: NonNullable<Repo[K]> extends (...args: infer A) => infer R ? (...args: A) => R | Promise<R> : never };
type Evaluation<T> = Generator<unknown, T, unknown>;
function* lookup<T>(value: T | Promise<T>): Evaluation<T> { return (yield value) as T; }
function synchronous<T>(evaluation: Evaluation<T>): T {
  let step = evaluation.next();
  while (!step.done) {
    if (step.value instanceof Promise) throw new Error('Synchronous classification requires synchronous repository queries');
    step = evaluation.next(step.value);
  }
  return step.value;
}
async function asynchronous<T>(evaluation: Evaluation<T>): Promise<T> {
  let step = evaluation.next();
  while (!step.done) {
    let value: unknown;
    try { value = await step.value; }
    catch (error) { step = evaluation.throw(error); continue; }
    step = evaluation.next(value);
  }
  return step.value;
}


const modelClient = /\b(?:ModelRuntime|createAgentSession|completeSimple|streamSimple)\b|from\s+['"](?:@anthropic-ai\/sdk|openai|@google\/genai|@google\/generative-ai)['"]|api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com/;

const unquote = (word: string) => word.replace(/^(['"])([^]*)\1$/, '$2');
const home = () => (process.env.HOME ?? process.env.USERPROFILE ?? '~').replaceAll('\\', '/');
/**
 * Lowercase forward-slash path; Git Bash `/c/...` becomes `c:/...`; a relative path is resolved against `base`. With
 * `keepCase` the case is kept, for callers that open the path on a case-sensitive filesystem.
 */
export function normalPath(path: string, base?: string, keepCase = false) {
  let p = unquote(path).replaceAll('\\', '/').replace(/^~(?=\/|$)/, home()).replace(/^\/([a-z])(?=\/|$)/i, '$1:');
  if (base !== undefined && !/^(?:[a-z]:|\/|\$|%)/i.test(p)) p = `${base.replace(/\/+$/, '')}/${p}`;
  const parts: string[] = [];
  for (const part of p.split('/')) {
    if (part === '.' || (part === '' && parts.length)) continue;
    if (part === '..' && parts.length > 1) parts.pop(); else parts.push(part);
  }
  const joined = parts.join('/');
  return (keepCase ? joined : joined.toLowerCase()).replace(/\/+$/, '');
}
const tempDir = /^(?:[a-z]:\/(?:tmp|temp)(?:\/|$)|\/tmp(?:\/|$)|[a-z]:\/users\/[^/]+\/appdata\/local\/temp(?:\/|$)|\$\{?(?:tmp|temp|tmpdir)\b|\$env:(?:tmp|temp)\b|%temp%)/;


function words(text: string) {
  return text.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) ?? [];
}

/**
 * Command segments of shell text: split on `;`, `&&`, `||`, `|`, `&` and newlines outside quotes, with heredoc bodies
 * dropped (they are data). Each segment carries the directory the last `cd` moved to.
 */
export function segments(text: string, cwd: string, keepCase = false) {
  const out: { command: string; dir: string }[] = [];
  let dir = normalPath(cwd, undefined, keepCase), current = '', quote = '', heredoc: string | undefined;
  const lines = text.split('\n');
  const flush = () => {
    const command = current.trim();
    current = '';
    if (!command) return;
    const move = /^(?:cd|pushd|Set-Location)\s+("[^"]+"|'[^']+'|\S+)$/i.exec(command)?.[1];
    if (move) dir = normalPath(move, dir, keepCase); else out.push({ command, dir });
  };
  for (const line of lines) {
    if (heredoc !== undefined && !quote) { if (line.trim() === heredoc) heredoc = undefined; continue; }
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) { if (c === '\\' && quote === '"') { current += c + (line[++i] ?? ''); continue; } if (c === quote) quote = ''; current += c; continue; }
      if (c === '"' || c === "'") { quote = c; current += c; continue; }
      if (c === ';' || c === '|' || c === '&') { flush(); if (line[i + 1] === c) i++; continue; }
      current += c;
    }
    if (quote) { current += '\n'; continue; }

    heredoc = /<<-?\s*['"]?(\w+)['"]?/.exec(line)?.[1] ?? heredoc;
    flush();
  }
  flush();
  return out;
}

/** The words of a segment from its command word on: leading env assignments, `then`, `do`, `sudo`, `time`, `(`... and
 * redirections (`> file`, `2>`, `<in`) dropped. */
export function commandWords(command: string) {
  const all = words(command.replace(/^[({!\s]+/, '')).filter((word, i, list) => !/^\d*[<>]/.test(word) && !/^\d*[<>]+$/.test(list[i - 1] ?? ''));
  let at = 0;
  for (let last = -1; last !== at;) {
    last = at;
    while (at < all.length && (/^[A-Za-z_]\w*=/.test(all[at]) || /^(?:then|do|else|if|elif|while|until|sudo|time|command|exec|nohup|env|&)$/.test(all[at]))) at++;
    at = afterTimeout(all, at);
  }
  return all.slice(at);
}


function afterTimeout(words: string[], at: number) {
  if (words[at] !== 'timeout') return at;
  let next = at + 1;
  while (next < words.length && words[next].startsWith('-')) next += /^-(?:k|s)$|^--(?:kill-after|signal)$/.test(words[next]) ? 2 : 1;
  return /^\d+(?:\.\d+)?[smhd]?$/.test(words[next] ?? '') ? next + 1 : at;
}

const isDeployScript = (word: string) => /(?:^|[/\\])deploy[-\w]*\.(?:ps1|sh|mjs|js|ts|cmd|bat)$/i.test(unquote(word));
const isReleaseScript = (word: string) => /(?:^|[/\\])(?:release|publish)\.(?:ps1|sh|mjs|js|cmd|bat)$/i.test(unquote(word));


const dryRunFlag = (args: string[], short = false) => args.slice(0, args.includes('--') ? args.indexOf('--') : undefined).some(arg => arg === '--dry-run' || (short && arg === '-n'));
const isDryRun = (word: string) => /^-{1,2}(?:PlanOnly|WhatIf|DryRun|dry-run|plan|help|h)$/i.test(word);
const interpreters = /^(?:pwsh|powershell|bash|sh|node|tsx|bun|deno|python3?|cmd)(?:\.exe)?$/i;
const sqlWrite = /\b(?:update\s+[\w."]+(?:\s+(?:as\s+)?\w+)?\s+set|insert\s+into|delete\s+from|drop\s+(?:table|database|schema|index)|truncate\s+(?:table\s+)?[\w."]+|alter\s+table)\b/i;
const remoteMutation = /\b(?:docker\s+(?:compose\b[^\n;&|]*\b(?:up|down|restart|rm|stop)\b|restart|rm|stop|kill|exec\b[^\n;&|]*\b(?:rm|kill)\b)|systemctl\s+(?:restart|stop|start|disable)|rm\s+-[a-z]*r|kubectl\s+(?:apply|delete|scale|rollout))\b/i;


const databaseClient = /(?:^|[\s;&|('"])(?:psql|mysql|mariadb|sqlite3|mongosh|redis-cli)(?=$|[\s;&|)'"])/i;

const readOnlyForced = /\bdefault_transaction_read_only\s*(?:=|to\b)\s*'?on'?\b|\b(?:set\s+(?:session\s+characteristics\s+as\s+)?transaction|begin|start\s+transaction)\s+read\s+only\b/i;
const readWriteAsked = /\bdefault_transaction_read_only\s*(?:=|to\b)\s*'?off'?\b|\bread\s+write\b/i;

/**
 * The ssh host of a command that also writes SQL, changes remote containers/services or runs a database client that
 * the command does not force read-only (its SQL may sit in a file this text does not show). Else undefined.
 */
export function productionWriteHost(text: string) {


  const sshCall = /(?:^|[\s;&|(])ssh(?:\s+(?:-[ipoFJLRDElbcmSWweOQ]\s*\S+|-[A-Za-z0-9]+))*\s+(?:[\w.-]+@)?(\w[\w.-]*)/;
  const unquoted = (command: string) => command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""');
  const ssh = segments(text, '').map(({ command }) => sshCall.exec(unquoted(command))?.[1]).find(Boolean);
  const unprovenClient = databaseClient.test(text) && !(readOnlyForced.test(text) && !readWriteAsked.test(text));
  return ssh && (sqlWrite.test(text) || remoteMutation.test(text) || unprovenClient) ? ssh.toLowerCase() : undefined;
}


const textCommand = /^(?:echo|printf|grep|rg|cat|head|tail|less|ls|find|diff|git|gh)$/;
const destructiveCommand = /(?:^|\s)dropdb\b|\bprisma\s+migrate\s+reset\b|\bprisma\s+db\s+push\b[^\n]*--force-reset|\bdocker\s+volume\s+(?:rm|prune)\b|\bdocker(?:\s+|-)compose\b[^\n]*\sdown\b[^\n]*\s(?:-v|--volumes)\b/i;
const destructiveSql = /\bdrop\s+(?:table|database|schema)\b|\btruncate\s+(?:table\s+)?[\w."]/i;

const deleteWithoutWhere = (text: string) => [...text.matchAll(/\bdelete\s+from\s+[^;"'`]*/gi)].some(([statement]) => !/\bwhere\b/i.test(statement));
const commandName = (command: string) => unquote(commandWords(command)[0] ?? '').toLowerCase().split(/[/\\]/).at(-1)!;

/**
 * Whether shell text runs a destructive database command: DROP TABLE/DATABASE/SCHEMA, TRUNCATE, DELETE FROM without a
 * WHERE, `prisma migrate reset`, `prisma db push --force-reset`, `dropdb`, `docker volume rm|prune`, `docker compose down -v`.
 * Commands that only print text (echo, grep, cat, git commit messages...) do not count; a here-document body is the SQL
 * of the command that reads it. Not a sandbox: obfuscated commands pass.
 */
export function databaseDestructive(text: string) {
  const bodies = [...text.matchAll(/^([^\n]*)<<-?\s*(['"]?)(\w+)\2[^\n]*\n([\s\S]*?)\n\s*\3\s*$/gm)].filter(([, head]) => !textCommand.test(commandName(head))).map(match => match[4]);
  const code = segments(text, '.').map(({ command }) => command).filter(command => !textCommand.test(commandName(command)));
  return [...code, ...bodies].some(part => destructiveCommand.test(part) || destructiveSql.test(part) || deleteWithoutWhere(part));
}


function recursiveDelete(args: string[], dir: string): string[] | undefined {
  const flags = args.filter(arg => /^-/.test(arg) || /^\/s$/i.test(arg));
  if (!flags.some(flag => /^-[a-zA-Z]*[rR]|^--recursive$|^-Recurse$|^\/s$/i.test(flag))) return;

  const valued = /^-(?:ErrorAction|EA|WarningAction|Filter|Include|Exclude)$/i;
  const targets = args.filter((arg, i) => !flags.includes(arg) && !valued.test(args[i - 1] ?? ''))
    .flatMap(arg => arg.split(',')).filter(Boolean).map(arg => normalPath(arg.replace(/^\\(?=\$)/, ''), dir));
  return !targets.length || !targets.every(target => tempDir.test(target)) ? targets : undefined;
}





function processKill(lower: string, args: string[]): string[] | undefined {
  const after = (flag: RegExp) => args.flatMap((arg, i) => flag.test(arg) && args[i + 1] !== undefined ? args[i + 1].split(',') : []);
  const found = (targets: string[]) => targets.length ? targets : ['process'];
  if (lower === 'taskkill') return found([...after(/^\/{1,2}pid$/i).map(p => `pid:${p}`), ...after(/^\/{1,2}im$/i).map(n => `name:${n.toLowerCase()}`)]);
  if (lower === 'stop-process' || lower === 'spps') {
    const named = [...after(/^-id$/i).map(p => `pid:${p}`), ...after(/^-(?:name|processname)$/i).map(n => `name:${n.toLowerCase()}`)];
    return found(named.length ? named : args.filter(arg => /^\d+$/.test(arg)).map(p => `pid:${p}`));
  }
  if (lower === 'kill') {
    if (args.some((arg, i) => /^-(?:l|L|0|-list)$/.test(arg) || (/^-[sn]$/.test(arg) && args[i + 1] === '0'))) return;
    return found(args.filter((arg, i) => !arg.startsWith('-') && !/^-[sn]$/.test(args[i - 1] ?? '')).map(p => `pid:${p.toLowerCase()}`));
  }
  if (lower === 'pkill' || lower === 'killall') return found(args.filter(arg => !arg.startsWith('-')).map(n => `name:${n.toLowerCase()}`));
  if (lower === 'wmic' && args.some(arg => /^(?:delete|terminate)$/i.test(arg)) && args.some(arg => /^process$/i.test(arg))) return ['process'];
  return undefined;
}

function* repoTargets(path: string, repo: AsyncRepo, args: string[], remote?: string): Evaluation<string[]> {
  const at = args.findIndex(arg => arg === '-R' || arg === '--repo' || arg.startsWith('--repo='));
  const named = at < 0 ? undefined : args[at].startsWith('--repo=') ? args[at].slice(7) : args[at + 1];
  const slug = (named && /^[\w.-]+\/[\w.-]+$/.test(unquote(named)) ? unquote(named).toLowerCase() : undefined) ?? (yield* lookup(repo.slug(path, remote)));
  return [...new Set([path, ...slug ? [slug] : []])];
}

function* pushEffect(args: string[], path: string, repo: AsyncRepo): Evaluation<Effect> {
  const [remote, ...refs] = args.filter(arg => !arg.startsWith('-'));

  const targets = yield* repoTargets(path, repo, args, remote && /^[\w.-]+$/.test(remote) ? remote : undefined);

  if (args.some(arg => arg === '--delete' || arg === '-d') || refs.some(ref => /^:[^:]/.test(unquote(ref)))) return { action: 'discard', targets };
  if (args.some(arg => /^(?:--force(?:-with-lease)?(?:=.*)?|-f|--mirror|-[a-z]*f[a-z]*)$/.test(arg) || /^\+/.test(arg))) return { action: 'force-push', targets };
  const main = (ref: string) => /^(?:main|master)$/i.test(unquote(ref).split(':').at(-1)!.replace(/^refs\/heads\//, ''));
  const toMain = refs.length ? refs.some(main) : /^(?:main|master)$/i.test((yield* lookup(repo.branch(path))) ?? '');
  return { action: toMain ? 'push-main' : 'push', targets };
}


function* scriptSource(w: string[], script: string, dir: string, repo: AsyncRepo): Evaluation<string | undefined> {
  if (!repo.script || w.some(arg => /^(?:--test|-e|--eval|-c|--check|-p|--print|-h|--help)$/.test(arg)) || !/\.(?:[cm]?[jt]s|py)$/i.test(unquote(script))) return;
  return yield* lookup(repo.script(normalPath(script, dir)));
}


function* scriptRunEffects(w: string[], script: string, dir: string, repo: AsyncRepo): Evaluation<Effect[]> {
  const source = yield* scriptSource(w, script, dir, repo);
  if (source === undefined) return [];
  return [...modelClient.test(source) ? [{ action: 'paid' as const, targets: ['model-run'] }] : [], ...scriptFileEffects(source, w.slice(w.indexOf(script) + 1))];
}

const maintenanceTarget = (name: string) => /pcmaintenance/i.test(name) ? 'pc-maintenance' : 'worktree-cleanup';


function* interpreterEffects(w: string[], lower: string, dir: string, repo: AsyncRepo, depth: number): Evaluation<Effect[]> {
  const effects: Effect[] = [];
  const inline = w.findIndex(arg => /^-(?:c|Command|EncodedCommand)$/i.test(arg));
  if (inline >= 0 && w[inline + 1] && depth < 3) {
    const body = w.slice(inline + 1).map(unquote).join(' ');
    for (const segment of segments(body, dir)) effects.push(...yield* segmentEffects(segment.command, segment.dir, repo, depth + 1));
  }
  const script = w.slice(1).find(arg => !arg.startsWith('-'));
  if (script) effects.push(...yield* namedScriptEffects(unquote(script), w, dir, repo));
  if (lower === 'node' && script && /(?:^|[/\\])bench\.mjs$/.test(unquote(script)) && w.includes('run')) return [...effects, { action: 'paid', targets: ['model-run'] }];

  const file = w.slice(1).find(arg => !arg.startsWith('-') && /\.(?:[cm]?[jt]s|py)$/i.test(unquote(arg)));
  if (file) effects.push(...yield* scriptRunEffects(w, file, dir, repo));
  return effects;
}


function* namedScriptEffects(script: string, w: string[], dir: string, repo: AsyncRepo): Evaluation<Effect[]> {
  const name = script.split(/[/\\]/).at(-1)!;
  if (/^invoke-(?:pcmaintenance|worktreecleanup)/i.test(name)) return w.some(arg => /^-Apply$/i.test(arg)) ? [{ action: 'discard', targets: [maintenanceTarget(name)] }] : [];
  if (w.some(isDryRun)) return [];
  if (isDeployScript(script)) return [{ action: 'deploy', targets: yield* repoTargets(dir, repo, w) }];
  if (isReleaseScript(script)) return [{ action: 'publish', targets: yield* repoTargets(dir, repo, w) }];
  return [];
}


function* gitEffects(w: string[], dir: string, repo: AsyncRepo): Evaluation<Effect[]> {
  let at = 1, path = dir;
  while (at < w.length && w[at].startsWith('-')) { if (w[at] === '-C' && w[at + 1] !== undefined) path = normalPath(w[++at], dir); else if (w[at] === '-c') at++; at++; }
  const [sub, ...args] = w.slice(at);
  if (sub === 'push') return dryRunFlag(args, true) ? [] : [yield* pushEffect(args, path, repo)];
  const rest = args.join(' ');
  const discards = (sub === 'reset' && /(?:^|\s)--hard\b/.test(rest)) || (sub === 'clean' && /(?:^|\s)-[a-z]*f/i.test(rest))
    || (sub === 'worktree' && /^remove\b/.test(rest) && /--force|-f\b/.test(rest)) || (sub === 'branch' && /(?:^|\s)-D\b/.test(rest))
    || (sub === 'stash' && /^(?:drop|clear)\b/.test(rest)) || ((sub === 'checkout' || sub === 'restore') && args.some(arg => arg === '.'));

  return discards ? [{ action: 'discard', targets: [path, ...yield* mergedWork(sub, args, path, repo)] }] : [];
}


function* mergedWork(sub: string, args: string[], path: string, repo: AsyncRepo): Evaluation<string[]> {
  const operands = args.slice(sub === 'worktree' ? 1 : 0).map(unquote);

  const isMerged = function* (name: string): Evaluation<boolean> { try { return !/^(?:main|master|HEAD)$/i.test(name) && (yield* lookup(repo.merged?.(path, name))) === true; } catch { return false; } };
  if (sub === 'branch') {
    const names = operands.filter(arg => !arg.startsWith('-'));

    if (operands.some(arg => arg.startsWith('-') && arg !== '-D') || !names.length) return [];
    for (const name of names) if (!(yield* isMerged(name))) return [];
    return ['merged-branch'];
  }
  const [folder, ...extra] = operands.filter(arg => !arg.startsWith('-'));
  let state: ReturnType<NonNullable<Repo['worktree']>>;
  try { state = sub === 'worktree' && folder !== undefined && !extra.length ? yield* lookup(repo.worktree?.(normalPath(folder, path))) : undefined; } catch { state = undefined; }
  return state?.clean && (yield* isMerged(state.branch)) ? ['worktree-cleanup'] : [];
}


function* ghEffects(w: string[], dir: string, repo: AsyncRepo): Evaluation<Effect[]> {
  const [group, verb] = w.slice(1), targets = () => repoTargets(dir, repo, w);
  // external: gh merge --admin bypasses required checks.
  if (group === 'pr' && verb === 'merge') return [{ action: w.includes('--admin') ? 'merge-bypass' : 'merge', targets: yield* targets() }];
  if ((group === 'release' && /^(?:create|upload|edit)$/.test(verb ?? '')) || (group === 'repo' && /^(?:create|delete)$/.test(verb ?? '')))
    return [{ action: 'publish', targets: yield* targets() }];
  if (group === 'workflow' && verb === 'run') {
    const names = w.slice(3).filter(arg => !arg.startsWith('-'));

    if (names.some(arg => /deploy|prod/i.test(arg))) return [{ action: 'deploy', targets: yield* targets() }];
    if (names.some(arg => /release|publish/i.test(arg))) return [{ action: 'publish', targets: yield* targets() }];
  }
  return [];
}


function* toolEffects(w: string[], lower: string, dir: string, repo: AsyncRepo): Evaluation<Effect[]> {
  const args = w.slice(1).map(unquote);
  if (/^(?:npm|pnpm|yarn|cargo|vsce)$/.test(lower)) {
    const effects: Effect[] = [];
    if (args[0] === 'publish' && !dryRunFlag(args)) effects.push({ action: 'publish', targets: yield* repoTargets(dir, repo, w) });
    if (/^(?:i|install|add|link)$/.test(args[0] ?? '') && args.some(arg => arg === '-g' || arg === '--global') || (lower === 'cargo' && args[0] === 'install'))
      effects.push({ action: 'global-install', targets: ['machine'] });
    return effects;
  }
  if (/^(?:winget|choco|scoop)$/.test(lower) && args[0] === 'install') return [{ action: 'global-install', targets: ['machine'] }];
  const tool = lower === 'npx' ? args[0] ?? '' : lower, toolArgs = lower === 'npx' ? args.slice(1) : args;
  if (/^(?:wrangler|netlify|fly|flyctl|railway)$/.test(tool) && toolArgs[0] === 'deploy' && !toolArgs.some(arg => /^(?:-h|--help|--dry-run)$/.test(arg)))
    return [{ action: 'deploy', targets: yield* repoTargets(dir, repo, w) }];
  if (tool === 'vercel' && (toolArgs.includes('--prod') || toolArgs[0] === 'deploy')) return [{ action: 'deploy', targets: yield* repoTargets(dir, repo, w) }];
  if ((tool === 'docker' && (toolArgs[0] === 'push' || (toolArgs[0] === 'image' && toolArgs[1] === 'push'))) || (tool === 'kubectl' && /^(?:apply|rollout)$/.test(toolArgs[0] ?? '')))
    return [{ action: 'deploy', targets: [dir] }];
  if (lower === 'pi' && args.some(arg => arg === '-p' || arg === '--print')) return [{ action: 'paid', targets: ['model-run'] }];
  const killed = processKill(lower, args);
  if (killed) return [{ action: 'process-kill', targets: killed }];
  const deleted = /^(?:rm|remove-item|ri|rmdir|rd)$/.test(lower) ? recursiveDelete(args, dir) : undefined;
  return deleted ? [{ action: 'recursive-delete', targets: deleted.length ? deleted : [dir] }] : [];
}

const SSH_VALUED = /^-[ipoFJLRDElbcmSWweOQB]$/;





function relayedCommand(w: string[], lower: string): string | undefined {
  // external: Bash double quotes preserve escapes for quote, backslash and dollar.
  const body = (word: string) => /^".*"$/s.test(word) ? word.slice(1, -1).replace(/\\(["\\$`])/g, '$1') : unquote(word);
  const rest = (from: number) => from < w.length ? w.slice(from).map(body).join(' ') : undefined;
  if (lower === 'ssh') {
    let at = 1;
    while (at < w.length && w[at].startsWith('-')) at += SSH_VALUED.test(w[at]) ? 2 : 1;
    return rest(at + 1);
  }
  if (lower === 'schtasks') {
    const tr = w.findIndex(arg => /^\/tr$/i.test(arg));
    return tr >= 0 && w[tr + 1] !== undefined ? body(w[tr + 1]) : undefined;
  }
  if (lower === 'cmd') {
    const c = w.findIndex(arg => /^\/[ck]$/i.test(arg));
    return c >= 0 ? rest(c + 1) : undefined;
  }
  if (lower === 'conhost') return rest(w.slice(1).findIndex(arg => !arg.startsWith('-')) + 1 || w.length);
  return undefined;
}


function* segmentEffects(command: string, dir: string, repo: AsyncRepo, depth: number): Evaluation<Effect[]> {
  const w = commandWords(command);
  if (!w.length) return [];

  const page = pageScriptEffects(command);
  if (page.length) return page;
  const head = unquote(w[0]).replace(/^&$/, '').replace(/\.exe$/i, '');
  const lower = head.toLowerCase().split(/[/\\]/).at(-1)!;
  const relayed = relayedCommand(w, lower);
  if (relayed !== undefined) {
    if (depth >= 6) return [];
    const effects: Effect[] = [];
    for (const segment of segments(relayed, dir)) effects.push(...yield* segmentEffects(segment.command, segment.dir, repo, depth + 1));
    return effects;
  }
  if (interpreters.test(lower)) return yield* interpreterEffects(w, lower, dir, repo, depth);
  if (lower === 'npx' && /^(?:tsx|ts-node)$/.test(unquote(w[1] ?? ''))) {
    const script = w.slice(2).find(arg => !arg.startsWith('-'));
    return script ? yield* scriptRunEffects(w, script, dir, repo) : [];
  }
  const named = yield* namedScriptEffects(head, w, dir, repo);
  if (named.length) return named;
  if (lower === 'git') return yield* gitEffects(w, dir, repo);
  if (lower === 'gh') return yield* ghEffects(w, dir, repo);
  const external = commandExternalEffects(w);
  return external.length ? external : yield* toolEffects(w, lower, dir, repo);
}






function expandKnownVariables(text: string) {
  const known = new Map<string, string>();
  for (const [, name, value] of text.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=("?\$\(mktemp\b[^)]*\)"?|[^\s;&|$`"'()]+)/g))
    known.set(name, /mktemp/.test(value) ? `/tmp/mktemp-${name.toLowerCase()}` : value);
  if (!known.size) return text;
  return text.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, name: string) => known.get(name) ?? whole);
}

const noRepo: Repo = { slug: () => undefined, branch: () => undefined };
/** Whether shell text runs a deploy (a deploy script, `wrangler deploy`, a deploy workflow, `docker push`...). */
export const runsDeploy = (text: string) => segments(text, '').some(({ command, dir }) => synchronous(segmentEffects(command, dir, noRepo, 0)).some(e => e.action === 'deploy'));

/** Messages to third parties and production HTTP writes in shell text (see external-effects.ts). */
export const externalEffectsOf = (text: string) => segments(text, '').flatMap(({ command }) => commandExternalEffects(commandWords(command)));

const paidTools = new Set(['subagent', 'spawn', 'tell']);
const subagentInspection = new Set(['list', 'models', 'guide', 'status', 'validate']);
/** Commands a codemode script hands to shell tools: the `command: "..."` string literals. */
export const scriptCommands = (code: string) => [...code.matchAll(/\bcommand\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map(m => m[2].replace(/\\n/g, '\n').replace(/\\(["'`\\])/g, '$1'));

/** Every high-impact effect of a call, read from its arguments alone. Not a sandbox: obfuscated commands pass. */
export type EffectCall = { tool: string; input: unknown; cwd: string };
/** Pure/injected synchronous classification; live repository readers use the async entry point below. */
export const classifyEffects = (call: EffectCall, repo: Repo): Effect[] => synchronous(evaluateEffects(call, repo));
export const classifyEffectsAsync = (call: EffectCall, repo: AsyncRepo): Promise<Effect[]> => asynchronous(evaluateEffects(call, repo));

function* evaluateEffects({ tool, input, cwd }: EffectCall, repo: AsyncRepo): Evaluation<Effect[]> {

  if (paidTools.has(tool)) return record(input) && typeof input.action === 'string' && subagentInspection.has(input.action) ? [] : [{ action: 'paid', targets: ['subagent'] }];
  if (tool === 'browser_harness') { const consent = browserConsentEffect(input); return [...(consent ? [consent] : []), ...browserScriptEffects(input)]; }
  const shell = record(input) && typeof input.command === 'string' && (tool === 'bash' || tool === 'shell_start') ? [input.command] : undefined;
  const code = record(input) && typeof input.code === 'string' && tool === 'codemode' ? input.code : undefined;
  const texts = shell ?? (code !== undefined ? scriptCommands(code) : []);
  const effects: Effect[] = [];
  if (code !== undefined) {
    if (/\btools\.(?:subagent|spawn|tell)\s*\(/.test(code)) effects.push({ action: 'paid', targets: ['subagent'] });
    if (/\bmodels\.(?:classify|generateImages)\s*\(/.test(code)) effects.push({ action: 'paid', targets: ['model-run'] });
  }
  for (const raw of texts) {
    const text = expandKnownVariables(raw);
    const host = productionWriteHost(text);
    if (host) effects.push({ action: 'production-write', targets: [`ssh:${host}`] });
    for (const { command, dir } of segments(text, cwd)) effects.push(...yield* segmentEffects(command, dir, repo, 0));
    if (databaseDestructive(text)) effects.push({ action: 'database-destructive', targets: ['database'] });
  }
  return effects;
}
