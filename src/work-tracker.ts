import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { assistantConfig, assistantRequest } from './assistant-client.ts';
import { wakeTask } from './heartbeat.ts';
import type { RunInfo } from './runs.ts';
import type { ShellJob } from './shells.ts';
import { PROJECTS, projectOf, projectOfRun, type Project } from './projects.ts';
import { FROM_SLACK } from './slack-bridge.ts';
import { textContent } from './transcript.ts';

/**
 * Mirrors the work this chat does into the assistant service, so the operator's panel shows it: each run (a message,
 * a Slack DM, a wake), each background shell and each subagent becomes a task that moves to working and ends in
 * ready_for_review, needs_input (the run ended asking the operator something), succeeded or failed, with a short note.
 * Verification stays not_verified: the note is what was reported, not proof. Best effort: a stopped service costs
 * one warning and never blocks the chat.
 */
export type WorkOwner = { dir: string; name: string; sessionId: string };
type Status = 'working' | 'needs_input' | 'ready_for_review' | 'succeeded' | 'failed';
type Request = (owner: WorkOwner, path: string, body?: unknown) => Promise<unknown>;
/** `project` (dentai, genexus18mcp, harness) rides on every event as `<channel> · <project>`; the panel filters by it. */
type Open = { id: string; channel: string; revision: number; status: string; project?: Project };
type Watched<T> = { subscribe(listener: () => void): () => void; snapshot(): T[] };

const NOTE_MAX = 600;
export const clean = (s: string, max: number) => {
  const t = s.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const defaultRequest: Request = (owner, path, body) => assistantRequest(assistantConfig(owner), path, body, 10_000);

/** Which door a run came through, and the card title. */
export function classify(prompt: string): { channel: string; title: string } {
  const slack = FROM_SLACK.exec(prompt);
  if (slack) return { channel: slack[1] ? `Slack #${slack[1]}` : 'Slack', title: prompt.slice(slack[0].length) };
  const wake = wakeTask(prompt);
  if (wake !== undefined) return { channel: 'Wake', title: wake ? `Wake: ${wake}` : 'Wake agendado' };
  if (/^\[shell [^\]]+\]/.test(prompt)) return { channel: 'Shell', title: prompt };
  if (/^\[[\w-]+\] /.test(prompt)) return { channel: 'Subagente', title: prompt };
  return { channel: 'OptChat', title: prompt };
}

/** How a run ended: a failure, a question for the operator, or work to review. */
export function outcome(messages: readonly AgentMessage[]): { status: Status; note: string } {
  const last = [...messages].reverse().find((m): m is Extract<AgentMessage, { role: 'assistant' }> => m.role === 'assistant');
  const text = last ? textContent(last.content, false).trim() : '';
  if (!last || last.stopReason === 'error' || last.stopReason === 'aborted') return { status: 'failed', note: clean(text || `Execução terminou sem resposta (${last?.stopReason ?? 'sem mensagem'}).`, NOTE_MAX) };
  return { status: /\?\s*$/.test(text) ? 'needs_input' : 'ready_for_review', note: clean(text || 'Terminou sem resposta em texto.', NOTE_MAX) };
}

export class WorkTracker {
  private chain: Promise<void> = Promise.resolve();
  private started = false;
  private run: Open | undefined;
  /** The last operator run that ended with a question: the operator's next message continues that task. */
  private waiting: Open | undefined;
  private warned = false;
  /** No assistant.json in the profile: the operator has no assistant, so there is no panel to mirror into. */
  private off = false;

  constructor(private readonly owner: () => WorkOwner | undefined, private readonly request: Request = defaultRequest, private readonly warn: (text: string) => void = () => {}) {}

  /** Resolves when every queued update has been sent (or failed). */
  idle(): Promise<void> { return this.chain; }

  /** The first user message of a run opens its task. */
  userMessage(text: string): void {
    if (this.started) return;
    this.started = true;
    const { channel, title } = classify(text);
    const waiting = this.waiting;
    if (waiting && (channel === 'OptChat' || channel === 'Slack')) {
      this.waiting = undefined; this.run = waiting;
      this.enqueue(o => this.move(o, waiting, 'working', `Resposta recebida: ${clean(title, 200)}`));
      return;
    }
    const open = this.open(channel); this.run = open;
    const slack = FROM_SLACK.exec(text)?.[1];
    if (slack && (PROJECTS as readonly string[]).includes(slack)) open.project = slack as Project;
    this.enqueue(o => this.create(o, open, title, 'Em andamento'));
  }

  runEnded(messages: readonly AgentMessage[]): void {
    this.started = false;
    const run = this.run; this.run = undefined;
    if (!run) return;
    const { status, note } = outcome(messages);
    run.project ??= projectOfRun(messages);
    if (status === 'needs_input' && run.channel !== 'Wake') this.waiting = run;
    this.enqueue(o => this.move(o, run, status, note));
  }

