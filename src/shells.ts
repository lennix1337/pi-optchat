import { randomUUID } from 'node:crypto';
import { createBashTool, createLocalBashOperations, type BashOperations, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { ShellNotify } from './settings.ts';
import { OutputAlerts, type ShellAlert } from './shell-alerts.ts';
import { textContent } from './transcript.ts';

export interface ShellJob {
  id: string; command: string; cwd: string; mode: 'foreground' | 'background';
  state: 'running' | 'stopping' | 'completed' | 'failed' | 'stopped';
  started: number; ended?: number; output: string; owner?: string;
  /** The command's exit code, when it exited on its own. */
  exitCode?: number;
  /** The bash tool's full-output file, when its output was truncated. */
  log?: string;
  /** Which ends the main agent hears about: every end, failures only, or none. */
  notify: ShellNotify;
  /** The regular expression whose matching output lines alert the main agent. */
  alert?: string;
  /** Matching lines counted so far, for a shell with an alert. */
  matches?: number;
}
/** Where a shell's messages go: its end (when its notify setting wants it) and each alert. It must not throw. */
export interface ShellReporter {
  finished(job: ShellJob): void;
  alerted(job: ShellJob, text: string, alert: ShellAlert): void;
}
export interface ShellOptions { notify?: ShellNotify; alert?: string }
const outputLimit = 32_000;
const field = (value: unknown, key: string): unknown => typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
/** Session-local execution inventory. Only explicitly managed jobs can be stopped individually. */
export class ShellJobs {
  private readonly jobs = new Map<string, ShellJob>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private reporter?: ShellReporter;
  list() { return [...this.jobs.values()].reverse().sort((a, b) => Number(b.state === 'running' || b.state === 'stopping') - Number(a.state === 'running' || a.state === 'stopping') || b.started - a.started); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  /** The open profile's reporter for managed background shells: each one's end (when its notify mode wants it) and its alerts. Foreground bash
   * calls are not reported: Pi shows their results. It must not throw: it runs inside the job's own completion, as `subscribe` listeners do. */
  setReporter(reporter: ShellReporter | undefined) { this.reporter = reporter; }
  private changed() { for (const listener of this.listeners) listener(); }
  begin(id: string, command: string, cwd: string, mode: ShellJob['mode'], owner = 'main', options: ShellOptions = {}) {
    this.jobs.set(id, { id, command, cwd, mode, owner, state: 'running', started: Date.now(), output: '', notify: options.notify ?? 'end', alert: options.alert });
    this.changed();
  }
  update(id: string, output: string, log?: string) {
    const job = this.jobs.get(id); if (!job) return;
    job.output = output.length > outputLimit ? `[Earlier output omitted]\n${output.slice(-outputLimit)}` : output;
    if (log) job.log = log;
    this.changed();
  }
  end(id: string, output: string, failed: boolean, outcome: { exitCode?: number; log?: string } = {}) {
    const job = this.jobs.get(id); if (!job || job.ended !== undefined) return;
    this.update(id, output, outcome.log);
    job.state = job.state === 'stopping' ? 'stopped' : failed ? 'failed' : 'completed';
    job.ended = Date.now();
    if (outcome.exitCode !== undefined) job.exitCode = outcome.exitCode;
    // Never evict an active execution, even when many jobs finish together.
    for (const finished of this.list().filter(j => j.ended !== undefined).slice(50)) this.jobs.delete(finished.id);
    this.changed();
    if (job.mode === 'background' && endNoticeWanted(job.notify, job.state)) this.reporter?.finished(job);
  }
  stop(id: string) {
    const job = this.jobs.get(id), controller = this.controllers.get(id);
    if (!job || !controller || job.ended !== undefined || job.state === 'stopping') return false;
    job.state = 'stopping'; controller.abort(); this.changed(); return true;
  }
  start(command: string, cwd: string, execute: (signal: AbortSignal, update: (output: string, log?: string) => void) => Promise<{ output: string; failed: boolean; exitCode?: number; log?: string }>, options: ShellOptions = {}) {
    const id = randomUUID(), controller = new AbortController();
    this.controllers.set(id, controller); this.begin(id, command, cwd, 'background', 'main', options);
    const task = Promise.resolve().then(() => execute(controller.signal, (output, log) => this.update(id, output, log)))
      .then(result => this.end(id, result.output, result.failed, { exitCode: result.exitCode, log: result.log }), error => this.end(id, `${this.jobs.get(id)?.output ?? ''}\n${error instanceof Error ? error.message : String(error)}`, true))
      .finally(() => { this.controllers.delete(id); this.tasks.delete(task); });
    this.tasks.add(task); return id;
  }
  /** A shell's alert: its matches so far go on the job, and the reporter gets the message. Alerts stop once the shell has ended. */
  alerted(id: string, alert: ShellAlert) {
    const job = this.jobs.get(id);
    if (!job?.alert || job.ended !== undefined) return;
    job.matches = alert.total;
    this.reporter?.alerted(job, alertReport(id, job.alert, alert), alert);
  }
  clear() { if (this.tasks.size) throw new Error('Stop managed shells before clearing their history'); this.jobs.clear(); this.changed(); }
  async close() { for (const id of this.controllers.keys()) this.stop(id); await Promise.all(this.tasks); }
}

const ALERT_INTERVAL_MS = 10_000;
const compilePattern = (alert: string) => {
  try { return new RegExp(alert); } catch (error) { throw new Error(`alert is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`); }
};
/** The local shell, with each raw output chunk also given to the alerts. The bash tool's own updates are only snapshots of its tail. */
function tapped(watch: OutputAlerts): BashOperations {
  const local = createLocalBashOperations();
  return { exec: (command, cwd, options) => local.exec(command, cwd, { ...options, onData: data => { watch.feed(data); options.onData(data); } }) };
}
const REPORT_LINES = 30, REPORT_CHARS = 3_000, REPORT_COMMAND_CHARS = 300;
/** Whether a shell that ended in `state` is reported under its notify mode: every end, failures only (failed or timed out), or never. */
export const endNoticeWanted = (notify: ShellNotify, state: ShellJob['state']) => notify === 'end' || (notify === 'failure' && state === 'failed');
/** Background shells still running, for the status line. */
export const runningShells = (jobs: ShellJobs) => jobs.list().filter(job => job.mode === 'background' && (job.state === 'running' || job.state === 'stopping'));
/** The message the main agent receives when a managed background shell ends: its outcome, command and the end of its output, never all of it. */
export function shellReport(job: ShellJob): string {
  const seconds = Math.max(0, ((job.ended ?? Date.now()) - job.started) / 1000);
  const ran = seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const outcome = [job.state, job.exitCode === undefined ? undefined : `exit ${job.exitCode}`, `ran ${ran}`].filter(Boolean).join(' · ');
  const command = job.command.replace(/\s+/g, ' ').trim(), shortCommand = [...command].slice(0, REPORT_COMMAND_CHARS).join('') + ([...command].length > REPORT_COMMAND_CHARS ? '…' : '');
  const lines = job.output.replace(/\r\n?/g, '\n').trimEnd().split('\n'), kept = lines.slice(-REPORT_LINES);
  let tail = kept.join('\n');
  if ([...tail].length > REPORT_CHARS) tail = `…${[...tail].slice(-REPORT_CHARS).join('')}`;
  const omitted = lines.length - kept.length;
  const output = tail.trim() ? `Last output${omitted > 0 ? ` (${omitted} earlier lines not shown)` : ''}:\n${tail}` : 'Output: (no output)';
  const closing = job.state === 'stopped' ? 'It was stopped and will not run again.' : 'It has finished.';
  const alertLine = job.alert === undefined ? [] : [`Alert /${job.alert}/: ${job.matches ?? 0} ${job.matches === 1 ? 'match' : 'matches'} in total.`];
  return [`[shell ${job.id}] ${outcome}`, `Command: ${shortCommand}`, ...alertLine, output,
    `Full output: ${job.log ?? `not kept; shell_status shows the last ${outputLimit / 1000} KB`}`,
    `${closing} Do not poll it; use shell_status only to read more of its output.`].join('\n');
}

/** One alert: the pattern, how many new matches and where they are, then the latest ones with the two lines before each. */
export function alertReport(id: string, pattern: string, alert: ShellAlert): string {
  const span = alert.firstLine === alert.lastLine ? `on line ${alert.firstLine}` : `on lines ${alert.firstLine}–${alert.lastLine}`;
  const hidden = alert.hidden > 0 ? ` (${alert.hidden} not shown)` : '';
  const clean = (text: string) => text.replace(/\r/g, '');
  const head = `[shell ${id}] alert: /${pattern}/ · ${alert.matches} new ${alert.matches === 1 ? 'match' : 'matches'} ${span}${hidden} · ${alert.total} so far`;
  const blocks = alert.shown.map(match => [...match.before.map(line => `  ${line.line} | ${clean(line.text)}`), `> ${match.line} | ${clean(match.text)}`].join('\n'));
  return [head, ...blocks].join('\n');
}

/** The profile's defaults for shell_start: the notify mode a call without one gets, and the alert interval. */
export interface ShellSettings {
  notifyDefault?: () => ShellNotify;
  /** The least time between two alerts of one shell. Defaults to 10 seconds. */
  alertIntervalMs?: number;
}

/** The shell_start arguments that a run needs. */
interface ShellArgs { command: string; timeout?: number; notify?: ShellNotify; alert?: string }
/** The bash tool, run for one shell. Its raw output feeds the alerts, when there are any, and the last matches go out when the run ends. */
async function runShell(id: string, cwd: string, args: ShellArgs, abort: AbortSignal, update: (output: string, log?: string) => void, watch: OutputAlerts | undefined) {
  try {
    const result = await createBashTool(cwd, watch ? { operations: tapped(watch) } : undefined)
      .execute(id, { command: args.command, timeout: args.timeout }, abort, partial => update(textContent(partial.content, false), partial.details?.fullOutputPath));
    const exitCode = field(result.structuredContent, 'exit_code');
    return { output: textContent(result.content, false), failed: result.isError === true,
      exitCode: typeof exitCode === 'number' ? exitCode : undefined, log: result.details?.fullOutputPath };
  } finally { watch?.end(); }
}
/** Starts a managed background shell for shell_start. A bad alert pattern is refused before anything starts. */
function startShell(jobs: ShellJobs, settings: ShellSettings, args: ShellArgs, cwd: string): string {
  const pattern = args.alert === undefined ? undefined : compilePattern(args.alert);
  const notify = args.notify ?? settings.notifyDefault?.() ?? 'end';
  const id: string = jobs.start(args.command, cwd, (abort, update) => {
    const watch = pattern && new OutputAlerts({ pattern, intervalMs: settings.alertIntervalMs ?? ALERT_INTERVAL_MS, onAlert: alert => jobs.alerted(id, alert) });
    return runShell(id, cwd, args, abort, update, watch);
  }, { notify, alert: args.alert });
  return id;
}

export function registerShells(pi: ExtensionAPI, jobs: ShellJobs, canStart: () => void = () => {}, settings: ShellSettings = {}) {
  const shell = (name: string) => name === 'bash' || name === 'powershell';
  pi.on('tool_execution_start', (event, ctx) => {
    if (shell(event.toolName) && typeof event.args?.command === 'string') jobs.begin(event.toolCallId, event.args.command, ctx.cwd, 'foreground');
  });
  pi.on('tool_execution_update', event => { if (shell(event.toolName)) jobs.update(event.toolCallId, textContent(event.partialResult?.content, false)); });
  pi.on('tool_execution_end', event => { if (shell(event.toolName)) jobs.end(event.toolCallId, textContent(event.result?.content, false), event.isError); });
  pi.registerTool({ name: 'shell_start', label: 'Start background shell',
    description: 'Start an explicitly requested background shell (for example a local server or a long build), returning its ID immediately. Use only when background execution serves the user request. When it ends or is stopped, OptChat sends you a message starting "[shell ID]" with its outcome, exit code and the end of its output, between your tool calls or as a new turn. Do not poll or sleep for it: go on with other work, or end your turn and say what is running. Use shell_status only to read more output while it runs. Jobs are session-local and stopped when the profile closes. Detached child processes are not managed. Do not put secrets in commands. notify sets which ends reach you: "end" (the default: every end), "failure" (only a failed or timed-out shell) or "none". alert is a case-sensitive JavaScript regular expression: when a new output line matches it, you get that line with the two before it, rate-limited (at most one alert every 10 seconds; matches in between are counted).',
    parameters: Type.Object({ command: Type.String({ minLength: 1 }), timeout: Type.Optional(Type.Number({ minimum: 1 })),
      notify: Type.Optional(Type.Union(['end', 'failure', 'none'].map(value => Type.Literal(value)))), alert: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }),
    async execute(_id, args, signal, _update, ctx) {
      canStart();
      if (signal?.aborted) throw new Error('Shell start cancelled');
      const id = startShell(jobs, settings, args, ctx.cwd);
      return { content: [{ type: 'text', text: `Background shell ${id} started. Inspect with shell_status or /optchat shells.` }], details: { id } };
    },
  });
  pi.registerTool({ name: 'shell_status', label: 'Inspect background shell', description: 'Read a managed background shell state and bounded output, or list current session shells. Reading never waits for completion. A shell that ends is reported to you automatically, so read it only when you need more of its output.',
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    async execute(_id, args) {
      const list = jobs.list(), job = args.id ? list.find(j => j.id === args.id) : undefined;
      if (args.id && !job) throw new Error('Unknown shell ID');
      return { content: [{ type: 'text', text: job ? `${job.state} · ${job.mode}\n${job.command}\n${job.output || '(No output yet)'}` : list.map(j => `${j.id} · ${j.state} · ${j.mode} · ${j.command}`).join('\n') || 'No shells this session.' }], details: {} };
    },
  });
  pi.registerTool({ name: 'shell_stop', label: 'Stop background shell', description: 'Stop a managed background shell by ID. Does not stop ordinary foreground tools or detached processes.',
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, args) {
      if (!jobs.stop(args.id)) throw new Error('Shell is not a running managed background job');
      return { content: [{ type: 'text', text: 'Stop requested; check shell_status for completion.' }], details: {} };
    },
  });
}
