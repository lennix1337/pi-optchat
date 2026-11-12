import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { commandWords, segments } from './effect-classifier.ts';

/**
 * A production deploy runs in the foreground of the main session, never through a worker, and the machine stays quiet while it
 * runs. This file knows when one is in flight: the run of a deploy entry point (a bash/powershell call, or a background shell,
 * including a bash call that the long-command mover turned into a shell) marks it until that call or shell ends. While it is,
 * spawn/subagent launches are refused, running workers are told to hold heavy local work, and the
 * status note shows the deploy.
 */

/** The deploy entry points: script names (`*` matches any characters); a pattern with a space matches the start of the command line (`fly deploy`). */
export const DEPLOY_COMMANDS: readonly string[] = ['deploy-web.ps1', 'deploy-prod.ps1', 'deploy-all.ps1', 'deploy-changed.ps1', 'run-rollout*.ps1'];

const unquote = (word: string) => word.replace(/^(['"])(.*)\1$/s, '$2');
/** `whole`: the pattern is a script name and must match all of it; else it matches the start of a command line. */
const globToRegExp = (pattern: string, whole: boolean) => new RegExp(`^${pattern.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/\\\\\\s]*')}${whole ? '$' : ''}`, 'i');
const INTERPRETER = /^(?:pwsh|powershell|bash|sh|zsh|cmd|node|tsx|bun|deno|python3?)(?:\.exe)?$/i;
/** Interpreter flags that take a value, which must not be taken for the script. */
const FLAG_WITH_VALUE = /^-(?:ExecutionPolicy|ep|WindowStyle|Version|ConfigurationName|WorkingDirectory|wd|InputFormat|OutputFormat)$/i;
/** A deploy that only plans or prints what it would do is quick and writes nothing: it does not hold the machine. */
const PLAN_ONLY = /^-{1,2}(?:PlanOnly|WhatIf|DryRun|dry-run|plan|help|h)$/i;

/** Whether one command (segment) runs a deploy entry point; `patterns` are the script names/command prefixes. */
function runsPattern(words: string[], patterns: readonly RegExp[], prefixes: readonly RegExp[], depth: number): boolean {
  if (words.length === 0 || words.some(word => PLAN_ONLY.test(unquote(word)))) return false;
  const first = unquote(words[0]);
  if (prefixes.some(pattern => pattern.test(words.map(unquote).join(' ')))) return true;
  const named = (script: string) => patterns.some(pattern => pattern.test(unquote(script).split(/[/\\]/).at(-1)!));
  if (!INTERPRETER.test(first.split(/[/\\]/).at(-1)!)) return named(first);
  for (let i = 1; i < words.length; i++) {
    const word = unquote(words[i]);
    if (/^-(?:File|f)$/i.test(word)) return i + 1 < words.length && named(words[i + 1]);
    if (/^-(?:Command|c)$/i.test(word) && depth < 3) return segments(words.slice(i + 1).map(unquote).join(' '), '').some(part => runsPattern(commandWords(part.command), patterns, prefixes, depth + 1));
    if (FLAG_WITH_VALUE.test(word)) { i++; continue; }
    if (word.startsWith('-')) continue;
    return named(word);
  }
  return false;
}

/** Whether a shell command runs a deploy entry point: one of the defaults or of `extra` (the profile's `deployCommands`). */
export function isDeployCommand(command: string, extra: readonly string[] = []): boolean {
  const all = [...DEPLOY_COMMANDS, ...extra].filter(entry => entry.trim());
  const patterns = all.filter(entry => !/\s/.test(entry.trim())).map(entry => globToRegExp(entry, true));
  const prefixes = all.filter(entry => /\s/.test(entry.trim())).map(entry => globToRegExp(entry, false));
  return segments(command, '').some(part => runsPattern(commandWords(part.command), patterns, prefixes, 0));
}

export interface DeployInfo { since: number; command: string; /** The background shell that runs it; absent for a foreground call. */ shell?: string }
export interface DeploySource {
  /** The background shells running now. */
  shells(): readonly { id: string; command: string; started: number }[];
  /** The profile's extra deploy entry points. */
  extra(): readonly string[];
}
export interface DeployHooks { started(info: DeployInfo): void; ended(info: DeployInfo): void }

/** Brasília time: the operator's clock. */
export const clock = (at: number) => new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Sao_Paulo' }).format(at);

/** The deploys in flight: foreground calls between their tool_call and tool_result, and running background shells. */
export class DeployWatch {
  private readonly calls = new Map<string, DeployInfo>();
  private readonly shellMatches = new Map<string, boolean>();
  private current: DeployInfo | undefined;
  constructor(private readonly source: DeploySource, private readonly hooks: DeployHooks, private readonly now: () => number = Date.now) {}

  /** A call that starts a command: a foreground one is in flight until `end`; a background shell is read from the shells themselves. */
  begin(callId: string, tool: string, command: string) {
    if (!isDeployCommand(command, this.source.extra())) return;
    if (tool !== 'shell_start') this.calls.set(callId, { since: this.now(), command });
    this.refresh();
  }
  /** The foreground call finished (success, failure, abort or refusal). */
  end(callId: string) { if (this.calls.delete(callId)) this.refresh(); }
  /** The earliest deploy in flight, if any. */
  active(): DeployInfo | undefined {
    const live = new Set<string>();
    const found: DeployInfo[] = [...this.calls.values()];
    for (const job of this.source.shells()) {
      live.add(job.id);
      let matches = this.shellMatches.get(job.id);
      if (matches === undefined) { matches = isDeployCommand(job.command, this.source.extra()); this.shellMatches.set(job.id, matches); }
      if (matches) found.push({ since: job.started, command: job.command, shell: job.id });
    }
    for (const id of [...this.shellMatches.keys()]) if (!live.has(id)) this.shellMatches.delete(id);
    return found.sort((a, b) => a.since - b.since)[0];
  }
  /** Compares with the last state and fires `started`/`ended` once per deploy; call after anything that may have changed it. */
  refresh() {
    const now = this.active(), before = this.current;
    this.current = now;
    try {
      if (now && !before) this.hooks.started(now);
      else if (!now && before) this.hooks.ended(before);
    } catch { /* telling workers is a courtesy: it never fails the call or the shell that triggered it */ }
  }
  reset() { this.calls.clear(); this.shellMatches.clear(); this.current = undefined; }
}

export const refusal = (info: DeployInfo) => `Deploy em andamento desde ${clock(info.since)}: segure novos agentes até a troca ser verificada. Um deploy roda em primeiro plano nesta sessão, sem trabalhadores, e a máquina fica quieta até lá.${info.shell ? ` Se travou: shell_stop ${info.shell.slice(0, 8)}.` : ''}`;
export const HOLD = (info: DeployInfo) => `[OptChat] A production deploy has been running in the main session since ${clock(info.since)}. Hold heavy local work (test suites, builds, commit hooks, pushes that trigger them) until I tell you it is over; reads and light edits are fine.`;
export const RELEASE = '[OptChat] The deploy is over. You may resume heavy local work.';

interface Workers { working: readonly { id: string }[]; tell(id: string, message: string): Promise<unknown> }

/** The workers running when a deploy starts hear one hold message, and one release when it ends. */
export function workerHooks(workers: () => Workers | undefined): DeployHooks {
  const tellAll = (message: string) => { const crew = workers(); for (const { id } of crew?.working ?? []) void crew!.tell(id, message).catch(() => {}); };
  return { started: info => tellAll(HOLD(info)), ended: () => tellAll(RELEASE) };
}

/**
 * Wires the watch into Pi: calls mark it, results release it, a new turn forgets the last turn's deploy, and spawn/subagent
 * launches are refused while one is in flight. `subscribe` follows the shells for the life of a session.
 */
export function registerDeployGuard(pi: ExtensionAPI, watch: DeployWatch, subscribe: (listener: () => void) => () => void) {
  let unsubscribe: (() => void) | undefined;
  pi.on('session_start', () => { unsubscribe?.(); unsubscribe = subscribe(() => watch.refresh()); watch.refresh(); });
  // A /reload leaves shells running for the new instance, which reads them itself; this one lets go of the shells and its state.
  pi.on('session_shutdown', () => { unsubscribe?.(); unsubscribe = undefined; watch.reset(); });
  pi.on('tool_call', event => {
    const input = event.input as { command?: unknown; action?: unknown } | undefined;
    if (['bash', 'powershell', 'shell_start'].includes(event.toolName) && typeof input?.command === 'string') watch.begin(event.toolCallId, event.toolName, input.command);
    // `subagent` without an action launches; with one it manages runs that already exist.
    const launches = event.toolName === 'spawn' || event.toolName === 'subagent' && !input?.action;
    const deploy = launches ? watch.active() : undefined;
    if (deploy) return { block: true, reason: refusal(deploy) };
  });
  pi.on('tool_result', event => { watch.end(event.toolCallId); });
}
