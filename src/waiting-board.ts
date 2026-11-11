import { shortModel, taskLine } from './agent-rows.ts';
import type { RunInfo } from './runs.ts';
import { isRunning } from './runs.ts';
import { plainText, type ShellJob } from './shells.ts';

/**
 * The waiting board: everything OptChat is waiting on and how far along each item is, as a few short lines. The TUI widget
 * (src/navigation.ts) and the status note the model reads each turn (src/transcript.ts `atWork`) both render `boardView`'s result,
 * so the operator and the model see the same state. Times are Brasília's, the zone the operator reads.
 */

/** Lines the widget shows at most, the overflow line included. */
export const BOARD_LINES = 6;
/** How long a finished item stays on the board. */
export const KEEP_MS = 10 * 60_000;
/** The model's note stays under this many characters; what does not fit becomes "+N mais". */
export const NOTE_CHARS = 600;
/** A gitwatch snapshot older than this is shown with its age: it may no longer be true. */
const STALE_MS = 5 * 60_000;

export type Tone = 'active' | 'wait' | 'ok' | 'bad' | 'info';
export interface BoardLine { text: string; tone: Tone; at: number; finished: boolean }
/** `more` counts the lines left out, `pending` all the lines still waiting, shown or not. */
export interface BoardView { lines: BoardLine[]; more: number; pending: number; now: number }

export interface BoardRun {
  id: string; task: string; model: string; state: RunInfo['state']; started: number; ended?: number;
  /** Last time the worker did anything. */
  updated?: number; tools?: number; last?: string;
  /** When a worker parked for its account's quota tries again. */
  until?: number;
}
export interface BoardShell { id: string; command: string; state: ShellJob['state']; started: number; ended?: number; exitCode?: number; last?: string }
/** What pi-gitwatch publishes on `gitwatch:state:v1`; every field is optional because its shape may still change. */
export interface GitwatchState { polledAt?: unknown; prs?: unknown; branches?: unknown }
/** What pi-gitwatch publishes on `gitwatch:notice:v1`. */
export interface GitwatchNotice { repo?: unknown; wake?: unknown; text?: unknown; at?: unknown; events?: unknown }
export interface BoardInput {
  now: number;
  runs: readonly BoardRun[]; shells: readonly BoardShell[];
  gitwatch?: GitwatchState; notices?: readonly GitwatchNotice[];
  /** Texts of the commitments waiting on the operator. */
  waiting?: readonly string[];
}

const obj = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
const str = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
/** A time as epoch milliseconds, whether given as a number or an ISO string. */
const time = (value: unknown) => num(value) ?? (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined);
/** One line of at most `n` characters, cut with an ellipsis. */
export function cut(text: string, n: number) {
  const flat = plainText(text).replace(/\s+/g, ' ').trim(), chars = [...flat];
  return chars.length <= n ? flat : `${chars.slice(0, n - 1).join('').trimEnd()}\u2026`;
}
/** `45s`, `4m`, `1h05`. */
export function span(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}
const clockFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** HH:MM in Brasília time. */
export const hhmm = (at: number) => clockFormat.format(at);

/** The tool's most telling argument: a shell's command, a file's name, else the first text argument. */
export function toolBrief(name: string, args: unknown) {
  const a = obj(args) ?? {};
  const file = str(a.path) ?? str(a.file_path) ?? str(a.file);
  const text = ['bash', 'powershell', 'shell_start'].includes(name) ? str(a.command) : file ? file.split(/[\\/]/).pop() : Object.values(a).find((v): v is string => typeof v === 'string');
  return cut(text ? (['bash', 'powershell', 'shell_start'].includes(name) ? text : `${name} ${text}`) : name, 24);
}
/** The last non-empty line of a shell's output. */
export const lastLine = (output: string) => plainText(output).split(/\r?\n|\r/).map(l => l.trim()).filter(Boolean).at(-1) ?? '';
/** `anthropic-account-2/claude-sonnet-5-5` → `sonnet`. */
const modelName = shortModel;
const repoName = (repo: string) => repo.split('/').pop() ?? repo;

