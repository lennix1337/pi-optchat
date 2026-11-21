import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';


// external: Git may execute configured helpers; Ripwire may write caches or baselines.
type Word = { value: string; quoted: boolean };

type Command = { words: Word[]; piped: boolean };

const separator = /^(?:&&|\|\||;|\|)$/;

function diagnosticTokens(command: string): string[] | undefined {
  if (/[\r\n\0]/.test(command)) return undefined;
  // external: Bash expands $? to a numeric exit status.

  command = command.replace(/\$\?(?![\w?*\[])/g, '0');
  // external: Bash treats quoted operators as literals; in double quotes backslash behavior depends on the next character.


  const token = /\s+|(?:2>&1|[12]?>\s*\/dev\/null)(?=$|[\s;&|])|&&|\|\||[;|]|"(?:[^"$`\\\r\n]|\\[^"$`\\\r\n])*"|'[^'\r\n]*'|[^\s"'&;|$`<>\\(){}#!]+/gy;
  const tokens: string[] = [];
  let adjacent = false;
  for (let offset = 0; offset < command.length;) {
    token.lastIndex = offset;
    const match = token.exec(command);
    if (!match || match.index !== offset) return undefined;
    const value = match[0]; offset = token.lastIndex;
    if (/^\s/.test(value)) { adjacent = false; continue; }
    if (/^[12]?>/.test(value)) {
      // external: Bash treats an adjacent quoted word and redirection descriptor as concatenated shell text.
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
    // external: A shell glob may expand to an executable option.
    if (!word.quoted && /[*?\[\]]/.test(word.value)) return false;
    if (options && word.value === '--') { options = false; continue; }
    if (!options || !word.value.startsWith('-')) continue;
    if (!['--no-config', '-n', '--line-number', '-i', '--ignore-case', '-l', '--files-with-matches', '--files', '-F', '--fixed-strings'].includes(word.value)) return false;
    if (word.value === '--no-config') noConfig = true;
  }
  // external: RIPGREP_CONFIG_PATH may enable preprocessors or decompression helpers.
  return noConfig || !process.env.RIPGREP_CONFIG_PATH;
}

// external: GNU sed can write or execute through script commands and accepts -i for in-place editing.

function readOnlySed(words: Word[], piped: boolean): boolean {
  return piped && streamSubstitution(words) || words.length >= 3 && words[1].value === '-n' && /^\d+(?:,\d+)?p$/.test(words[2].value)
    && words.slice(3).every(word => !word.value.startsWith('-') && (word.quoted || !/[*?\[\]]/.test(word.value)));
}

// external: GNU sed substitution flags can invoke write or execute commands.

const SUBSTITUTION = /^s\/(?:[^\/\\]|\\.)*\/(?:[^\/\\]|\\.)*\/[gIi]*$/;
function streamSubstitution(words: Word[]): boolean {
  const script = words[words.length - 1];
  const options = words.slice(1, -1);
  return words.length >= 2 && script.quoted && SUBSTITUTION.test(script.value)
    && options.every(word => word.value === '-E' || word.value === '-r');
}

const hasGlob = (words: Word[]) => words.some(word => !word.quoted && /[*?\[\]]/.test(word.value));
// external: Getopt-style long options accept any unique prefix.
const abbreviates = (word: Word, option: string, minimum: number) => {
  const name = word.value.split('=')[0];
  return name.startsWith('--') && name.length >= minimum && option.startsWith(name) || name.startsWith(option);
};
const shortCluster = (word: Word, letter: string) => /^-[^-]/.test(word.value) && word.value.includes(letter);


const readOnlyDiff = (words: Word[]) => !words.some(word => abbreviates(word, '--output', 3));
// external: diff -o/--output writes a file and --compress-program runs a helper.
const readOnlySort = (words: Word[]) => !words.some(word => shortCluster(word, 'o') || abbreviates(word, '--output', 3) || abbreviates(word, '--compress-program', 4));
// external: file -C writes a compiled magic database.
const readOnlyFile = (words: Word[]) => !words.some(word => shortCluster(word, 'C') || abbreviates(word, '--compile', 4));

// external: uniq uses a second operand as an output file.
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
  // external: git branch -v with a name can create a branch unless --list is set.
  return words.every(word => flags.includes(word.value) || listing && !word.value.startsWith('-'));
}

function readOnlyGitConfig(words: Word[]): boolean {
  const rest = words.map(word => word.value);
  if (['--local', '--global', '--worktree', '--system'].includes(rest[0])) rest.shift();
  return rest.length === 2 && ['--get', '--get-all', '--get-regexp'].includes(rest[0]) && !rest[1].startsWith('-');
}

