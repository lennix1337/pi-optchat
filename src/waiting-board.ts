import { projectOf, shortModel, taskLine } from './agent-rows.ts';
import type { RunInfo } from './runs.ts';
import { isRunning } from './runs.ts';
import { plainText, type ShellJob } from './shells.ts';

/**
 * The waiting board: everything OptChat is waiting on and how far along each item is, in three sections: what waits on the operator,
 * what is being worked on, and what finished in the last minutes. The TUI widget (src/navigation.ts) and the status note the model
 * reads each turn (src/transcript.ts `atWork`) both render `boardView`'s result: the operator sees the line, the model the same
 * line plus the ids it can act on. Times are Brasília's, the zone the operator reads.
 */

/** How long a finished item stays on the board. */
export const KEEP_MS = 10 * 60_000;
/** A running worker that has done nothing for this long is shown as stalled. */
export const STALL_MS = 10 * 60_000;
/** Lines the compact widget shows at most, the overflow line included; the waiting section adds its one question to them. */
export const BOARD_LINES = 8;
/** The model's note stays under this many characters; what does not fit becomes "+N mais". */
export const NOTE_CHARS = 600;
/** A gitwatch snapshot older than this is shown with its age: it may no longer be true. */
const STALE_MS = 5 * 60_000;
/** Longest goal and question a compact row keeps; the focused board shows them whole. */
const GOAL_CHARS = 44, QUESTION_CHARS = 60;

export type Tone = 'active' | 'wait' | 'ok' | 'bad' | 'info';
export type Section = 'waiting' | 'working' | 'done';
/** `note` is what the model reads when it differs from the line: the same words plus the ids. */
export interface BoardLine { text: string; tone: Tone; at: number; finished: boolean; section: Section; note?: string;
  /** A worker's line as its goal and what surrounds it (`head + goal + tail` is `text`): a narrow terminal shortens the goal and keeps the phase, time and model. */
  parts?: { head: string; goal: string; tail: string } }
/** `more` counts the lines left out, `pending` all the lines still waiting or running, `waiting` every question for the operator, shown or not. */
export interface BoardView { lines: BoardLine[]; more: number; pending: number; waiting: number; now: number }

/** What waits on the operator: a question with the answers he can tap and since when it has waited. */
export interface WaitItem { text: string; id?: string; ask?: string; choices?: readonly string[]; since?: number }
export interface BoardRun {
  id: string; task: string; model: string; state: RunInfo['state']; started: number; ended?: number; cwd?: string;
  /** The crew project that owns the run, when it has one; else its directory names the project. */
  project?: string;
  /** Last time the worker did anything. */
  updated?: number;
  /** When its last tool started or ended, and whether one is running now: a worker silent for `STALL_MS` with no tool running is stalled. */
  toolAt?: number; inTool?: boolean;
  /** What the last tool says it is doing, in words (`phaseOf`). */
  phase?: string;
  /** When a worker parked for its account's quota tries again. */
  until?: number;
  explicitRecovery?: boolean;
  parkOpening?: boolean;
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
  /** What waits on the operator, most urgent first. */
  waiting?: readonly WaitItem[];
}

const obj = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
const str = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
const num = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
/** A time as epoch milliseconds, whether given as a number or an ISO string. */
const time = (value: unknown) => num(value) ?? (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined);
/** One line of at most `n` characters, cut with an ellipsis. */
export function cut(text: string, n: number) {
  const flat = plainText(text).replace(/\s+/g, ' ').trim(), chars = [...flat];
  return chars.length <= n ? flat : `${chars.slice(0, n - 1).join('').trimEnd()}…`;
}
/** `45s`, `4m`, `1h05`. */
export function span(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}
/** How long something has waited on the operator: `5m`, `44h`, `3d`. */
export function waitAge(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000)), h = Math.floor(m / 60);
  return m < 60 ? `${m}m` : h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
const clockFormat = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** HH:MM in Brasília time. */
export const hhmm = (at: number) => clockFormat.format(at);

const SHELL_TOOLS = ['bash', 'powershell', 'shell_start'];
const READING = new Set(['read', 'read_many', 'grep', 'find', 'ls', 'ripwire', 'search', 'zoom', 'output_read', 'specialist_memory', 'project_evidence']);
const TESTING = /\b(?:npm\s+(?:run\s+)?(?:-s\s+)?(?:test|verify)|test:one|node\s+--test|vitest|jest|pytest|tsc|cargo\s+test|go\s+test|dotnet\s+test)\b/;
/** What a worker's last tool says it is doing, in words: reading code, testing, editing, git; any other tool keeps its own name. */
export function phaseOf(name: string, args: unknown): string {
  if (READING.has(name)) return 'lendo código';
  if (name === 'edit' || name === 'write') return 'editando';
  if (name === 'project_checks') return 'testes';
  if (SHELL_TOOLS.includes(name)) {
    const command = str(obj(args)?.command) ?? '';
    if (TESTING.test(command)) return 'testes';
    if (/^\s*(?:cd\s+[^&;]+(?:&&|;)\s*)?(?:git|gh)\b/.test(command)) return 'git';
  }
  return name;
}
/** The last non-empty line of a shell's output. */
export const lastLine = (output: string) => plainText(output).split(/\r?\n|\r/).map(l => l.trim()).filter(Boolean).at(-1) ?? '';
/** `anthropic-account-2/claude-sonnet-5-5` → `sonnet`. */
const modelName = shortModel;
const repoName = (repo: string) => repo.split('/').pop() ?? repo;

