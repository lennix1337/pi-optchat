import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';






export const SKIPPED_DIRS = ['node_modules', '.git', '.worktrees', 'worktrees'];
const EXCLUDES = SKIPPED_DIRS.map(dir => `--exclude-dir=${dir}`).join(' ');
const NAMES_SKIPPED_DIR = new RegExp(`(?:^|[\\\\/])(?:${SKIPPED_DIRS.map(dir => dir.replace('.', '\\.')).join('|')})(?:[\\\\/]|$)`);
const RECURSIVE = /^(?:-[A-Za-z]*[rR][A-Za-z]*|--recursive|--dereference-recursive)$/;
export const NOTE = `Note: grep -r skipped ${SKIPPED_DIRS.join(', ')}; name one of them in the path or pass your own --exclude-dir to search it.`;

const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g;

interface Word { text: string; start: number }



const PREFIX_WORD = /^(?:time|command|nice|env|timeout|[A-Za-z_]\w*=\S*|-\w+|\d+[smhd]?)$/;


function commandWords(command: string, from: number): Word[] {
  const words: Word[] = [];
  let current: Word | undefined;
  let quote: string | undefined;
  for (let at = from; at < command.length; at++) {
    const char = command[at];
    if (!quote && /[\n;&|()<>]/.test(char)) break;
    if (!quote && /\s/.test(char)) { if (current) words.push(current); current = undefined; continue; }
    current ??= { text: '', start: at };
    current.text += char;
    if (quote === '"' && char === '\\') { current.text += command[++at] ?? ''; continue; }
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === '\\') { current.text += command[++at] ?? ''; continue; }
    if (char === '"' || char === "'") quote = char;
  }
  if (current) words.push(current);
  return words;
}


function grepCommands(command: string): number[] {
  const starts: number[] = [];
  let quote: string | undefined;
  let commandStart = true;
  for (let at = 0; at < command.length; at++) {
    const char = command[at];
    if (quote === '"' && char === '\\') { at++; continue; }
    if (quote) { if (char === quote) quote = undefined; continue; }
    if (char === '"' || char === "'") { quote = char; commandStart = false; continue; }
    if (/[\n;&|(]/.test(char)) { commandStart = true; continue; }
    if (/\s/.test(char)) continue;
    if (commandStart && /^grep(?=\s)/.test(command.slice(at, at + 5))) starts.push(at);
    const wordStart = at;
    while (at + 1 < command.length && !/[\s\n;&|()"']/.test(command[at + 1])) at++;
    commandStart &&= PREFIX_WORD.test(command.slice(wordStart, at + 1));
  }
  return starts;
}

/** The command with node_modules and worktrees excluded from each recursive grep that does not ask for them, or undefined. */
export function narrowRecursiveGrep(command: string): string | undefined {

  const scan = command.replace(HEREDOC, match => match.replace(/[^\n]/g, ' '));
  const inserts: number[] = [];
  for (const start of grepCommands(scan)) {
    const args = commandWords(scan, start + 4);
    if (!args.some(word => RECURSIVE.test(word.text))) continue;
    if (args.some(word => word.text.startsWith('--exclude-dir') || NAMES_SKIPPED_DIR.test(word.text))) continue;
    inserts.push(start + 4);
  }
  if (!inserts.length) return undefined;
  let result = command;
  for (const at of inserts.reverse()) result = `${result.slice(0, at)} ${EXCLUDES}${result.slice(at)}`;
  return result;
}

export function registerRecursiveGrepNarrowing(pi: ExtensionAPI) {
  const narrowed = new Set<string>();
  pi.on('tool_call', event => {
    if (event.toolName !== 'bash') return;
    const input = event.input as { command?: unknown } | undefined;
    if (typeof input?.command !== 'string') return;
    const command = narrowRecursiveGrep(input.command);
    if (!command) return;
    input.command = command;
    narrowed.add(event.toolCallId);
  });
  pi.on('tool_result', event => {
    if (event.toolName !== 'bash' || !narrowed.delete(event.toolCallId)) return;
    const content = [...event.content];
    const at = content.map(part => part.type).lastIndexOf('text');
    if (at < 0) content.push({ type: 'text', text: NOTE });
    else {
      const text = (content[at] as { text: string }).text;
      const exit = /\n*(Command exited with code \d+)\s*$/.exec(text);
      content[at] = { type: 'text', text: exit ? `${text.slice(0, exit.index)}\n${NOTE}\n\n${exit[1]}` : `${text.replace(/\s+$/, '')}\n${NOTE}` };
    }
    return { content };
  });

  pi.on('tool_execution_end', event => { narrowed.delete(event.toolCallId); });
}
