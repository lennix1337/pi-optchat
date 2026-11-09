import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Measured over 22 real sessions: native `edit` failed 6.5% of the time, bash scripts that patch
// files 15.3% (13.6% Python tracebacks), and text-mode Python on Windows turned LF files into CRLF.
// A bash result for such a command gets one short hint line; it never changes isError or the exit code.

type HintKind = 'edit' | 'read' | 'ripwire' | 'script' | 'tmp' | 'poll' | 'ghauth' | 'du';
const HINTS: Record<HintKind, string> = {
  edit: 'Hint: use the native edit/write tools for source changes; fewer errors, line endings kept.',
  read: 'Hint: use the native read tool with offset/limit instead of bash sed/cat/head.',
  script: 'Hint: inline node -e / python -c broke on quoting; write the script to a temp file with the write tool, then run it.',
  tmp: String.raw`Hint: Windows node/python read /tmp as C:\tmp, not Git Bash's /tmp; pass $(cygpath -w /tmp/FILE) or a project-relative path.`,
  poll: 'Hint: do not sleep-poll CI or a PR; gitwatch wakes you on its result (watch the repo, PR or branch), so keep working instead.',
  ghauth: 'Hint: to confirm the active gh account, `gh config get -h github.com user` reads it locally in ~50 ms; `gh auth status` calls the network (0.6 s, up to 12 s).',
  du: 'Hint: du walks every file of a Windows tree (node_modules included) and timed out; use `git ls-files | wc -l`, `find . -maxdepth 2` or skip node_modules.',
  ripwire: 'Hint: use the native ripwire tool (map/task/search/symbol/callers/callees/impact/exemplar/edit_check/quality/test_gate); CLI only for other flags.',
};
/** The same hint is shown at most once per this many bash calls in a session. */
export const HINT_INTERVAL = 10;

const SOURCE_PATH = /(?<![\w.-])[\w./\\:~@-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|cs|c|h|cpp|hpp|rb|php|swift|css|scss|html|vue|svelte|sh)(?![\w-])/gi;
// Build output is regenerated, so patching it with a script is not the habit being discouraged.
const GENERATED = /(?:^|[\\/])(?:dist|build|out|node_modules|coverage|target|\.next|generated)[\\/]/i;
const sourcePaths = (command: string) => (command.match(SOURCE_PATH) ?? []).filter(path => !GENERATED.test(path));