const ENDED = new Set<string>(['completed', 'failed', 'stopped']);
function runLine(run: BoardRun, now: number): BoardLine | undefined {
  const head = `${run.id} "${cut(taskLine(run.task) || run.task, 40).replaceAll('"', "'")}"`;
  const at = run.ended ?? run.updated ?? run.started;
  if (ENDED.has(run.state)) {
    if (run.ended === undefined || now - run.ended > KEEP_MS) return undefined;
    const ok = run.state === 'completed';
    return { text: `${ok ? '\u2713' : '\u2717'} ${hhmm(run.ended)} ${head} ${ok ? 'concluído' : run.state === 'failed' ? 'falhou' : 'parado'}`, tone: ok ? 'ok' : 'bad', at, finished: true };
  }
  const age = span(now - run.started);
  if (run.state === 'interrupted') {
    if (run.until === undefined) return undefined;
    return { text: `${head} ⏸ cota esgotada, volta às ${hhmm(run.until)} · ${age} · ${modelName(run.model)}`, tone: 'wait', at, finished: false };
  }
  if (run.state === 'paused') return { text: `${head} pausado, aguarda você · ${age} · ${modelName(run.model)}`, tone: 'wait', at, finished: false };
  const work = [`${run.tools ?? 0} tools`, ...run.last ? [run.last] : []];
  const state = run.state === 'stopping' ? ['parando'] : run.state === 'waiting' ? ['espera sub-agentes'] : [];
  return { text: `${head} ${[age, ...state, ...work, modelName(run.model)].join(' · ')}`, tone: 'active', at, finished: false };
}
/** A leading `cd <dir> &&` (or `;`) says where the command ran, not what it is: the directory's name moves in front of the rest. */
function splitCd(command: string): { dir?: string; rest: string } {
  const flat = command.trim(), m = /^cd\s+(?:\/d\s+)?("[^"]*"|'[^']*'|[^\s&;]+)\s*(?:&&|;)\s*(.+)$/s.exec(flat);
  if (!m) return { rest: flat };
  const dir = m[1].replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return dir ? { dir, rest: m[2].trim() } : { rest: flat };
}
/**
 * One line: what kind of job it is, where it ran and what, how it ended or how long it has run, then its short id.
 * Expanded (the focused board) keeps the whole command and adds the last line of its output on a second line.
 */
function shellLine(shell: BoardShell, now: number, expand = false): BoardLine | undefined {
  const { dir, rest } = splitCd(shell.command), what = `shell ${dir ? `${dir}: ` : ''}${expand ? plainText(rest).replace(/\s+/g, ' ') : cut(rest, 40)}`;
  const id = shell.id.slice(0, 8), out = shell.last ? `\nsaída: ${expand ? shell.last : cut(shell.last, 50)}` : '';
  if (shell.ended !== undefined) {
    if (now - shell.ended > KEEP_MS || shell.state === 'stopped') return undefined;
    const ok = shell.state === 'completed' && (shell.exitCode ?? 0) === 0;
    const result = ok ? 'ok' : `falhou${shell.exitCode !== undefined ? ` rc ${shell.exitCode}` : ''}`;
    return { text: `${ok ? '\u2713' : '\u2717'} ${hhmm(shell.ended)} ${what} ${result} · ${id}${expand ? out : ''}`, tone: ok ? 'ok' : 'bad', at: shell.ended, finished: true };
  }
  return { text: expand ? `${what} · ${span(now - shell.started)} · ${id}${out}` : `${what} · ${span(now - shell.started)}${shell.last ? ` · ${cut(shell.last, 50)}` : ''} · ${id}`, tone: 'active', at: shell.started, finished: false };
}

