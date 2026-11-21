






/** A foreground bash call longer than this (seconds) is moved to a background shell. */
export const LONG_COMMAND_SECONDS = 120;
/**
 * How long (seconds) a moved call still waits for its shell before returning the ID. Over 14 days of sessions
 * (local-validation/performance/tool-waste/moves.mjs) 159 of 166 moved commands ended within 30 s, median 3.6 s; each
 * then cost a "[shell ID]" message, polls or an ended turn to get the result a foreground call returns.
 */
export const LONG_COMMAND_GRACE_SECONDS = 30;

/** What the bash tool's description says about the move, so the model reads the result as a shell ID. */
export const LONG_COMMAND_NOTE = `Commands expected to run long (test suites, builds, dev servers, a timeout above ${LONG_COMMAND_SECONDS} s) or to wait (a sleep of 15 s or more, a polling loop, gh run watch) run as a background shell: one that ends within ${LONG_COMMAND_GRACE_SECONDS} s returns its output here as usual; one still running returns its shell ID, and the outcome arrives later as a "[shell ID]" message.`;

const MAX_SHELL_DEPTH = 3;

const PREFIX_WRAPPERS = new Set(['time', 'nohup', 'exec', 'command', 'env', 'caffeinate', 'rtk']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'wsl', 'pwsh', 'powershell', 'cmd']);

const SHELL_COMMAND_FLAGS = new Set(['-c', '-lc', '-ic', '-e', '-command', '/c']);

const PROBE_FLAGS = new Set(['--help', '-h', '--version', '-v', '-V', '--list']);

const BUILD_SCRIPT = /^(build|test|publish|release)\.(ps1|sh)$/i;

const PACKAGE_SCRIPT_WORDS = new Set(['test', 'tests', 'build', 'ci', 'e2e', 'verify', 'check', 'typecheck', 'lint', 'coverage', 'bench', 'compile', 'dist', 'package', 'release', 'dev', 'start', 'serve', 'watch', 'storybook']);
const isPackageScript = (name: string) => name.split(/[:._-]+/).some(word => PACKAGE_SCRIPT_WORDS.has(word));

const NPM_LIKE = new Set(['npm', 'pnpm', 'yarn', 'bun']);

const RUNNER_SUB = new Map<string, Set<string>>([
  ['npm', new Set(['test', 't', 'ci', 'install', 'i', 'it', 'start'])],
  ['cargo', new Set(['build', 'b', 'test', 't', 'check', 'clippy', 'bench', 'run', 'nextest'])],
  ['dotnet', new Set(['build', 'test', 'publish', 'restore', 'run'])],
  ['go', new Set(['test', 'build', 'install'])],
  ['docker', new Set(['build', 'pull', 'push'])],
]);
const RUNNERS = new Set(['make', 'ninja', 'gradle', 'gradlew', 'mvn', 'mvnw', 'bazel', 'pytest', 'vitest', 'jest', 'mocha']);
const NPX = new Set(['npx', 'pnpx', 'bunx']);
const NPX_RUNNER = new Set(['playwright', 'jest', 'vitest', 'mocha', 'cypress']);

const baseName = (word: string) => (word.split(/[\\/]/).pop() ?? word).toLowerCase().replace(/\.exe$/, '');


function seconds(token: string | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/i.exec(token ?? '');
  if (!match) return undefined;
  return Number(match[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86_400 } as Record<string, number>)[match[2].toLowerCase()];
}

/**
 * Splits a command into simple commands, each a list of words, at `&&`, `||`, `;`, `|`, `&` and newlines outside quotes.
 * Quotes are removed, so `echo "npm test"` is one word list whose first word is `echo`.
 */
export function commandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [], word = '', quote: string | undefined, inWord = false;
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false; };
  const endSegment = () => { endWord(); if (words.length) segments.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) { if (ch === quote) quote = undefined; else { word += ch; inWord = true; } continue; }
    if (ch === '"' || ch === "'") { quote = ch; inWord = true; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { endWord(); continue; }
    if (ch === '\n' || ch === ';') { endSegment(); continue; }
    if (ch === '&' || ch === '|') { endSegment(); if (command[i + 1] === ch) i++; continue; }
    word += ch; inWord = true;
  }
  endSegment();
  return segments;
}


