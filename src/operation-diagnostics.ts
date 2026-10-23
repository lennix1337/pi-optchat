// This intentionally recognizes only simple diagnostic commands, not general shell syntax.
// Git may execute configured helpers; ripwire may write caches/baselines.
type Word = { value: string; quoted: boolean };
/** `piped` marks a command fed by the previous command through `|`. */
type Command = { words: Word[]; piped: boolean };

const separator = /^(?:&&|\|\||;|\|)$/;

function diagnosticTokens(command: string): string[] | undefined {
  if (/[\r\n\0]/.test(command)) return undefined;
  // Quoted operators stay literal; unsupported expansions, escapes, word concatenation and
  // redirects fail closed. Only `2>&1` and output to /dev/null may disappear from the token list.
  const token = /\s+|(?:2>&1|[12]?>\s*\/dev\/null)(?=$|[\s;&|])|&&|\|\||[;|]|"[^"$`\\\r\n]*"|'[^'\r\n]*'|[^\s"'&;|$`<>\\(){}#!]+/gy;
  const tokens: string[] = [];
  let adjacent = false;
  for (let offset = 0; offset < command.length;) {
    token.lastIndex = offset;
    const match = token.exec(command);
    if (!match || match.index !== offset) return undefined;
    const value = match[0]; offset = token.lastIndex;
    if (/^\s/.test(value)) { adjacent = false; continue; }
    if (/^[12]?>/.test(value)) {
      // `"a"2>&1` is a concatenated shell word, not a descriptor redirection.
      if (adjacent && /^\d/.test(value)) return undefined;
      adjacent = false; continue;
    }
    if (separator.test(value)) adjacent = false;
    else {
      if (adjacent) return undefined;
      adjacent = true;
    }
    tokens.push(value);
  }
  return tokens;
}

function diagnosticCommands(command: string): Command[] | undefined {
  const tokens = diagnosticTokens(command);
  if (!tokens) return undefined;
  const commands: Command[] = [];
  let words: Word[] = [], piped = false;
  for (const value of tokens) {
    if (separator.test(value)) {
      if (!words.length) return undefined;
      commands.push({ words, piped }); words = []; piped = value === '|'; continue;
    }
    const quoted = value.startsWith('"') || value.startsWith("'");
    words.push({ value: quoted ? value.slice(1, -1) : value, quoted });
  }
  if (!words.length) return undefined;
  commands.push({ words, piped });
  return commands;
}

function readOnlyRipgrep(words: Word[]): boolean {
  let options = true, noConfig = false;
  for (const word of words.slice(1)) {
    // A glob could expand to an executable option such as --pre=... .
    if (!word.quoted && /[*?\[\]]/.test(word.value)) return false;
    if (options && word.value === '--') { options = false; continue; }
    if (!options || !word.value.startsWith('-')) continue;
    if (!['--no-config', '-n', '--line-number', '-i', '--ignore-case', '-l', '--files-with-matches', '--files', '-F', '--fixed-strings'].includes(word.value)) return false;
    if (word.value === '--no-config') noConfig = true;
  }
  // RIPGREP_CONFIG_PATH may supply --pre or decompression helpers even to a plain search.
  return noConfig || !process.env.RIPGREP_CONFIG_PATH;
}

// Only `sed -n <line>[,<line>]p <files>`: other scripts may write (`w`) or execute (`e`), and an
// unquoted glob could expand to a file named `-i`, which GNU sed would accept as in-place editing.
function readOnlySed(words: Word[]): boolean {
  return words.length >= 3 && words[1].value === '-n' && /^\d+(?:,\d+)?p$/.test(words[2].value)
    && words.slice(3).every(word => !word.value.startsWith('-') && (word.quoted || !/[*?\[\]]/.test(word.value)));
}

const hasGlob = (words: Word[]) => words.some(word => !word.quoted && /[*?\[\]]/.test(word.value));
/** Getopt-style long options accept any unique prefix, so `--out` still means `--output`. */
const abbreviates = (word: Word, option: string, minimum: number) => {
  const name = word.value.split('=')[0];
  return name.startsWith('--') && name.length >= minimum && option.startsWith(name) || name.startsWith(option);
};
const shortCluster = (word: Word, letter: string) => /^-[^-]/.test(word.value) && word.value.includes(letter);

