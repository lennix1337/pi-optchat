import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** What happened to one execution, in words the operator can read in the log. */
export type ExecClass = 'ok' | 'exit_nonzero' | 'timeout' | 'not_found' | 'refused' | 'aborted' | 'network' | 'rate_limited' | 'error';
export type ExecEntry = { at: string; source: 'tool' | 'background'; name: string; target?: string; class: ExecClass; ms?: number; code?: number; detail?: string; run?: string };

export const EXEC_LOG = 'exec-log.jsonl';
/** One live file plus one rotated `.1`: at most about 2 MB on disk. */
export const EXEC_LOG_MAX_BYTES = 1_000_000;

const clip = (text: string, max: number) => { const one = text.replace(/\s+/g, ' ').trim(); return one.length > max ? `${one.slice(0, max - 1)}…` : one; };

const clipTail = (text: string, max: number) => { const one = text.replace(/\s+/g, ' ').trim(); return one.length > max ? `…${one.slice(one.length - max + 1)}` : one; };

/** Classifies from the error text; order matters: a gate refusal or timeout also carries a non-zero exit. */
export function classify(failed: boolean, text: string, code?: number | string): ExecClass {

  if (!failed) return 'ok';

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


  const masked = (command ?? '').replace(/"(?:\\[^]|[^"\\])*"|'[^']*'/g, quoted => 'x'.repeat(quoted.length));
  const tokens = masked.split(/(&&|\|\||\||;|\n)/);
  while (tokens.length > 1 && tokens[tokens.length - 1].trim() === '') tokens.length -= 2;
  const last = (tokens.pop() ?? '').trim();
  if (!/^(?:grep|egrep|fgrep|rg)\s/.test(last)) return false;
  // external: Shell sequences and pipelines return the last command status; && and || may return an earlier status.

  const before = tokens.pop();
  if (before === ';' || before === '|' || before === '\n') return true;
  const trailer = /Command exited with code \d+\s*$/.exec(text);
  let end = trailer?.index ?? text.length;
  if (trailer) while (end > 0 && text[end - 1] === '\n') end--;
  return text.slice(0, end).replace(/^\(no output\)$/i, '').trim() === '';
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
  } catch {   }
}

/** Reads the rotated and live exec-log files in chronological order, skipping malformed lines. */
export function readExecLog(dir: string): ExecEntry[] {
  const rows: ExecEntry[] = [];
  for (const name of [`${EXEC_LOG}.1`, EXEC_LOG]) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as ExecEntry;
        if (parsed && typeof parsed.at === 'string' && typeof parsed.name === 'string') rows.push(parsed);
      } catch { }
    }
  }
  return rows;
}

const resultText = (result: unknown): string => {
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
  return Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') : typeof result === 'string' ? result : '';
};

const targetOf = (args: unknown): { raw: string; target: string } | undefined => {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  const value = a.command ?? a.path ?? a.action ?? a.url ?? a.name;
  return typeof value === 'string' ? { raw: value, target: clip(value, 200) } : undefined;
};

/** One entry per tool call: everything the agent runs, its outcome class and, on failure, the reason. */
export function registerExecLog(pi: ExtensionAPI, dir: () => string | undefined) {
  const started = new Map<string, { raw: string; target: string } | undefined>();
  let runSeq = 0;
  let currentRun: string | undefined;
  pi.on('agent_start', () => { currentRun = `${Date.now().toString(36)}-${++runSeq}`; });
  pi.on('tool_execution_start', event => { started.set(event.toolCallId, targetOf(event.args)); });
  pi.on('tool_execution_end', event => {
    const where = dir(); const call = started.get(event.toolCallId), target = call?.target, raw = call?.raw; started.delete(event.toolCallId);
    if (!where) return;
    const text = resultText(event.result);
    // external: Pi bash appends its own exit-code trailer.
    const exit = event.toolName === 'bash' ? /Command exited with code (\d+)\s*$/.exec(text) : null;
    const answered = (exit?.[1] === '1' && isNoMatch(raw, text)) || (event.toolName === 'bash' && isShipWait(raw, text));
    const kind = classify(!answered && (event.isError === true || (exit !== null && exit[1] !== '0')), event.isError ? text : text.slice(-400), exit ? Number(exit[1]) : undefined);
    appendExecLog(where, { at: new Date().toISOString(), source: 'tool', name: event.toolName, ...(target ? { target } : {}), class: kind,
      ...(event.durationMs === undefined ? {} : { ms: Math.round(event.durationMs) }), ...(exit ? { code: Number(exit[1]) } : {}),
      ...(kind === 'ok' ? {} : { detail: clipTail(text, 300) }), ...(currentRun ? { run: currentRun } : {}) });
  });
  pi.on('agent_settled', () => { started.clear(); currentRun = undefined; });
}

/** Background jobs (PR watch, summaries): logs the failure with the program's own reason, e.g. gh's stderr. */
export function logBackgroundFailure(dir: string | undefined, name: string, error: unknown): void {
  if (!dir) return;
  const e = error as { message?: string; code?: number | string; stderr?: string; killed?: boolean } | undefined;
  const text = [e?.stderr, e?.message ?? String(error)].filter(Boolean).join(' | ');
  appendExecLog(dir, { at: new Date().toISOString(), source: 'background', name, class: e?.killed ? 'timeout' : classify(true, text, e?.code),
    ...(typeof e?.code === 'number' ? { code: e.code } : {}), detail: clip(text, 400) });
}