function segmentReason(input: string[], depth: number): string | undefined {
  let words = input;
  while (words.length && (/^\w+=/.test(words[0]) || PREFIX_WRAPPERS.has(baseName(words[0])))) words = words.slice(1);
  if (!words.length) return undefined;
  const head = baseName(words[0]).replace(/^[({]+/, '');
  if (head === 'timeout') {
    const limit = seconds(words[1]);
    if (limit !== undefined && limit > LONG_COMMAND_SECONDS) return `timeout ${words[1]}`;
    return words.length > 2 ? segmentReason(words.slice(2), depth) : undefined;
  }
  if (head === 'sleep') { const pause = seconds(words[1]); return pause !== undefined && pause >= LONG_COMMAND_SECONDS ? `sleep ${words[1]}` : undefined; }
  const args = words.slice(1);
  if (args.some(arg => PROBE_FLAGS.has(arg))) return undefined;
  if (BUILD_SCRIPT.test(head)) return head;
  if (SHELLS.has(head)) {

    const at = args.findIndex(arg => SHELL_COMMAND_FLAGS.has(arg.toLowerCase()));
    if (at >= 0) return depth < MAX_SHELL_DEPTH ? longCommandReason(args.slice(at + 1).join(' '), undefined, depth + 1) : undefined;
    const script = args.find(arg => BUILD_SCRIPT.test(baseName(arg)));
    return script === undefined ? undefined : `${head} ${baseName(script)}`;
  }
  const flags = args.filter(arg => !arg.startsWith('-'));
  const sub = flags[0]?.toLowerCase(), second = flags[1]?.toLowerCase();
  if (NPM_LIKE.has(head)) {
    if (sub !== undefined && RUNNER_SUB.get('npm')?.has(sub)) return `${head} ${sub}`;
    if ((sub === 'run' || sub === 'run-script') && second !== undefined && isPackageScript(second)) return `${head} run ${second}`;
    return undefined;
  }
  if (NPX.has(head)) return sub !== undefined && NPX_RUNNER.has(sub) ? `${head} ${sub}` : undefined;
  if (head === 'playwright') return sub === 'test' || sub === 'install' ? `playwright ${sub}` : undefined;
  if (head === 'gh') {
    if (sub === 'run' && second === 'watch') return 'gh run watch';
    if (sub === 'pr' && second === 'checks' && args.includes('--watch')) return 'gh pr checks --watch';
    return undefined;
  }
  if (head === 'docker' && sub === 'compose') return second !== undefined && ['build', 'up', 'pull'].includes(second) ? `docker compose ${second}` : undefined;
  if (head === 'cmake') return args.includes('--build') ? 'cmake --build' : undefined;
  if (head === 'node') return args.includes('--test') ? 'node --test' : undefined;
  if (head === 'python' || head === 'python3' || head === 'py') {
    const module = args[args.indexOf('-m') + 1];
    return args.includes('-m') && (module === 'pytest' || module === 'unittest') ? `python -m ${module}` : undefined;
  }
  const subcommands = RUNNER_SUB.get(head);
  if (subcommands !== undefined) return sub !== undefined && subcommands.has(sub) ? `${head} ${sub}` : undefined;
  if (RUNNERS.has(head)) return head;
  return undefined;
}

/**
 * Why `command` is expected to run longer than LONG_COMMAND_SECONDS, or undefined for a short one. An explicit bash
 * `timeout` above the limit counts as the expectation. Pure, so every pattern is testable.
 */
export function longCommandReason(command: string, timeoutSeconds?: number, depth = 0): string | undefined {
  if (timeoutSeconds !== undefined && timeoutSeconds > LONG_COMMAND_SECONDS) return `timeout ${timeoutSeconds} s`;
  for (const words of commandSegments(command)) {
    const reason = segmentReason(words, depth);
    if (reason !== undefined) return reason;
  }
  return undefined;
}