const MERGE_STATE: Record<string, string> = { DIRTY: 'conflito', BEHIND: 'atrás da base', BLOCKED: 'bloqueado', UNSTABLE: 'CI instável', DRAFT: 'rascunho' };
/** `CI 2/5`, with failures marked; undefined when the checks are unknown. */
function ci(checks: unknown) {
  const c = obj(checks);
  if (!c) return undefined;
  const pass = num(c.pass) ?? 0, fail = num(c.fail) ?? 0, pending = num(c.pending) ?? 0, total = pass + fail + pending;
  return { text: total ? `CI ${pass}/${total}${fail ? ` ✗${fail}` : ''}` : 'sem CI', pending, fail };
}
function gitwatchLines(state: GitwatchState, now: number): BoardLine[] {
  const polled = time(state.polledAt), stale = polled !== undefined && now - polled > STALE_MS ? `dados de ${span(now - polled)} atrás` : undefined;
  const lines: BoardLine[] = [];
  for (const raw of Array.isArray(state.prs) ? state.prs : []) {
    const pr = obj(raw), repo = str(pr?.repo), number = num(pr?.number);
    if (!pr || !repo || number === undefined) continue;
    const checks = ci(pr.checks), since = time(pr.pendingSince), merge = MERGE_STATE[String(pr.mergeState).toUpperCase()], next = str(pr.next);
    lines.push({
      text: [`${repoName(repo)} #${number}`, ...checks ? [checks.text] : [], ...checks?.pending && since !== undefined ? [span(now - since)] : [],
        ...pr.autoMerge === true ? ['auto-merge'] : [], ...merge ? [merge] : [], ...next ? [`→ ${cut(next, 20)}`] : [], ...stale ? [stale] : []].join(' · '),
      tone: checks?.fail || merge === 'conflito' ? 'bad' : 'active', at: since ?? polled ?? now, finished: false });
  }
  for (const raw of Array.isArray(state.branches) ? state.branches : []) {
    const b = obj(raw), repo = str(b?.repo), branch = str(b?.branch), checks = ci(b?.checks);
    if (!b || !repo || !branch || !checks || !checks.pending && !checks.fail) continue;
    const since = time(b.pendingSince);
    lines.push({ text: [`${repoName(repo)} ${cut(branch, 24)}`, checks.text, ...checks.pending && since !== undefined ? [span(now - since)] : [], ...stale ? [stale] : []].join(' · '),
      tone: checks.fail ? 'bad' : 'active', at: since ?? polled ?? now, finished: false });
  }
  return lines;
}

/** What a gitwatch event means to the operator, strongest first. */
const EVENT_RANK = ['merged', 'closed', 'stall', 'checks', 'mergeState', 'review'];
function noticeLine(notice: GitwatchNotice, now: number): BoardLine | undefined {
  const at = time(notice.at), repo = str(notice.repo);
  if (at === undefined || now - at > KEEP_MS || now < at - 60_000) return undefined;
  const events = (Array.isArray(notice.events) ? notice.events : []).flatMap(e => { const o = obj(e); return o && str(o.text) ? [o] : []; });
  const event = [...events].sort((a, b) => (EVENT_RANK.indexOf(String(a.kind)) + 1 || 99) - (EVENT_RANK.indexOf(String(b.kind)) + 1 || 99))[0];
  const what = event ? str(event.text)! : str(notice.text)?.split('\n')[0];
  if (!what) return undefined;
  const pr = num(event?.pr), ref = pr ? `#${pr}` : str(event?.branch) ?? '', kind = String(event?.kind);
  const text = /^merged/.test(what) ? 'mergeado' : /^closed/.test(what) ? 'fechado sem merge' : /^checks failed/.test(what) ? what.replace(/^checks failed/, 'CI falhou')
    : kind === 'checks' && /pass|green|ok/i.test(what) ? 'CI ok' : what;
  const bad = /falhou|fechado|stall|auto-merge has not merged/.test(text), good = text === 'mergeado' || text === 'CI ok';
  return { text: `${bad ? '\u2717' : good ? '\u2713' : '\u2022'} ${hhmm(at)} ${[repo ? repoName(repo) : '', ref].filter(Boolean).join(' ')} ${cut(text, 50)}`.replace(/ {2,}/g, ' '), tone: bad ? 'bad' : good ? 'ok' : 'info', at, finished: true };
}

/**
 * The board, newest activity first: what waits on the operator, then what is running or in CI, then what finished in the last
 * ten minutes. Nothing pending means no lines. At most `max` lines, the overflow counted in `more`.
 */
export function boardView(input: BoardInput, max = BOARD_LINES): BoardView { return build(input, max, false); }

/** Every line the board has, nothing cut for room: each item the operator is waiting on has its own line with its full text. What the focused board shows. */
export function expandedView(input: BoardInput): BoardView { return build(input, Infinity, true); }

function build(input: BoardInput, max: number, expand: boolean): BoardView {
  const { now } = input;
  const waiting = input.waiting?.filter(Boolean) ?? [];
  const wait = (text: string): BoardLine => ({ text, tone: 'wait', at: now, finished: false });
  const operator: BoardLine[] = !waiting.length ? []
    : expand ? waiting.map(text => wait(`aguarda você: ${plainText(text).replace(/\s+/g, ' ').trim()}`))
    : [wait(`aguarda você${waiting.length > 1 ? ` (${waiting.length})` : ''}: ${cut(waiting[0], 50)}`)];
  const rest = [
    ...input.runs.flatMap(r => runLine(r, now) ?? []), ...input.shells.flatMap(s => shellLine(s, now, expand) ?? []),
    ...input.gitwatch ? gitwatchLines(input.gitwatch, now) : [], ...(input.notices ?? []).flatMap(n => noticeLine(n, now) ?? []),
  ].sort((a, b) => Number(a.finished) - Number(b.finished) || b.at - a.at);
  const all = [...operator, ...rest], pending = all.filter(l => !l.finished).length;
  if (all.length <= max) return { lines: all, more: 0, pending, now };
  return { lines: all.slice(0, max - 1), more: all.length - (max - 1), pending, now };
}