/** A finished item: its mark, what it was, how it ended and when. */
const finished = (ok: boolean, what: string, result: string, at: number, tone: Tone = ok ? 'ok' : 'bad'): BoardLine =>
  ({ text: `${ok ? '✓' : '✗'} ${what} ${result} · ${hhmm(at)}`, tone, at, finished: true, section: 'done' });
/** An item in progress; `ids` are what the model's note adds to the line. */
const working = (text: string, tone: Tone, at: number, ids?: string, parts?: BoardLine['parts']): BoardLine => ({ text, tone, at, finished: false, section: 'working', ...ids ? { note: `${text} [${ids}]` } : {}, ...parts ? { parts } : {} });

/** The question as the operator reads it: what is asked, the answers he can tap and how long it has waited. */
function waitLine(item: WaitItem, now: number, expand: boolean): BoardLine {
  let question = plainText(item.ask ? `${item.text}: ${item.ask}` : item.text).replace(/\s+/g, ' ').trim();
  if (item.choices?.length && !question.endsWith('?')) question += '?';
  const tail = `${item.choices?.length ? ` [${item.choices.join('/')}]` : ''}${item.since !== undefined ? ` · ${waitAge(now - item.since)}` : ''}`;
  return { text: `${expand ? question : cut(question, QUESTION_CHARS)}${tail}`, tone: 'wait', at: now, finished: false, section: 'waiting', note: `${question}${tail}${item.id ? ` [${item.id}]` : ''}` };
}

