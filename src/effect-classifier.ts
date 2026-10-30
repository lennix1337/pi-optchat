import { record } from './cache.ts';

/** High-impact effects the autonomy contract decides on. */
export const ACTIONS = ['push', 'push-main', 'force-push', 'merge', 'publish', 'deploy', 'production-write', 'paid',
  'discard', 'recursive-delete', 'global-install'] as const;
export type Action = typeof ACTIONS[number];
/** One effect a call would have, with what it touches: lowercase paths, `owner/repo` slugs, `ssh:<host>` or a kind. */
export interface Effect { action: Action; targets: string[] }
/** `slug` of the named remote (a push to `fork` lands in the fork, not in `origin`), defaulting to origin. */
export interface Repo {
  slug(path: string, remote?: string): string | undefined; branch(path: string): string | undefined;
  /** A local script's source (bounded), to tell a script that calls models from one that does not. */
  script?(path: string): string | undefined;
}

/** Source markers of a script that talks to a model provider: SDK runtimes, provider clients, provider endpoints. */
const modelClient = /\b(?:ModelRuntime|createAgentSession|completeSimple|streamSimple)\b|from\s+['"](?:@anthropic-ai\/sdk|openai|@google\/genai|@google\/generative-ai)['"]|api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com/;

const unquote = (word: string) => word.replace(/^(['"])([^]*)\1$/, '$2');
const home = () => (process.env.HOME ?? process.env.USERPROFILE ?? '~').replaceAll('\\', '/');
/** Lowercase forward-slash path; Git Bash `/c/...` becomes `c:/...`; a relative path is resolved against `base`. */
export function normalPath(path: string, base?: string) {
  let p = unquote(path).replaceAll('\\', '/').replace(/^~(?=\/|$)/, home()).replace(/^\/([a-z])(?=\/|$)/i, '$1:');
  if (base !== undefined && !/^(?:[a-z]:|\/|\$|%)/i.test(p)) p = `${base.replace(/\/+$/, '')}/${p}`;
  const parts: string[] = [];
  for (const part of p.split('/')) {
    if (part === '.' || (part === '' && parts.length)) continue;
    if (part === '..' && parts.length > 1) parts.pop(); else parts.push(part);
  }
  return parts.join('/').toLowerCase().replace(/\/+$/, '');
}
const tempDir = /^(?:[a-z]:\/(?:tmp|temp)(?:\/|$)|\/tmp(?:\/|$)|[a-z]:\/users\/[^/]+\/appdata\/local\/temp(?:\/|$)|\$\{?(?:tmp|temp|tmpdir)\b|%temp%)/;

/** Shell text as words; quotes group words and are kept, so `unquote` can tell data from code. */
function words(text: string) {
  return text.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) ?? [];
}

/**
 * Command segments of shell text: split on `;`, `&&`, `||`, `|`, `&` and newlines outside quotes, with heredoc bodies
 * dropped (they are data). Each segment carries the directory the last `cd` moved to.
 */
export function segments(text: string, cwd: string) {
  const out: { command: string; dir: string }[] = [];
  let dir = normalPath(cwd), current = '', quote = '', heredoc: string | undefined;
  const lines = text.split('\n');
  const flush = () => {
    const command = current.trim();
    current = '';
    if (!command) return;
    const move = /^(?:cd|pushd|Set-Location)\s+("[^"]+"|'[^']+'|\S+)$/i.exec(command)?.[1];
    if (move) dir = normalPath(move, dir); else out.push({ command, dir });
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
    heredoc = /<<-?\s*['"]?(\w+)['"]?/.exec(current)?.[1] ?? heredoc;
    flush();
  }
  flush();
  return out;
}

/** The words of a segment from its command word on: leading env assignments, `then`, `do`, `sudo`, `time`, `(`... and
 * redirections (`> file`, `2>`, `<in`) dropped. */
function commandWords(command: string) {
  const all = words(command.replace(/^[({!\s]+/, '')).filter((word, i, list) => !/^\d*[<>]/.test(word) && !/^\d*[<>]+$/.test(list[i - 1] ?? ''));
  let at = 0;
  for (let last = -1; last !== at;) {
    last = at;
    while (at < all.length && (/^[A-Za-z_]\w*=/.test(all[at]) || /^(?:then|do|else|if|elif|while|until|sudo|time|command|exec|nohup|env|&)$/.test(all[at]))) at++;
    at = afterTimeout(all, at);
  }
  return all.slice(at);
}

/** `timeout [-k N] [--signal=S] DURATION command...` runs the command: where it starts, else `at` unchanged. */
function afterTimeout(words: string[], at: number) {
  if (words[at] !== 'timeout') return at;
  let next = at + 1;
  while (next < words.length && words[next].startsWith('-')) next += /^-(?:k|s)$|^--(?:kill-after|signal)$/.test(words[next]) ? 2 : 1;
  return /^\d+(?:\.\d+)?[smhd]?$/.test(words[next] ?? '') ? next + 1 : at;
}

const isDeployScript = (word: string) => /(?:^|[/\\])deploy[-\w]*\.(?:ps1|sh|mjs|js|ts|cmd|bat)$/i.test(unquote(word));
const isReleaseScript = (word: string) => /(?:^|[/\\])(?:release|publish)\.(?:ps1|sh|mjs|js|cmd|bat)$/i.test(unquote(word));
/** Flags that make a deploy script only plan or print what it would do. */
const isDryRun = (word: string) => /^-{1,2}(?:PlanOnly|WhatIf|DryRun|dry-run|plan|help|h)$/i.test(word);
const interpreters = /^(?:pwsh|powershell|bash|sh|node|tsx|bun|deno|python3?|cmd)(?:\.exe)?$/i;
const sqlWrite = /\b(?:update\s+[\w."]+(?:\s+(?:as\s+)?\w+)?\s+set|insert\s+into|delete\s+from|drop\s+(?:table|database|schema|index)|truncate\s+(?:table\s+)?[\w."]+|alter\s+table)\b/i;
const remoteMutation = /\b(?:docker\s+(?:compose\b[^\n;&|]*\b(?:up|down|restart|rm|stop)\b|restart|rm|stop|kill|exec\b[^\n;&|]*\b(?:rm|kill)\b)|systemctl\s+(?:restart|stop|start|disable)|rm\s+-[a-z]*r|kubectl\s+(?:apply|delete|scale|rollout))\b/i;

/** A database client as a command word (not a path or a longer name such as `psql-backups`). */
const databaseClient = /(?:^|[\s;&|('"])(?:psql|mysql|mariadb|sqlite3|mongosh|redis-cli)(?=$|[\s;&|)'"])/i;
/** Read-only forced by the command itself: `default_transaction_read_only=on` (PGOPTIONS, -c, SQL) or a read-only transaction. */
const readOnlyForced = /\bdefault_transaction_read_only\s*(?:=|to\b)\s*'?on'?\b|\b(?:set\s+(?:session\s+characteristics\s+as\s+)?transaction|begin|start\s+transaction)\s+read\s+only\b/i;
const readWriteAsked = /\bdefault_transaction_read_only\s*(?:=|to\b)\s*'?off'?\b|\bread\s+write\b/i;

/**
 * The ssh host of a command that also writes SQL, changes remote containers/services or runs a database client that
 * the command does not force read-only (its SQL may sit in a file this text does not show). Else undefined.
 */
export function productionWriteHost(text: string) {
  // Flags that take a value (-i key, -p 22, -o Opt=x ...) consume it; the first other word is the host.
  const ssh = /(?:^|[\s;&|(])ssh(?:\s+(?:-[ipoFJLRDElbcmSWweOQ]\s*\S+|-[A-Za-z0-9]+))*\s+(?:[\w.-]+@)?(\w[\w.-]*)/.exec(text)?.[1];
  const unprovenClient = databaseClient.test(text) && !(readOnlyForced.test(text) && !readWriteAsked.test(text));
  return ssh && (sqlWrite.test(text) || remoteMutation.test(text) || unprovenClient) ? ssh.toLowerCase() : undefined;
}

/** A recursive delete (rm -r, Remove-Item -Recurse, rd /s) whose targets are not all inside a temp folder. */
function recursiveDelete(args: string[], dir: string): string[] | undefined {
  const flags = args.filter(arg => /^-/.test(arg) || /^\/s$/i.test(arg));
  if (!flags.some(flag => /^-[a-zA-Z]*[rR]|^--recursive$|^-Recurse$|^\/s$/i.test(flag))) return;
  const targets = args.filter(arg => !flags.includes(arg)).map(arg => normalPath(arg, dir));
  return !targets.length || !targets.every(target => tempDir.test(target)) ? targets : undefined;
}

function repoTargets(path: string, repo: Repo, args: string[], remote?: string) {
  const at = args.findIndex(arg => arg === '-R' || arg === '--repo' || arg.startsWith('--repo='));
  const named = at < 0 ? undefined : args[at].startsWith('--repo=') ? args[at].slice(7) : args[at + 1];
  const slug = (named && /^[\w.-]+\/[\w.-]+$/.test(unquote(named)) ? unquote(named).toLowerCase() : undefined) ?? repo.slug(path, remote);
  return [...new Set([path, ...slug ? [slug] : []])];
}

function pushEffect(args: string[], path: string, repo: Repo): Effect {
  const [remote, ...refs] = args.filter(arg => !arg.startsWith('-'));
  // A URL or path as the remote names no configured remote; origin is the best local guess.
  const targets = repoTargets(path, repo, args, remote && /^[\w.-]+$/.test(remote) ? remote : undefined);
  // Deleting a remote branch (`--delete x`, `-d x`, `:x`) removes work others may still need.
  if (args.some(arg => arg === '--delete' || arg === '-d') || refs.some(ref => /^:[^:]/.test(unquote(ref)))) return { action: 'discard', targets };
  if (args.some(arg => /^(?:--force(?:-with-lease)?(?:=.*)?|-f|--mirror|-[a-z]*f[a-z]*)$/.test(arg) || /^\+/.test(arg))) return { action: 'force-push', targets };
  const main = (ref: string) => /^(?:main|master)$/i.test(unquote(ref).split(':').at(-1)!.replace(/^refs\/heads\//, ''));
  const toMain = refs.length ? refs.some(main) : /^(?:main|master)$/i.test(repo.branch(path) ?? '');
  return { action: toMain ? 'push-main' : 'push', targets };
}

/** A script run (not a test run) whose source calls a model provider. */
function runsModelScript(w: string[], script: string, dir: string, repo: Repo) {
  if (!repo.script || w.some(arg => /^(?:--test|-e|--eval|-c|--check|-p|--print|-h|--help)$/.test(arg)) || !/\.(?:[cm]?[jt]s|py)$/i.test(unquote(script))) return false;
  const source = repo.script(normalPath(script, dir));
  return source !== undefined && modelClient.test(source);
}

const maintenanceTarget = (name: string) => /pcmaintenance/i.test(name) ? 'pc-maintenance' : 'worktree-cleanup';

/** `pwsh`/`bash`/`node`...: an inline `-Command`/`-c` body is classified like any shell text; a script argument by name or source. */
function interpreterEffects(w: string[], lower: string, dir: string, repo: Repo, depth: number): Effect[] {
  const effects: Effect[] = [];
  const inline = w.findIndex(arg => /^-(?:c|Command|EncodedCommand)$/i.test(arg));
  if (inline >= 0 && w[inline + 1] && depth < 3) {
    const body = w.slice(inline + 1).map(unquote).join(' ');
    for (const segment of segments(body, dir)) effects.push(...segmentEffects(segment.command, segment.dir, repo, depth + 1));
  }
  const script = w.slice(1).find(arg => !arg.startsWith('-'));
  if (script) effects.push(...namedScriptEffects(unquote(script), w, dir, repo));
  if (lower === 'node' && script && /(?:^|[/\\])bench\.mjs$/.test(unquote(script)) && w.includes('run')) return [...effects, { action: 'paid', targets: ['model-run'] }];
  // `node --import tsx file.ts`: the first argument that names a file is the script.
  const file = w.slice(1).find(arg => !arg.startsWith('-') && /\.(?:[cm]?[jt]s|py)$/i.test(unquote(arg)));
  if (file && runsModelScript(w, file, dir, repo)) effects.push({ action: 'paid', targets: ['model-run'] });
  return effects;
}

/** A script known by its name: deploy*, release/publish, or the maintenance cleanups with -Apply. */
function namedScriptEffects(script: string, w: string[], dir: string, repo: Repo): Effect[] {
  const name = script.split(/[/\\]/).at(-1)!;
  if (/^invoke-(?:pcmaintenance|worktreecleanup)/i.test(name)) return w.some(arg => /^-Apply$/i.test(arg)) ? [{ action: 'discard', targets: [maintenanceTarget(name)] }] : [];
  if (w.some(isDryRun)) return [];
  if (isDeployScript(script)) return [{ action: 'deploy', targets: repoTargets(dir, repo, w) }];
  if (isReleaseScript(script)) return [{ action: 'publish', targets: repoTargets(dir, repo, w) }];
  return [];
}

/** `git`: pushes by destination, and the subcommands that discard work. */
function gitEffects(w: string[], dir: string, repo: Repo): Effect[] {
  let at = 1, path = dir;
  while (at < w.length && w[at].startsWith('-')) { if (w[at] === '-C' && w[at + 1] !== undefined) path = normalPath(w[++at], dir); else if (w[at] === '-c') at++; at++; }
  const [sub, ...args] = w.slice(at);
  if (sub === 'push') return [pushEffect(args, path, repo)];
  const rest = args.join(' ');
  const discards = (sub === 'reset' && /(?:^|\s)--hard\b/.test(rest)) || (sub === 'clean' && /(?:^|\s)-[a-z]*f/i.test(rest))
    || (sub === 'worktree' && /^remove\b/.test(rest) && /--force|-f\b/.test(rest)) || (sub === 'branch' && /(?:^|\s)-D\b/.test(rest))
    || (sub === 'stash' && /^(?:drop|clear)\b/.test(rest)) || ((sub === 'checkout' || sub === 'restore') && args.some(arg => arg === '.'));
  return discards ? [{ action: 'discard', targets: [path] }] : [];
}

/** `gh`: merges, releases and repository creation/deletion, deploy workflows. */
function ghEffects(w: string[], dir: string, repo: Repo): Effect[] {
  const [group, verb] = w.slice(1), targets = () => repoTargets(dir, repo, w);
  if (group === 'pr' && verb === 'merge') return [{ action: 'merge', targets: targets() }];
  if ((group === 'release' && /^(?:create|upload|edit)$/.test(verb ?? '')) || (group === 'repo' && /^(?:create|delete)$/.test(verb ?? '')))
    return [{ action: 'publish', targets: targets() }];
  if (group === 'workflow' && verb === 'run' && w.slice(3).some(arg => /deploy|release|publish|prod/i.test(arg) && !arg.startsWith('-')))
    return [{ action: 'deploy', targets: targets() }];
  return [];
}

/** Package managers, deploy CLIs, `pi -p` and recursive deletes. */
function toolEffects(w: string[], lower: string, dir: string, repo: Repo): Effect[] {
  const args = w.slice(1).map(unquote);
  if (/^(?:npm|pnpm|yarn|cargo|vsce)$/.test(lower)) {
    const effects: Effect[] = [];
    if (args[0] === 'publish') effects.push({ action: 'publish', targets: repoTargets(dir, repo, w) });
    if (/^(?:i|install|add|link)$/.test(args[0] ?? '') && args.some(arg => arg === '-g' || arg === '--global') || (lower === 'cargo' && args[0] === 'install'))
      effects.push({ action: 'global-install', targets: ['machine'] });
    return effects;
  }
  if (/^(?:winget|choco|scoop)$/.test(lower) && args[0] === 'install') return [{ action: 'global-install', targets: ['machine'] }];
  const tool = lower === 'npx' ? args[0] ?? '' : lower, toolArgs = lower === 'npx' ? args.slice(1) : args;
  if (/^(?:wrangler|netlify|fly|flyctl|railway)$/.test(tool) && toolArgs[0] === 'deploy' && !toolArgs.some(arg => /^(?:-h|--help|--dry-run)$/.test(arg)))
    return [{ action: 'deploy', targets: repoTargets(dir, repo, w) }];
  if (tool === 'vercel' && (toolArgs.includes('--prod') || toolArgs[0] === 'deploy')) return [{ action: 'deploy', targets: repoTargets(dir, repo, w) }];
  if ((tool === 'docker' && (toolArgs[0] === 'push' || (toolArgs[0] === 'image' && toolArgs[1] === 'push'))) || (tool === 'kubectl' && /^(?:apply|rollout)$/.test(toolArgs[0] ?? '')))
    return [{ action: 'deploy', targets: [dir] }];
  if (lower === 'pi' && args.some(arg => arg === '-p' || arg === '--print')) return [{ action: 'paid', targets: ['model-run'] }];
  const deleted = /^(?:rm|remove-item|ri|rmdir|rd)$/.test(lower) ? recursiveDelete(args, dir) : undefined;
  return deleted ? [{ action: 'recursive-delete', targets: deleted.length ? deleted : [dir] }] : [];
}

/** The effects of one command segment, recursing into `pwsh -Command "..."`, `bash -c "..."`. */
function segmentEffects(command: string, dir: string, repo: Repo, depth: number): Effect[] {
  const w = commandWords(command);
  if (!w.length) return [];
  const head = unquote(w[0]).replace(/^&$/, '').replace(/\.exe$/i, '');
  const lower = head.toLowerCase().split(/[/\\]/).at(-1)!;
  if (interpreters.test(lower)) return interpreterEffects(w, lower, dir, repo, depth);
  if (lower === 'npx' && /^(?:tsx|ts-node)$/.test(unquote(w[1] ?? ''))) {
    const script = w.slice(2).find(arg => !arg.startsWith('-'));
    return script && runsModelScript(w, script, dir, repo) ? [{ action: 'paid', targets: ['model-run'] }] : [];
  }
  const named = namedScriptEffects(head, w, dir, repo);
  if (named.length) return named;
  if (lower === 'git') return gitEffects(w, dir, repo);
  if (lower === 'gh') return ghEffects(w, dir, repo);
  return toolEffects(w, lower, dir, repo);
}

/**
 * Replaces `$X` / `${X}` with what the same script assigned to X: `X=$(mktemp -d)` becomes a temp path, `X=<plain path>`
 * that path. So `T=$(mktemp -d); rm -rf $T` is seen as a temp cleanup and `R=main; git push origin $R` as a main push.
 * Anything assigned from other substitutions stays a variable (unknown, so still judged strictly).
 */
function expandKnownVariables(text: string) {
  const known = new Map<string, string>();
  for (const [, name, value] of text.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=("?\$\(mktemp\b[^)]*\)"?|[^\s;&|$`"'()]+)/g))
    known.set(name, /mktemp/.test(value) ? `/tmp/mktemp-${name.toLowerCase()}` : value);
  if (!known.size) return text;
  return text.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, name: string) => known.get(name) ?? whole);
}

const noRepo: Repo = { slug: () => undefined, branch: () => undefined };
/** Whether shell text runs a deploy (a deploy script, `wrangler deploy`, a deploy workflow, `docker push`...). */
export const runsDeploy = (text: string) => segments(text, '').some(({ command, dir }) => segmentEffects(command, dir, noRepo, 0).some(e => e.action === 'deploy'));

const paidTools = new Set(['subagent', 'spawn', 'tell']);
const subagentInspection = new Set(['list', 'models', 'guide', 'status', 'validate']);
/** Commands a codemode script hands to shell tools: the `command: "..."` string literals. */
const scriptCommands = (code: string) => [...code.matchAll(/\bcommand\s*:\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map(m => m[2].replace(/\\n/g, '\n').replace(/\\(["'`\\])/g, '$1'));

/** Every high-impact effect of a call, read from its arguments alone. Not a sandbox: obfuscated commands pass. */
export function classifyEffects({ tool, input, cwd }: { tool: string; input: unknown; cwd: string }, repo: Repo): Effect[] {
  // Targets name the kind of spend: delegated agents on the operator's plan, or a direct model run (bench, pi -p, models.*).
  if (paidTools.has(tool)) return record(input) && typeof input.action === 'string' && subagentInspection.has(input.action) ? [] : [{ action: 'paid', targets: ['subagent'] }];
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
    for (const { command, dir } of segments(text, cwd)) effects.push(...segmentEffects(command, dir, repo, 0));
  }
  return effects;
}