// external: Git options and configured helpers such as textconv or fsmonitor may run programs or write files.


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
    case 'status': case 'log': case 'diff': case 'show': case 'rev-parse': case 'ls-files': case 'grep':
      // external: git grep -O opens matches in a pager or editor.
      return !rest.some(word => abbreviates(word, '--output', 3) || abbreviates(word, '--ext-diff', 4) || abbreviates(word, '--open-files-in-pager', 3)
        || subcommand === 'grep' && shortCluster(word, 'O'));
    case 'branch': return readOnlyBranch(rest);
    case 'worktree': return rest.length >= 1 && rest[0].value === 'list' && rest.slice(1).every(word => ['--porcelain', '-v', '--verbose'].includes(word.value));
    case 'remote': return rest.every(word => ['-v', '--verbose'].includes(word.value));
    case 'config': return readOnlyGitConfig(rest);

    case 'stash': return rest.length >= 1 && rest[0].value === 'list' && rest.slice(1).every(word => ['--oneline', '--stat', '--no-color'].includes(word.value));
    // external: git ls-remote --upload-pack runs a program; -o sends options to the server.
    case 'ls-remote': return rest.every(word => !word.value.startsWith('-') || ['--heads', '--tags', '--refs', '-q', '--quiet', '--symref'].includes(word.value));
    default: return false;
  }
}

// external: find can execute, delete and write files.
const FIND_MUTATING = /^-(?:exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/;
const readOnlyFind = (words: Word[]) => !words.some(word => FIND_MUTATING.test(word.value));



const GH_READS: Record<string, string[]> = {
  pr: ['view', 'list', 'checks', 'diff', 'status'], run: ['list', 'view'], issue: ['view', 'list', 'status'], auth: ['status'],
};
const GH_FLAGS = new Set(['--json', '--jq', '-q', '--repo', '-R', '--limit', '-L', '--state', '-s', '--branch', '-b', '--author', '-A', '--label', '-l',
  '--search', '-S', '--base', '--head', '--draft', '--comments', '-c', '--log', '--log-failed', '--job', '-j', '--name-only', '--patch', '--required', '--hostname', '--workflow', '-w']);
function readOnlyGh(words: Word[]): boolean {
  const rest = words.slice(1).map(word => word.value);
  if (rest[0] === 'api') {
    // external: GitHub GraphQL uses POST.
    const args = rest.slice(1);
    const paths = args.filter((value, at) => !value.startsWith('-') && !['--jq', '-q'].includes(args[at - 1]));
    return paths.length === 1 && paths[0] !== 'graphql' && args.every(value => !value.startsWith('-') || ['--jq', '-q', '--paginate'].includes(value));
  }
  if (!rest[0] || !GH_READS[rest[0]]?.includes(rest[1] ?? '')) return false;
  // external: gh -w opens the browser on pr/issue but means --workflow on run list.
  return rest.slice(2).every(value => !value.startsWith('-') || GH_FLAGS.has(value) && !(value === '-w' && rest[0] !== 'run'));
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const CURL_FLAGS = /^-[sSfiIv]+$/;
const CURL_LONG_FLAGS = new Set(['--silent', '--show-error', '--fail', '--include', '--head', '--verbose', '--compressed', '-q', '--disable']);
const CURL_VALUES = new Set(['-m', '--max-time', '--connect-timeout', '-w', '--write-out', '-o', '--output']);
// external: curlrc can add output files or request bodies unless disabled with -q/--disable first.
const curlrc = () => [process.env.CURL_HOME, process.env.XDG_CONFIG_HOME, homedir(), process.env.APPDATA]
  .filter((dir): dir is string => !!dir).some(dir => existsSync(join(dir, '.curlrc')) || existsSync(join(dir, '_curlrc')));


function curlOperand(words: Word[]): string | undefined {
  let url: string | undefined;
  for (let at = 1; at < words.length; at++) {
    const value = words[at].value;
    if (CURL_VALUES.has(value)) {
      const operand = words[++at]?.value;
      if (operand === undefined || ['-o', '--output'].includes(value) && operand !== '/dev/null') return undefined;
    } else if (!CURL_FLAGS.test(value) && !CURL_LONG_FLAGS.has(value)) {
      if (value.startsWith('-') || url !== undefined) return undefined;
      url = value;
    }
  }
  return url;
}

function loopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password && LOOPBACK.has(parsed.hostname);
  } catch { return false; }
}


function readOnlyCurl(words: Word[]): boolean {
  const url = curlOperand(words);
  const skipsConfig = ['-q', '--disable'].includes(words[1]?.value);
  return url !== undefined && (skipsConfig || !curlrc()) && loopbackUrl(url);
}




const PS_CMDLETS = new Set(['get-ciminstance', 'get-process', 'get-service', 'get-content', 'get-childitem', 'get-item', 'get-itemproperty', 'get-date',
  'get-nettcpconnection', 'test-path', 'select-string', 'where-object', 'foreach-object', 'select-object', 'sort-object', 'group-object', 'measure-object',
  'format-table', 'format-list', 'convertto-json', 'convertfrom-json', 'out-string', 'write-output', 'write-host']);
const PS_OPTIONS = new Set(['-noprofile', '-noninteractive', '-nologo']);