// `diff` has no output option, but `--output` is refused anyway in case a build adds one.
const readOnlyDiff = (words: Word[]) => !words.some(word => abbreviates(word, '--output', 3));
// `-o`/`--output` write a file and `--compress-program` runs a helper.
const readOnlySort = (words: Word[]) => !words.some(word => shortCluster(word, 'o') || abbreviates(word, '--output', 3) || abbreviates(word, '--compress-program', 4));
// `file -C` compiles a magic database to disk.
const readOnlyFile = (words: Word[]) => !words.some(word => shortCluster(word, 'C') || abbreviates(word, '--compile', 4));

// `uniq [INPUT [OUTPUT]]`: a second operand is an output file.
function readOnlyUniq(words: Word[]): boolean {
  let operands = 0, valueNext = false, options = true;
  for (const word of words.slice(1)) {
    if (valueNext) { valueNext = false; continue; }
    if (options && word.value === '--') { options = false; continue; }
    if (options && ['-f', '-s', '-w', '--skip-fields', '--skip-chars', '--check-chars'].includes(word.value)) valueNext = true;
    else if (!options || !word.value.startsWith('-') || word.value === '-') operands++;
  }
  return operands <= 1;
}

function readOnlyBranch(words: Word[]): boolean {
  const flags = ['--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current', '--no-color'];
  const listing = words.some(word => word.value === '--list');
  // Operands are patterns only with --list; otherwise `git branch -v name` could create a branch.
  return words.every(word => flags.includes(word.value) || listing && !word.value.startsWith('-'));
}

function readOnlyGitConfig(words: Word[]): boolean {
  const rest = words.map(word => word.value);
  if (['--local', '--global', '--worktree', '--system'].includes(rest[0])) rest.shift();
  return rest.length === 2 && ['--get', '--get-all', '--get-regexp'].includes(rest[0]) && !rest[1].startsWith('-');
}

// Only inspections: `-C <dir>` and `--no-pager` may precede the subcommand. `-c`, pagers and
// `--ext-diff` can run configured programs and `--output` writes a file. Git may still run
// configured helpers such as textconv or fsmonitor; that residual risk is accepted.
function readOnlyGit(words: Word[]): boolean {
  let at = 1;
  for (; at < words.length; at++) {
    if (words[at].value === '--no-pager') continue;
    if (words[at].value !== '-C') break;
    const directory = words[++at];
    if (!directory || directory.value.startsWith('-')) return false;
  }
  const subcommand = words[at]?.value, rest = words.slice(at + 1);
  switch (subcommand) {
    case 'status': case 'log': case 'diff': case 'show': case 'rev-parse': case 'ls-files':
      return !rest.some(word => abbreviates(word, '--output', 3) || abbreviates(word, '--ext-diff', 4) || abbreviates(word, '--open-files-in-pager', 3));
    case 'branch': return readOnlyBranch(rest);
    case 'worktree': return rest.length >= 1 && rest[0].value === 'list' && rest.slice(1).every(word => ['--porcelain', '-v', '--verbose'].includes(word.value));
    case 'remote': return rest.every(word => ['-v', '--verbose'].includes(word.value));
    case 'config': return readOnlyGitConfig(rest);
    default: return false;
  }
}

function readOnlyWords({ words, piped }: Command): boolean {
  const name = words[0].value;
  // Beyond the long-standing set below, an unquoted glob could expand to an option.
  if (!['pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'echo', 'rg', 'sed', 'cd'].includes(name) && hasGlob(words)) return false;
  switch (name) {
    case 'rg': return readOnlyRipgrep(words);
    case 'sed': return readOnlySed(words);
    // `cd` only changes this shell's working directory; it is how most inspections start.
    case 'cd': return words.length === 2;
    case 'git': return readOnlyGit(words);
    case 'diff': return readOnlyDiff(words);
    case 'sort': return readOnlySort(words);
    case 'uniq': return readOnlyUniq(words);
    case 'file': return readOnlyFile(words);
    // `tr` only reads stdin; as the first command there is nothing it could usefully inspect.
    case 'tr': return piped;
    default: return ['pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'echo', 'cmp', 'od', 'stat', 'cut', 'nl', 'which', 'type', 'tasklist'].includes(name);
  }
}

export function isReadOnlyDiagnostic(tool: string, input: unknown): boolean {
  if (tool !== 'bash' || !input || typeof input !== 'object') return false;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== 'string' || !command.trim() || command.length > 8192) return false;
  return diagnosticCommands(command)?.every(readOnlyWords) ?? false;
}
