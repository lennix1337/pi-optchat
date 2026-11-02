/**
 * Bash calls expected to run long. The main agent blocks on a foreground bash call until it ends, so a build or a
 * test suite holds the operator's reply. Such a call is moved to a managed background shell instead (shells.ts), whose
 * end arrives as a message. Measured over 21,413 bash calls in the OptChat main session (2026-10-08 to 2026-11-02):
 * 494 ran over 60 s and 210 over 120 s; the long ones were package scripts, test runners, builds, wsl/pwsh wrappers.
 */

/** A foreground bash call longer than this (seconds) is moved to a background shell. */
export const LONG_COMMAND_SECONDS = 120;

/** What the bash tool's description says about the move, so the model reads the result as a shell ID. */
export const LONG_COMMAND_NOTE = `Commands expected to run long (test suites, builds, dev servers, a timeout above ${LONG_COMMAND_SECONDS} s) are moved to a background shell: this call returns its ID at once, and the outcome arrives later as a "[shell ID]" message.`;

const MAX_SHELL_DEPTH = 3;
/** Commands that run another command: their argument is classified in its turn. */
const PREFIX_WRAPPERS = new Set(['time', 'nohup', 'exec', 'command', 'env', 'caffeinate']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'wsl', 'pwsh', 'powershell', 'cmd']);
/** The flags that give a shell its command text. */
const SHELL_COMMAND_FLAGS = new Set(['-c', '-lc', '-ic', '-e', '-command', '/c']);
/** A question about the tool, not a run of it: `npm test --help` is short. */
const PROBE_FLAGS = new Set(['--help', '-h', '--version', '-v', '-V', '--list']);
/** Script files whose run is a build or a suite: `.\build.ps1`, `pwsh -File test.ps1`. */
const BUILD_SCRIPT = /^(build|test|publish|release)\.(ps1|sh)$/i;
/** Words of an npm script name (`test:unit`, `build-prod`) that mark it as a build, a suite or a server: it runs until done or stopped. */
const PACKAGE_SCRIPT_WORDS = new Set(['test', 'tests', 'build', 'ci', 'e2e', 'verify', 'check', 'typecheck', 'lint', 'coverage', 'bench', 'compile', 'dist', 'package', 'release', 'dev', 'start', 'serve', 'watch', 'storybook']);
const isPackageScript = (name: string) => name.split(/[:._-]+/).some(word => PACKAGE_SCRIPT_WORDS.has(word));

const NPM_LIKE = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Tool -> subcommands that run long (a Map: a command name must not reach Object.prototype). */
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

/** Seconds from a `timeout`/`sleep` argument (`120`, `2m`, `1.5h`), or undefined when it is not one. */
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

/** Why one simple command (its words) runs long, or undefined. */
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
    // `wsl -e bash -lc "cd x && npm test"`: the text after the flag is a command of its own.
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
