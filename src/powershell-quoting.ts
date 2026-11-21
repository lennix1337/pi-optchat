import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// external: Bash expands dollar variables in double quotes before PowerShell receives them.





const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g;
const INVOCATION = /(?:^|[\s;&|(])(?:powershell|pwsh)(?:\.exe)?(?=\s)/gi;

const POWERSHELL_DOLLAR = /(?<!\\)\$(?:_(?!\w)|env:|PSItem\b|true\b|false\b|null\b|\(|[A-Za-z_]\w*[.[:])/i;


const FILE_FLAG = /^-f(?:ile)?(?=\s|$)/i;


function doubleQuoted(command: string, from: number): string[] {
  const strings: string[] = [];
  for (let at = from; at < command.length; at++) {
    const char = command[at];
    if (char === '\n' || char === ';' || char === '|' || char === '&') break;

    if (char === '-' && /\s/.test(command[at - 1]) && FILE_FLAG.test(command.slice(at))) return [];
    if (char === "'") { const end = command.indexOf("'", at + 1); if (end < 0) break; at = end; continue; }
    if (char !== '"') continue;
    let end = at + 1;
    while (end < command.length && command[end] !== '"') end += command[end] === '\\' ? 2 : 1;
    strings.push(command.slice(at + 1, end));
    at = end;
  }
  return strings;
}


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