export const overflowText = (more: number, hint = '') => `+${more} mais${hint ? ` · ${hint}` : ''}`;

/**
 * The board as the model reads it: the same lines, minus the finished ones (their reports and notices already reach the model
 * as messages), within `NOTE_CHARS`. Undefined when nothing is pending.
 */
export function boardNote(view: BoardView, chars = NOTE_CHARS): string | undefined {
  const pending = view.lines.filter(l => !l.finished);
  if (!pending.length) return undefined;
  const head = `${hhmm(view.now)} pendente:`;
  const out: string[] = [];
  let used = head.length;
  for (const line of pending) {
    if (used + line.text.length + 3 > chars - 12 && out.length) break; // room for the "+N mais" line
    out.push(line.text); used += line.text.length + 3;
  }
  const more = view.pending - out.length;
  return `${head}\n${out.map(l => `- ${l}`).join('\n')}${more ? `\n${overflowText(more)}` : ''}`;
}

// ---- Gathering the board's input from the live session ----

interface Sources {
  runs: () => readonly RunInfo[];
  live: (id: string) => { updated: number; toolCalls?: number; lastTool?: { name: string; args: unknown } } | undefined;
  shells: () => readonly ShellJob[];
  waiting: () => readonly string[];
  now?: () => number;
}
interface Events { on(channel: string, handler: (data: unknown) => void): () => void; emit(channel: string, data: unknown): void }
const NOTICES_KEPT = 20;
const WAITING_TTL_MS = 5_000;

/** Holds what pi-gitwatch published and builds the board input; the widget and the model's note both ask it for the view. */
export class WaitingBoard {
  private state: GitwatchState | undefined;
  private notices: GitwatchNotice[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly stops: (() => void)[] = [];
  private waitingAt = 0;
  private waitingTexts: readonly string[] = [];
  constructor(private readonly sources: Sources, private readonly events?: Events) {
    this.stops.push(
      events?.on('gitwatch:state:v1', data => { const state = obj(data); if (state) { this.state = state; this.changed(); } }) ?? (() => {}),
      events?.on('gitwatch:notice:v1', data => { const notice = obj(data); if (notice) { this.notices = [...this.notices, notice].slice(-NOTICES_KEPT); this.changed(); } }) ?? (() => {}),
    );
  }
  /** Asks pi-gitwatch for its current state; it answers on `gitwatch:state:v1`. Nothing happens without pi-gitwatch. */
  requestState() { try { this.events?.emit('gitwatch:state:request:v1', {}); } catch { /* a listener's failure must not break opening */ } }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close() { for (const stop of this.stops.splice(0)) stop(); this.listeners.clear(); }
  private changed() { for (const listener of this.listeners) listener(); }
  input(): BoardInput {
    const now = this.sources.now?.() ?? Date.now();
    if (now - this.waitingAt > WAITING_TTL_MS || now < this.waitingAt) { this.waitingAt = now; try { this.waitingTexts = this.sources.waiting(); } catch { this.waitingTexts = []; } }
    const runs = this.sources.runs().filter(r => !r.source).map((r): BoardRun => {
      const live = isRunning(r) ? this.sources.live(r.id) : undefined;
      return { id: r.id, task: r.task, model: r.model, state: r.state, started: r.started, ended: r.ended, updated: live?.updated, tools: live?.toolCalls,
        last: live?.lastTool ? toolBrief(live.lastTool.name, live.lastTool.args) : undefined, until: r.parked?.until };
    });
    const shells = this.sources.shells().filter(j => j.mode === 'background').map((j): BoardShell => ({ id: j.id, command: j.command, state: j.state, started: j.started, ended: j.ended, exitCode: j.exitCode,
      last: lastLine(j.output) || undefined }));
    return { now, runs, shells, gitwatch: this.state, notices: this.notices, waiting: this.waitingTexts };
  }
  view(max = BOARD_LINES) { return boardView(this.input(), max); }
  /** Every item in full, for the focused board. */
  expanded() { return expandedView(this.input()); }
}