function readOnlyPowerShellScript(script: string): boolean {
  if (script.length > 2000 || /[\x00-\x1f]/.test(script)) return false;
  let bad = false;

  const code = script.replace(/'(?:[^']|'')*'|"(?:[^"`]|"")*"/g, (text) => {
    if (text.startsWith('"') && /\$[({]/.test(text)) bad = true;
    return '\u0001';
  });
  if (bad || /['"`<>&?]|::/.test(code) || /\.\s*[\w$]*\s*\(/.test(code) || /\.\s*[$(\[@\u0001]/.test(code)) return false;

  const slots = [0];
  for (let at = 0; at < code.length; at++) if ('|;{(='.includes(code[at])) slots.push(at + 1);
  for (const slot of slots) {
    const start = slot + (/^\s*/.exec(code.slice(slot))![0].length), first = code[start];
    if (first === undefined || /[$@\[\d\-{}()|;=\u0001]/.test(first)) continue;
    if (!PS_CMDLETS.has(/[\w.-]*/.exec(code.slice(start))![0].toLowerCase())) return false;
  }
  return true;
}

function readOnlyPowerShell(words: Word[]): boolean {
  let at = 1;
  while (PS_OPTIONS.has(words[at]?.value.toLowerCase())) at++;
  const flag = words[at]?.value.toLowerCase();
  const script = words[at + 1];
  return (flag === '-command' || flag === '-c') && !!script?.quoted && words.length === at + 2 && readOnlyPowerShellScript(script.value);
}

// external: docker logs -f follows indefinitely.
const DOCKER_READS = new Set(['ps', 'stats', 'logs', 'inspect', 'images', 'top', 'version', 'info', 'port', 'diff']);
const readOnlyDocker = (words: Word[]) => DOCKER_READS.has(words[1]?.value ?? '') && !hasGlob(words)
  && !words.some(word => word.value === '--follow' || shortCluster(word, 'f') && words[1].value === 'logs');

// external: SSH options such as ProxyCommand can run local programs; other options can open tunnels.

function readOnlySsh(words: Word[]): boolean {
  let at = 1;
  while (words[at]?.value === '-o' && /^(?:BatchMode=yes|ConnectTimeout=\d+)$/.test(words[at + 1]?.value ?? '')) at += 2;
  const host = words[at]?.value, remote = words[at + 1];
  if (!host || !/^[\w][\w.@-]*$/.test(host) || !remote?.quoted || words.length !== at + 2) return false;
  const inner = diagnosticCommands(remote.value);
  return !!inner && inner.every(readOnlyWords);
}

function readOnlyWords({ words, piped }: Command): boolean {
  const name = words[0].value;

  if (!['pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'echo', 'rg', 'sed', 'cd'].includes(name) && hasGlob(words)) return false;
  switch (name) {
    case 'rg': return readOnlyRipgrep(words);
    case 'sed': return readOnlySed(words, piped);

    case 'cd': return words.length === 2;
    case 'git': return readOnlyGit(words);
    case 'diff': return readOnlyDiff(words);
    case 'sort': return readOnlySort(words);
    case 'uniq': return readOnlyUniq(words);
    case 'file': return readOnlyFile(words);
    case 'curl': return readOnlyCurl(words);
    case 'date': return words.slice(1).every(word => word.value.startsWith('+') || ['-u', '--utc', '--universal'].includes(word.value));
    case 'find': return readOnlyFind(words);
    case 'gh': return readOnlyGh(words);
    case 'docker': return readOnlyDocker(words);
    case 'ssh': return readOnlySsh(words);
    case 'powershell': case 'powershell.exe': case 'pwsh': case 'pwsh.exe': return readOnlyPowerShell(words);

    case 'tr': return piped;
    default: return ['pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'echo', 'cmp', 'od', 'stat', 'cut', 'nl', 'which', 'type', 'tasklist', 'netstat', 'ps'].includes(name);
  }
}


const READ_TOOLS = new Set(['shell_status', 'read_many', 'get_search_content', 'project_evidence', 'get_goal']);

const OBSERVING: Record<string, { field: string; fallback?: string; actions: Set<string> }> = {
  browser_harness: { field: 'action', fallback: 'status', actions: new Set(['status', 'inspect', 'state', 'screenshot', 'read']) },
  desktop: { field: 'command', fallback: 'status', actions: new Set(['snapshot', 'find', 'get', 'is', 'screenshot', 'list-windows', 'list-displays', 'list-apps', 'list-surfaces', 'list-notifications', 'clipboard-get', 'wait', 'status', 'version', 'skills']) },
  gitwatch: { field: 'action', fallback: 'status', actions: new Set(['status']) },
  commitments: { field: 'action', actions: new Set(['list']) },
};

function observingCall(tool: string, input: unknown): boolean {
  const spec = OBSERVING[tool];
  if (!spec || !input || typeof input !== 'object' || Array.isArray(input)) return false;
  const action = (input as Record<string, unknown>)[spec.field] ?? spec.fallback;
  return typeof action === 'string' && spec.actions.has(action);
}

export function isReadOnlyDiagnostic(tool: string, input: unknown): boolean {
  if (READ_TOOLS.has(tool)) return true;
  if (tool in OBSERVING) return observingCall(tool, input);
  if (tool !== 'bash' || !input || typeof input !== 'object') return false;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== 'string' || !command.trim() || command.length > 8192) return false;
  return diagnosticCommands(command)?.every(readOnlyWords) ?? false;
}
