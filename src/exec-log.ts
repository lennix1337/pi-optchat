import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { classifyEffects, runsDeploy, type Action } from './effect-classifier.ts';
import { scrubSecrets } from './secret-scrub.ts';

/** What happened to one execution, in words the operator can read in the log. */
export type ExecClass = 'ok' | 'exit_nonzero' | 'timeout' | 'not_found' | 'refused' | 'aborted' | 'network' | 'rate_limited' | 'error';
export type ExecutedEffect = { label: string; revert: string };
export type ExecEntry = { at: string; source: 'tool' | 'background'; name: string; target?: string; class: ExecClass; ms?: number; code?: number; detail?: string; run?: string; call?: string; effects?: ExecutedEffect[] };

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

const undoAdvice: Partial<Record<Action, [label: string, revert: string]>> = {
  push: ['Push Git', 'Confira o remoto e publique um commit de reversão, se necessário.'],
  'push-main': ['Push Git na branch principal', 'Confira o remoto e publique um commit de reversão, se necessário.'],
  'force-push': ['Push forçado', 'Identifique o commit anterior no remoto e combine a recuperação com quem usa a branch.'],
  merge: ['Merge', 'Abra uma PR de reversão do merge.'],
  'merge-bypass': ['Merge com bypass', 'Abra uma PR de reversão do merge.'],
  deploy: ['Deploy', 'Use o procedimento de rollback para a última versão estável.'],
  message: ['Mensagem enviada', 'Use a exclusão ou retratação no canal, se disponível.'],
  'production-write': ['Escrita em produção', 'Confira a alteração e use o procedimento de recuperação autorizado.'],
  'database-destructive': ['Alteração destrutiva no banco', 'Confira o backup e siga o procedimento de restauração.'],
  publish: ['Publicação', 'Verifique se o registro permite despublicar ou depreciar a versão.'],
};

export function executedEffects(tool: string, input: unknown, cwd: string, result: string): ExecutedEffect[] {
  const target = targetOf(input)?.raw ?? '';
  const effects: ExecutedEffect[] = [];
  const command = tool === 'bash' ? target : '';
  const pr = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)\b/.exec(result);
  const opened = /\bgh\s+pr\s+create\b|\bship\.mjs\b/.test(command) && pr;
  if (opened) effects.push({ label: `PR #${opened[1]} aberta`, revert: 'Feche a PR no GitHub se ela ainda estiver aberta.' });
  const merged = /\bgh\s+pr\s+merge\s+(?:https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/)?(\d+)\b/.exec(command);
  const safe = (value: string) => clip(scrubSecrets(value), 150);
  const repo = { slug: () => undefined, branch: () => undefined };
  for (const { action, targets } of tool === 'shell_start' ? [] : classifyEffects({ tool, input, cwd }, repo)) {
    const advice = undoAdvice[action];
    if (!advice) continue;
    const refs = ['push', 'push-main', 'force-push'].includes(action) ? /\bgit(?:\s+-C\s+\S+)?\s+push\s+([\w.-]+\s+[\w./:-]+)/.exec(command)?.[1] : undefined;
    effects.push({ label: merged && (action === 'merge' || action === 'merge-bypass') ? `PR #${merged[1]} mesclada` : `${advice[0]}: ${safe(refs ?? targets.join(', '))}`, revert: advice[1] });
  }
  if (/^(?:slack|whatsapp)_send$/.test(tool) && !effects.length) effects.push({ label: tool === 'slack_send' ? 'Mensagem enviada no Slack' : 'Mensagem enviada no WhatsApp', revert: undoAdvice.message![1] });
  if (['edit', 'write'].includes(tool) && target) effects.push({ label: `Arquivo alterado: ${safe(target)}`, revert: 'Revise o diff e reverta só a alteração correspondente.' });
  if (command && !effects.some(e => e.label.startsWith('Deploy')) && runsDeploy(command)) effects.push({ label: 'Deploy', revert: undoAdvice.deploy![1] });
  return effects;
}

/** One entry per tool call: everything the agent runs, its outcome class and, on failure, the reason. */
export function registerExecLog(pi: ExtensionAPI, dir: () => string | undefined) {
  const started = new Map<string, unknown>();
  let runSeq = 0;
  let currentRun: string | undefined;
  pi.on('agent_start', () => { currentRun = `${Date.now().toString(36)}-${++runSeq}`; });
  pi.on('tool_execution_start', event => { started.set(event.toolCallId, event.args); });
  pi.on('tool_execution_end', (event, ctx) => {
    const where = dir(), input = started.get(event.toolCallId), call = targetOf(input), target = call?.target, raw = call?.raw;
    started.delete(event.toolCallId);
    if (!where) return;
    const text = resultText(event.result);
    // external: Pi bash appends its own exit-code trailer.
    const exit = event.toolName === 'bash' ? /Command exited with code (\d+)\s*$/.exec(text) : null;
    const answered = (exit?.[1] === '1' && isNoMatch(raw, text)) || (event.toolName === 'bash' && isShipWait(raw, text));
    const kind = classify(!answered && (event.isError === true || (exit !== null && exit[1] !== '0')), event.isError ? text : text.slice(-400), exit ? Number(exit[1]) : undefined);
    let effects: ExecutedEffect[] = [];
    if (kind === 'ok') try { effects = executedEffects(event.toolName, input, ctx?.cwd ?? '', text); } catch { }
    appendExecLog(where, { at: new Date().toISOString(), source: 'tool', name: event.toolName, ...(target ? { target } : {}), class: kind,
      ...(effects.length ? { call: event.toolCallId, effects } : {}),
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
