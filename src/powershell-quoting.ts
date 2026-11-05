import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// 03/11: `powershell -Command "... | Where-Object { $_.CommandLine ... }"` ran from bash twice in one hour. Bash expands
// `$_` (its last argument) and `$p.Id` (an unset variable plus ".Id") inside double quotes before PowerShell starts, so
// the filter failed eight times per call with CommandNotFoundException and the probe returned nothing. The fix every
// time was a .ps1 file run with -File; the guard says so before the call runs instead of after it fails.

// A heredoc's body is file content being written (a .ps1 included), not a command line.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g;
const INVOCATION = /(?:^|[\s;&|(])(?:powershell|pwsh)(?:\.exe)?(?=\s)/gi;
/** PowerShell-only forms: `$_`, `$env:X`, `$PSItem`, `$true/$false/$null`, `$(...)`, `$x.Prop`, `$x[0]`, `$script:x`. */
const POWERSHELL_DOLLAR = /(?<!\\)\$(?:_(?!\w)|env:|PSItem\b|true\b|false\b|null\b|\(|[A-Za-z_]\w*[.[:])/i;

/** Double-quoted strings bash sees in one PowerShell invocation, up to the first unquoted separator. */
function doubleQuoted(command: string, from: number): string[] {
  const strings: string[] = [];
  for (let at = from; at < command.length; at++) {
    const char = command[at];
    if (char === '\n' || char === ';' || char === '|' || char === '&') break;
    if (char === "'") { const end = command.indexOf("'", at + 1); if (end < 0) break; at = end; continue; }
    if (char !== '"') continue;
    let end = at + 1;
    while (end < command.length && command[end] !== '"') end += command[end] === '\\' ? 2 : 1;
    strings.push(command.slice(at + 1, end));
    at = end;
  }
  return strings;
}

/** Whether `index` falls inside a quoted string, where `powershell` is text (a grep pattern) rather than a call. */
function insideQuotes(command: string, index: number): boolean {
  let quote: string | undefined;
  for (let at = 0; at < index; at++) {
    const char = command[at];
    if (quote === '"' && char === '\\') { at++; continue; }
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === '\\') { at++; continue; }
    if (char === '"' || char === "'") quote = char;
  }
  return quote !== undefined;
}

/** The PowerShell variable bash would expand first, or undefined. Pure so the patterns are testable. */
export function bashMangledPowerShell(command: string): string | undefined {
  const text = command.replace(HEREDOC, '');
  for (const match of text.matchAll(INVOCATION)) {
    if (insideQuotes(text, match.index! + match[0].search(/\S/))) continue;
    for (const body of doubleQuoted(text, match.index! + match[0].length)) {
      const hit = POWERSHELL_DOLLAR.exec(body);
      if (hit) return hit[0].replace(/[.[]$/, '');
    }
  }
  return undefined;
}

export function registerPowerShellQuotingGuard(pi: ExtensionAPI) {
  pi.on('tool_call', event => {
    if (event.toolName !== 'bash') return;
    const command = (event.input as { command?: unknown } | undefined)?.command;
    if (typeof command !== 'string') return;
    const variable = bashMangledPowerShell(command);
    if (!variable) return;
    return { block: true, reason: `Not run: bash expands ${variable} inside the double quotes before PowerShell starts, so PowerShell would get a different script. Write the script to a .ps1 file and run \`powershell -NoProfile -ExecutionPolicy Bypass -File <file>\`, put the -Command script in single quotes, or escape each PowerShell $ as \\$.` };
  });
}