const projectName = (run: BoardRun) => run.project ?? projectOf(run.cwd ?? '');
const ENDED = new Set<string>(['completed', 'failed', 'stopped']);
/** Project · goal · phase in words · elapsed · short model; a finished worker says how it ended instead. `pad` aligns the project column. */
function runLine(run: BoardRun, now: number, pad: number): BoardLine | undefined {
  const project = projectName(run), goal = cut(taskLine(run.task) || run.task, GOAL_CHARS);
  const lead = project ? `${project.padEnd(pad)} · ` : '', head = lead + goal;
  const at = run.ended ?? run.updated ?? run.started;
  if (ENDED.has(run.state)) {
    if (run.ended === undefined || now - run.ended > KEEP_MS) return undefined;
    const ok = run.state === 'completed';
    return finished(ok, head, ok ? 'concluído' : run.state === 'failed' ? 'falhou' : 'parado', run.ended);
  }
  const age = span(now - run.started), model = modelName(run.model);
  if (run.state === 'interrupted') {
    if (run.parkOpening) return working(`${head} · retomando após cota · ${age} · ${model}`, 'active', at, run.id);
    if (run.explicitRecovery) return working(`${head} · ⏸ aguarda retomada explícita · ${age} · ${model}`, 'wait', at, run.id);
    if (run.until === undefined) return undefined;
    return working(`${head} · ⏸ cota esgotada, volta às ${hhmm(run.until)} · ${age} · ${model}`, 'wait', at, run.id);
  }
  if (run.state === 'paused') return working(`${head} · pausado, aguarda você · ${age} · ${model}`, 'wait', at, run.id);
  const quiet = now - (run.toolAt ?? run.started), stalled = run.state === 'running' && !run.inTool && quiet > STALL_MS;
  const doing = run.state === 'stopping' ? 'parando' : run.state === 'waiting' ? 'espera sub-agentes' : stalled ? `parado há ${span(quiet)}` : run.phase;
  const tail = [...doing ? [doing] : [], age, model].join(' · ');
  return working(`${head} · ${tail}`, stalled ? 'wait' : 'active', at, run.id, { head: lead, goal, tail: ` · ${tail}` });
}
/** A leading `cd <dir> &&` (or `;`) says where the command ran, not what it is: the directory's name moves in front of the rest. */
function splitCd(command: string): { dir?: string; rest: string } {
  const flat = command.trim(), m = /^cd\s+(?:\/d\s+)?("[^"]*"|'[^']*'|[^\s&;]+)\s*(?:&&|;)\s*(.+)$/s.exec(flat);
  if (!m) return { rest: flat };
  const dir = m[1].replace(/^["']|["']$/g, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return dir ? { dir, rest: m[2].trim() } : { rest: flat };
}
/**
 * One line: what kind of job it is, where it ran and what, then how it ended and when, or how long it has run and its last output.
 * Expanded (the focused board) keeps the whole command and adds the last line of its output on a second line.
 */
function shellLine(shell: BoardShell, now: number, expand = false): BoardLine | undefined {
  const { dir, rest } = splitCd(shell.command), what = `shell ${dir ? `${dir}: ` : ''}${expand ? plainText(rest).replace(/\s+/g, ' ') : cut(rest, 40)}`;
  const out = shell.last ? `\nsaída: ${expand ? shell.last : cut(shell.last, 50)}` : '';
  if (shell.ended !== undefined) {
    if (now - shell.ended > KEEP_MS || shell.state === 'stopped') return undefined;
    const ok = shell.state === 'completed' && (shell.exitCode ?? 0) === 0;
    const line = finished(ok, what, ok ? 'ok' : `falhou${shell.exitCode !== undefined ? ` rc ${shell.exitCode}` : ''}`, shell.ended);
    return expand ? { ...line, text: `${line.text}${out}` } : line;
  }
  return working(expand ? `${what} · ${span(now - shell.started)}${out}` : `${what} · ${span(now - shell.started)}${shell.last ? ` · ${cut(shell.last, 50)}` : ''}`, 'active', shell.started, shell.id.slice(0, 8));
}

const MERGE_STATE: Record<string, string> = { DIRTY: 'conflito', BEHIND: 'atrás da base', BLOCKED: 'bloqueado', UNSTABLE: 'CI instável', DRAFT: 'rascunho' };
/** `CI 2/5`, with failures marked; undefined when the checks are unknown. */
function ci(checks: unknown) {
  const c = obj(checks);
  if (!c) return undefined;
  const pass = num(c.pass) ?? 0, fail = num(c.fail) ?? 0, pending = num(c.pending) ?? 0, total = pass + fail + pending;
  return { text: total ? `CI ${pass}/${total}${fail ? ` ✗${fail}` : ''}` : 'sem CI', pending, fail };
}
/** The PR lines and the branches whose CI is not green; the model's note names each PR as `owner/repo#N` with its CI state. */
function gitwatchLines(state: GitwatchState, now: number): BoardLine[] {
  const polled = time(state.polledAt), stale = polled !== undefined && now - polled > STALE_MS ? `dados de ${span(now - polled)} atrás` : undefined;
  const lines: BoardLine[] = [];
  const add = (label: string, full: string, tail: string[], tone: Tone, at: number) => lines.push({
    text: [label, ...tail].join(' · '), note: [full, ...tail].join(' · '), tone, at, finished: false, section: 'working' });
  for (const raw of Array.isArray(state.prs) ? state.prs : []) {
    const pr = obj(raw), repo = str(pr?.repo), number = num(pr?.number);
    if (!pr || !repo || number === undefined) continue;
    const checks = ci(pr.checks), since = time(pr.pendingSince), merge = MERGE_STATE[String(pr.mergeState).toUpperCase()], next = str(pr.next);
    add(`${repoName(repo)} #${number}`, `${repo}#${number}`, [...checks ? [checks.text] : [], ...checks?.pending && since !== undefined ? [span(now - since)] : [],
      ...pr.autoMerge === true ? ['auto-merge'] : [], ...merge ? [merge] : [], ...next ? [`→ ${cut(next, 20)}`] : [], ...stale ? [stale] : []],
    checks?.fail || merge === 'conflito' ? 'bad' : 'active', since ?? polled ?? now);
  }
  for (const raw of Array.isArray(state.branches) ? state.branches : []) {
    const b = obj(raw), repo = str(b?.repo), branch = str(b?.branch), checks = ci(b?.checks);
    if (!b || !repo || !branch || !checks || !checks.pending && !checks.fail) continue;
    const since = time(b.pendingSince);
    add(`${repoName(repo)} ${cut(branch, 24)}`, `${repo} ${cut(branch, 24)}`, [checks.text, ...checks.pending && since !== undefined ? [span(now - since)] : [], ...stale ? [stale] : []], checks.fail ? 'bad' : 'active', since ?? polled ?? now);
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
  const line = finished(!bad, [repo ? repoName(repo) : '', ref].filter(Boolean).join(' '), cut(text, 50), at, bad ? 'bad' : good ? 'ok' : 'info');
  return { ...line, text: line.text.replace(/^[✓✗]/, bad ? '✗' : good ? '✓' : '•').replace(/ {2,}/g, ' ') };
}

/**
 * The board in its three sections: what waits on the operator (in the order given), what is running or in CI, then what finished
 * in the last ten minutes, newest first. Nothing waiting, running or recent means no lines.
 */
export function boardView(input: BoardInput, max = BOARD_LINES, everyQuestion = false): BoardView { return build(input, max, false, everyQuestion); }

/** The same lines for the focused board: every question and each question and command whole, plus a shell's last output line. `everyQuestion` of `boardView` keeps the compact text but lists all questions (the model's note). */
export function expandedView(input: BoardInput): BoardView { return build(input, Infinity, true); }

function build(input: BoardInput, max: number, expand: boolean, everyQuestion = expand): BoardView {
  const { now } = input;
  const waiting = (input.waiting ?? []).filter(item => item.text.trim()).map(item => waitLine(item, now, expand));
  const live = input.runs.filter(r => !ENDED.has(r.state)), pad = Math.max(0, ...live.map(r => projectName(r).length));
  const rest = [
    ...input.runs.flatMap(r => runLine(r, now, pad) ?? []), ...input.shells.flatMap(s => shellLine(s, now, expand) ?? []),
    ...input.gitwatch ? gitwatchLines(input.gitwatch, now) : [], ...(input.notices ?? []).flatMap(n => noticeLine(n, now) ?? []),
  ].sort((a, b) => Number(a.finished) - Number(b.finished) || b.at - a.at);
  const all = [...everyQuestion ? waiting : waiting.slice(0, 1), ...rest], pending = waiting.length + rest.filter(l => !l.finished).length;
  if (all.length <= max) return { lines: all, more: 0, pending, waiting: waiting.length, now };
  return { lines: all.slice(0, max - 1), more: all.length - (max - 1), pending, waiting: waiting.length, now };
}

export const overflowText = (more: number, hint = '') => `+${more} mais${hint ? ` · ${hint}` : ''}`;

/**
 * The board as the model reads it: the same lines plus their ids (run, commitment, shell, `owner/repo#N`), minus the finished
 * ones (their reports and notices already reach the model as messages), within `NOTE_CHARS`. Undefined when nothing is pending.
 */
export function boardNote(view: BoardView, chars = NOTE_CHARS): string | undefined {
  const pending = view.lines.filter(l => !l.finished);
  if (!pending.length) return undefined;
  const head = `${hhmm(view.now)} pendente:`;
  const out: string[] = [];
  let used = head.length;
  for (const line of pending) {
    const text = line.note ?? line.text;
    if (used + text.length + 3 > chars - 12 && out.length) break; // room for the "+N mais" line
    out.push(text); used += text.length + 3;
  }
  const more = view.pending - out.length;
  return `${head}\n${out.map(l => `- ${l}`).join('\n')}${more ? `\n${overflowText(more)}` : ''}`;
}

// ---- Gathering the board's input from the live session ----

interface Sources {
  runs: () => readonly RunInfo[];
  live: (id: string) => { updated: number; toolAt?: number; busy?: boolean; lastTool?: { name: string; args: unknown } } | undefined;
  shells: () => readonly ShellJob[];
  waiting: () => readonly WaitItem[];
  requiresExplicitRecovery?: (id: string) => boolean;
  parkOpening?: (id: string) => boolean;
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
  private waitingItems: readonly WaitItem[] = [];
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
    if (now - this.waitingAt > WAITING_TTL_MS || now < this.waitingAt) { this.waitingAt = now; try { this.waitingItems = this.sources.waiting(); } catch { this.waitingItems = []; } }
    const runs = this.sources.runs().filter(r => !r.source).map((r): BoardRun => {
      const live = isRunning(r) ? this.sources.live(r.id) : undefined;
      return { id: r.id, task: r.task, cwd: r.cwd, project: r.project, model: r.model, state: r.state, started: r.started, ended: r.ended, updated: live?.updated, toolAt: live?.toolAt, inTool: live?.busy,
        phase: live?.lastTool ? phaseOf(live.lastTool.name, live.lastTool.args) : undefined, until: r.parked?.until, explicitRecovery: this.sources.requiresExplicitRecovery?.(r.id), parkOpening: this.sources.parkOpening?.(r.id) };
    });
    const shells = this.sources.shells().filter(j => j.mode === 'background').map((j): BoardShell => ({ id: j.id, command: j.command, state: j.state, started: j.started, ended: j.ended, exitCode: j.exitCode,
      last: lastLine(j.output) || undefined }));
    return { now, runs, shells, gitwatch: this.state, notices: this.notices, waiting: this.waitingItems };
  }
  view(max = BOARD_LINES, everyQuestion = false) { return boardView(this.input(), max, everyQuestion); }
  /** Every item in full, for the focused board. */
  expanded() { return expandedView(this.input()); }
}
