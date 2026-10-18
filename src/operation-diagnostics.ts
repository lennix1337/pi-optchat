// This intentionally recognizes only simple diagnostic commands, not general shell syntax.
// Git may execute configured helpers; ripwire may write caches/baselines.
type Word = { value: string; quoted: boolean };

function diagnosticCommands(command: string): Word[][] | undefined {
  if (/[\r\n\0]/.test(command)) return undefined;
  // Operators inside quotes are literal arguments. Expansions/escapes are unsupported outside
  // single quotes; concatenated shell words are rejected rather than partially interpreted.
  const token = /\s+|&&|\|\||[;|]|"[^"$`\\\r\n]*"|'[^'\r\n]*'|[^\s"'&;|$`<>\\(){}#!]+/gy;
  const commands: Word[][] = [];
  let words: Word[] = [], adjacent = false;
  for (let offset = 0; offset < command.length;) {
    token.lastIndex = offset;
    const match = token.exec(command);
    if (!match || match.index !== offset) return undefined;
    const value = match[0]; offset = token.lastIndex;
    if (/^\s/.test(value)) { adjacent = false; continue; }
    if (/^(?:&&|\|\||;|\|)$/.test(value)) {
      if (!words.length) return undefined;
      commands.push(words); words = []; adjacent = false; continue;
    }
    if (adjacent) return undefined;
    const quoted = value.startsWith('"') || value.startsWith("'");
    words.push({ value: quoted ? value.slice(1, -1) : value, quoted });
    adjacent = true;
  }
  if (!words.length) return undefined;
  commands.push(words);
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

function readOnlyWords(words: Word[]): boolean {
  switch (words[0].value) {
    case 'rg': return readOnlyRipgrep(words);
    case 'sed': return readOnlySed(words);
    // `cd` only changes this shell's working directory; it is how most inspections start.
    case 'cd': return words.length === 2;
    default: return ['pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'echo'].includes(words[0].value);
  }
}

export function isReadOnlyDiagnostic(tool: string, input: unknown): boolean {
  if (tool !== 'bash' || !input || typeof input !== 'object') return false;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== 'string' || !command.trim() || command.length > 8192) return false;
  return diagnosticCommands(command)?.every(readOnlyWords) ?? false;
}
