import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** What happened to one execution, in words the operator can read in the log. */
export type ExecClass = 'ok' | 'exit_nonzero' | 'timeout' | 'not_found' | 'refused' | 'aborted' | 'network' | 'rate_limited' | 'error';
export type ExecEntry = { at: string; source: 'tool' | 'background'; name: string; target?: string; class: ExecClass; ms?: number; code?: number; detail?: string };

export const EXEC_LOG = 'exec-log.jsonl';
/** One live file plus one rotated `.1`: at most about 2 MB on disk. */
export const EXEC_LOG_MAX_BYTES = 1_000_000;

const clip = (text: string, max: number) => { const one = text.replace(/\s+/g, ' ').trim(); return one.length > max ? `${one.slice(0, max - 1)}…` : one; };
/** A failure's reason (the error line, the exit code) is at the end of its output: keep the tail. */
const clipTail = (text: string, max: number) => { const one = text.replace(/\s+/g, ' ').trim(); return one.length > max ? `…${one.slice(one.length - max + 1)}` : one; };

/** Classifies from the error text; order matters: a gate refusal or timeout also carries a non-zero exit. */
export function classify(failed: boolean, text: string, code?: number | string): ExecClass {
  // A call that did not fail is ok whatever its output says (a grep hit on "timeout" is not a timeout).
  if (!failed) return 'ok';
  // A command that ran to its own exit code is judged by that code; 124/137/143 are timeout/SIGKILL/SIGTERM inside it.
  const exit = typeof code === 'number' ? code : /exited with code (\d+)\s*$/.exec(text)?.[1];
  if (exit !== undefined && Number(exit) !== 0) return [124, 137, 143].includes(Number(exit)) ? 'timeout' : 'exit_nonzero';
  if (/^Not (executed|run):|refused by|autonomy gate|blocked by/i.test(text)) return 'refused';
  if (/timed? ?out|ETIMEDOUT|SIGTERM/i.test(text) || code === 'ETIMEDOUT') return 'timeout';
  if (/aborted|AbortError|cancell?ed by/i.test(text)) return 'aborted';
  if (/ENOENT|command not found|not recognized as/i.test(text) || code === 'ENOENT') return 'not_found';
  if (/rate limit|API rate|HTTP 429|secondary rate/i.test(text)) return 'rate_limited';
  if (/ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network|connection reset|TLS handshake/i.test(text)) return 'network';
  return 'error';
}

/** `grep`/`rg` exit 1 with nothing printed means "no match": the answer to the question, not a failed call. */
export function isNoMatch(command: string | undefined, text: string): boolean {
  // split() with a capture group alternates command, separator, command, ...; a trailing blank (final newline) carries no command.
  const tokens = (command ?? '').split(/(&&|\|\||\||;|\n)/);
  while (tokens.length > 1 && tokens[tokens.length - 1].trim() === '') tokens.length -= 2;
  const last = (tokens.pop() ?? '').trim();
  if (!/^(?:grep|egrep|fgrep|rg)\s/.test(last)) return false;
  // After `;`, a newline or a single pipe the exit code is the last command's, so earlier output proves nothing;
  // after `&&` or `||` it may be an earlier command's exit, so only an empty output shows a miss.
  const before = tokens.pop();
  if (before === ';' || before === '|' || before === '\n') return true;
  return text.replace(/\n*Command exited with code \d+\s*$/, '').replace(/^\(no output\)$/i, '').trim() === '';
}

/** `ship.mjs` exits 3 (`not_queued`) when it opened the PR but its checks are still pending: the work is shipped and gitwatch reports the rest, so it is not a failed call. */
export function isShipWait(command: string | undefined, text: string): boolean {
  return /ship\.mjs/.test(command ?? '') && /^status: not_queued$/m.test(text) && /^pr: \d+$/m.test(text);
}

export function appendExecLog(dir: string, entry: ExecEntry, maxBytes = EXEC_LOG_MAX_BYTES): void {
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, EXEC_LOG), line = `${JSON.stringify(entry)}\n`;
    if (existsSync(file) && statSync(file).size + Buffer.byteLength(line) > maxBytes) renameSync(file, `${file}.1`);
    appendFileSync(file, line, { mode: 0o600 });
  } catch { /* the log never breaks the work it records */ }
}

const resultText = (result: unknown): string => {
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
  return Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') : typeof result === 'string' ? result : '';
};
/** The raw value is what isNoMatch/isShipWait read: the logged target is clipped to 200 characters on one line, which hides a trailing grep and newlines. */
const targetOf = (args: unknown): { raw: string; target: string } | undefined => {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  const value = a.command ?? a.path ?? a.action ?? a.url ?? a.name;
  return typeof value === 'string' ? { raw: value, target: clip(value, 200) } : undefined;
};

/** One entry per tool call: everything the agent runs, its outcome class and, on failure, the reason. */
export function registerExecLog(pi: ExtensionAPI, dir: () => string | undefined) {
  const started = new Map<string, { raw: string; target: string } | undefined>();
  pi.on('tool_execution_start', event => { started.set(event.toolCallId, targetOf(event.args)); });
  pi.on('tool_execution_end', event => {
    const where = dir(); const call = started.get(event.toolCallId), target = call?.target, raw = call?.raw; started.delete(event.toolCallId);
    if (!where) return;
    const text = resultText(event.result);
    // Only bash's own trailer is this call's exit code; shell_status, zoom or a grep that quote someone else's exit are not failures.
    const exit = event.toolName === 'bash' ? /\n*Command exited with code (\d+)\s*$/.exec(text) : null;
    const answered = (exit?.[1] === '1' && isNoMatch(raw, text)) || (event.toolName === 'bash' && isShipWait(raw, text));
    const kind = classify(!answered && (event.isError === true || (exit !== null && exit[1] !== '0')), event.isError ? text : text.slice(-400), exit ? Number(exit[1]) : undefined);
    appendExecLog(where, { at: new Date().toISOString(), source: 'tool', name: event.toolName, ...(target ? { target } : {}), class: kind,
      ...(event.durationMs === undefined ? {} : { ms: Math.round(event.durationMs) }), ...(exit ? { code: Number(exit[1]) } : {}),
      ...(kind === 'ok' ? {} : { detail: clipTail(text, 300) }) });
  });
  pi.on('agent_settled', () => started.clear());
}

/** Background jobs (PR watch, summaries): logs the failure with the program's own reason, e.g. gh's stderr. */
export function logBackgroundFailure(dir: string | undefined, name: string, error: unknown): void {
  if (!dir) return;
  const e = error as { message?: string; code?: number | string; stderr?: string; killed?: boolean } | undefined;
  const text = [e?.stderr, e?.message ?? String(error)].filter(Boolean).join(' | ');
  appendExecLog(dir, { at: new Date().toISOString(), source: 'background', name, class: e?.killed ? 'timeout' : classify(true, text, e?.code),
    ...(typeof e?.code === 'number' ? { code: e.code } : {}), detail: clip(text, 400) });
}