  /** Background shells: one task each, from start to exit. */
  watchShells(source: Watched<ShellJob>): () => void {
    return this.watch(source, job => job.mode === 'background' ? job.id : undefined, job => ({ channel: 'Shell', title: job.command, project: projectOf(job.command, job.cwd) }),
      job => job.ended === undefined ? undefined : { status: job.state === 'completed' ? 'succeeded' : 'failed', note: `${job.state}${job.exitCode === undefined ? '' : ` · exit ${job.exitCode}`} · ${clean(job.output.slice(-400), 400) || 'sem saída'}` });
  }

  /** Running subagents: one task each. A finished one leaves the running list; its report reaches the parent, who reviews it. */
  watchAgents(source: Watched<RunInfo>): () => void {
    return this.watch(source, run => run.id, run => ({ channel: 'Subagente', title: `[${run.id.slice(0, 8)}] ${run.task}`, project: projectOf(run.cwd) }), () => undefined,
      { status: 'ready_for_review', note: 'Terminou; o relatório foi para o OptChat revisar.' });
  }

  private watch<T>(source: Watched<T>, key: (item: T) => string | undefined, start: (item: T) => { channel: string; title: string; project?: Project },
    end: (item: T) => { status: Status; note: string } | undefined, gone?: { status: Status; note: string }): () => void {
    const tracked = new Map<string, { open: Open; done: boolean }>();
    const finish = (entry: { open: Open; done: boolean }, result: { status: Status; note: string }) => {
      entry.done = true;
      const open = entry.open;
      this.enqueue(o => this.move(o, open, result.status, result.note));
    };
    const check = () => {
      const seen = new Set<string>();
      for (const item of source.snapshot()) {
        const id = key(item); if (id === undefined) continue;
        seen.add(id);
        let entry = tracked.get(id);
        const finished = end(item);
        if (!entry) {
          if (finished) continue; // Ended before we saw it run (e.g. history after a reload): not new work.
          const { channel, title, project } = start(item);
          entry = { open: { ...this.open(channel), project }, done: false }; tracked.set(id, entry);
          const open = entry.open;
          this.enqueue(o => this.create(o, open, title, 'Rodando'));
        }
        if (finished && !entry.done) finish(entry, finished);
      }
      for (const [id, entry] of tracked) {
        if (entry.done && !seen.has(id)) tracked.delete(id);
        else if (!entry.done && !seen.has(id) && gone) { finish(entry, gone); tracked.delete(id); }
      }
    };
    check();
    return source.subscribe(check);
  }

  private open(channel: string): Open {
    return { id: `work-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`, channel, revision: 0, status: 'new' };
  }

  private enqueue(fn: (owner: WorkOwner) => Promise<void>): void {
    const owner = this.owner();
    if (!owner || this.off) return;
    this.chain = this.chain.then(() => this.off ? undefined : fn(owner)).catch(error => {
      if (error instanceof Error && error.message.startsWith('Assistant disabled.')) { this.off = true; return; }
      if (this.warned) return;
      this.warned = true;
      this.warn(`Painel do assistente não atualizado (${error instanceof Error ? error.message : String(error)}); sigo sem ele até o próximo /reload.`);
    });
  }

  private context(owner: WorkOwner, open: Open, note: string) {
    const source = randomUUID();
    return { sessionId: owner.sessionId, channelId: open.project ? `${open.channel} · ${open.project}` : open.channel, runId: open.id, sourceEventId: source, evidenceReference: clean(note, NOTE_MAX) || '-' };
  }

  private async create(owner: WorkOwner, open: Open, title: string, note: string): Promise<void> {
    const context = this.context(owner, open, note);
    await this.request(owner, '/v1/tasks', { task: { version: 1, profileId: owner.name, taskId: open.id, title: clean(title, 160) || open.channel, status: 'queued', verification: 'not_verified', revision: 1, inputRevision: 1, sourceEventId: context.sourceEventId }, context });
    open.revision = 1; open.status = 'queued';
    await this.move(owner, open, 'working', note);
  }

  private async move(owner: WorkOwner, open: Open, next: Status, note: string): Promise<void> {
    if (open.revision === 0 || open.status === next) return; // Never created (service down): nothing to move.
    const task = await this.request(owner, `/v1/tasks/${encodeURIComponent(open.id)}/transition`, { expectedRevision: open.revision, nextStatus: next, context: this.context(owner, open, note) }) as { revision: number; status: string };
    open.revision = task.revision; open.status = task.status;
  }
}

/** Wires the tracker into Pi's run events. Shells and subagents are attached by the caller, which owns them. */
export function registerWorkTracker(pi: ExtensionAPI, owner: () => WorkOwner | undefined): WorkTracker {
  let warn: (text: string) => void = () => {};
  const tracker = new WorkTracker(owner, defaultRequest, text => warn(text));
  pi.on('session_start', (_event, ctx) => { warn = text => ctx.ui.notify(text, 'warning'); });
  pi.on('message_end', event => { if (event.message.role === 'user') tracker.userMessage(textContent(event.message.content, false)); });
  pi.on('agent_end', event => tracker.runEnded(event.messages));
  return tracker;
}