const SCRIPT_RUNNER = /(?:^|[\s;&|(])(?:python[\d.]*|py|node)(?:\.exe)?\s/i;
const FILE_WRITE = /\.write_text\(|\.write\(|\bopen\([^)]*,\s*['"][wa]b?\+?['"]|\bmode\s*=\s*['"][wa]|writeFileSync\(|writeFile\(|appendFile(?:Sync)?\(/;
function patchesSourceWithScript(command: string): boolean {
  // Printing through a stream is output, not a file write.
  const writes = FILE_WRITE.test(command.replace(/std(?:out|err)\.write\(/g, ''));
  return SCRIPT_RUNNER.test(command) && /<<|\s-c\s|\s-e\s/.test(command) && writes && sourcePaths(command).length > 0;
}
// `sed -i`, `sed -ni`, `sed --in-place=.bak`, `perl -pi -e`, `perl -i.bak`.
const IN_PLACE = /(?:^|[\s;&|(])(?:sed|perl)\s(?:[^|;&\n]*\s)?(?:-[A-Za-z]*i[^\s]*|--in-place[^\s]*)(?=\s)/;
const editsInPlace = (command: string) => IN_PLACE.test(command) && sourcePaths(command).length > 0;

const FILE = `(?:"[^"$\`\\n]+"|'[^'\\n]+'|[^\\s|&;<>$\`*?()\\\\\\[\\]'"-][^\\s|&;<>$\`*?()\\\\\\[\\]'"]*)`;
const PLAIN_READ = [
  new RegExp(`^sed\\s+-n\\s+'?\\d+(?:,\\d+)?p'?\\s+${FILE}$`),
  new RegExp(`^cat\\s+${FILE}$`),
  new RegExp(`^head\\s+(?:-n\\s*\\d+|-\\d+)\\s+${FILE}$`),
];
// An optional leading `cd dir &&` is how most inspections start.
const readsOneFile = (command: string) => {
  const rest = command.trim().replace(/^cd\s+\S+\s*&&\s*/, '');
  return PLAIN_READ.some(pattern => pattern.test(rest));
};

// An inline script whose own source failed to parse: shell quoting mangled it, so a retry with other escapes repeats the error.
const INLINE_SCRIPT = /(?:^|[\s;&|(])(?:python[\d.]*|py|node)(?:\.exe)?\s+-[ce]\s/i;
const PARSE_FAILURE = /SyntaxError|ERR_(?:UNSUPPORTED|INVALID)_TYPESCRIPT_SYNTAX|unexpected EOF while parsing|IndentationError/;

// Git Bash maps /tmp to %TEMP%, but a Windows program resolves "/tmp/x" against the drive root: node reports C:\tmp\x,
// python echoes the quoted '/tmp/x'. Bash's own "cat: /tmp/x: No such file" is a file that is really missing.
const WINDOWS_TMP_MISS = /ENOENT[^\n]*[A-Za-z]:\\tmp\\|(?:FileNotFoundError|No such file or directory)[^\n]*['"]\/tmp\//;

// A sleep of 15 s or more followed by a remote status check is a poll: gitwatch already delivers CI and PR results.
const SLEEP_POLL = /(?:^|[;&|(]\s*)sleep\s+(?:1[5-9]|[2-9]\d|\d{3,})\b[^\n]*?\b(?:gh\s+(?:run|pr|api)|git\s+fetch|curl)\b/;

// `gh auth status` validates tokens over the network; the active account is a local config value.
const GH_AUTH_STATUS = /(?:^|[;&|(]\s*)gh\s+auth\s+status\b/;
const GH_AUTH_SWITCH = /(?:^|[;&|(]\s*)gh\s+auth\s+(?:switch|login|refresh)\b/;

// `du -s` over a Windows worktree with node_modules ran into the bash timeout (90 s, no output).
const DU_SUMMARY = /(?:^|[;&|(]\s*)du\s+-[A-Za-z]*s/;
const TIMED_OUT = /timed out after \d+ seconds/;

const RIPWIRE_FLAGS = /(?:^|[;&|(]\s*)ripwire\b[^\n]*\s--(?:for|grep|callers|callees|impact|edit-check|quality-delta|test-gate)(?=[\s=]|$)/;

/** First applicable hint, or undefined. Pure so patterns are testable without a session. */
export function bashHint(command: string, ripwireTool: boolean, output = ''): HintKind | undefined {
  if (patchesSourceWithScript(command) || editsInPlace(command)) return 'edit';
  if (INLINE_SCRIPT.test(command) && PARSE_FAILURE.test(output)) return 'script';
  if (command.includes('/tmp/') && WINDOWS_TMP_MISS.test(output)) return 'tmp';
  if (SLEEP_POLL.test(command)) return 'poll';
  if (GH_AUTH_STATUS.test(command) && !GH_AUTH_SWITCH.test(command)) return 'ghauth';
  if (DU_SUMMARY.test(command) && TIMED_OUT.test(output)) return 'du';
  if (ripwireTool && RIPWIRE_FLAGS.test(command)) return 'ripwire';
  if (readsOneFile(command)) return 'read';
  return undefined;
}

// Keep Pi's trailing "Command exited with code N" as the last line of the result.
function withHint(text: string, hint: string): string {
  const exit = /\n*(Command exited with code \d+)\s*$/.exec(text);
  return exit ? `${text.slice(0, exit.index)}\n${hint}\n\n${exit[1]}` : `${text.replace(/\s+$/, '')}\n${hint}`;
}

/** Register after registerOperationSafety so it classifies the unmodified result. */
export function registerBashHints(pi: ExtensionAPI) {
  const sessions = new Map<string, { calls: number; shown: Map<HintKind, number>; previous?: HintKind }>();
  pi.on('tool_result', (event, ctx) => {
    if (event.toolName !== 'bash') return;
    const command = (event.input as { command?: unknown } | undefined)?.command;
    if (typeof command !== 'string') return;
    const session = ctx.sessionManager.getSessionId();
    let state = sessions.get(session);
    if (!state) sessions.set(session, state = { calls: 0, shown: new Map() });
    const call = ++state.calls;
    const output = event.content.map(part => part.type === 'text' ? (part as { text: string }).text : '').join('\n');
    const kind = bashHint(command, pi.getAllTools().some(tool => tool.name === 'ripwire'), output);
    const previous = state.previous;
    state.previous = kind;
    if (!kind) return;
    const last = state.shown.get(kind);
    // A patch script retried straight after another one is the loop the hint exists for: repeat it.
    const retryLoop = kind === previous && (kind === 'edit' || kind === 'script');
    if (!retryLoop && last !== undefined && call - last < HINT_INTERVAL) return;
    state.shown.set(kind, call);
    const content = [...event.content];
    const at = content.map(part => part.type).lastIndexOf('text');
    if (at < 0) content.push({ type: 'text', text: HINTS[kind] });
    else content[at] = { type: 'text', text: withHint((content[at] as { text: string }).text, HINTS[kind]) };
    return { content };
  });
  pi.on('session_shutdown', (_event, ctx) => { sessions.delete(ctx.sessionManager.getSessionId()); });
}
