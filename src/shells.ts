import { randomUUID } from 'node:crypto';
import { createBashTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { textContent } from './transcript.ts';

export interface ShellJob {
  id: string; command: string; cwd: string; mode: 'foreground' | 'background';
  state: 'running' | 'stopping' | 'completed' | 'failed' | 'stopped';
  started: number; ended?: number; output: string; owner?: string;
}
const outputLimit = 32_000;
/** Session-local execution inventory. Only explicitly managed jobs can be stopped individually. */
export class ShellJobs {
  private readonly jobs = new Map<string, ShellJob>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private readonly listeners = new Set<() => void>();
  list() { return [...this.jobs.values()].reverse().sort((a, b) => Number(b.state === 'running' || b.state === 'stopping') - Number(a.state === 'running' || a.state === 'stopping') || b.started - a.started); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  begin(id: string, command: string, cwd: string, mode: ShellJob['mode'], owner = 'main') {
    this.jobs.set(id, { id, command, cwd, mode, owner, state: 'running', started: Date.now(), output: '' });
    this.changed();
  }
  update(id: string, output: string) {
    const job = this.jobs.get(id); if (!job) return;
    job.output = output.length > outputLimit ? `[Earlier output omitted]\n${output.slice(-outputLimit)}` : output;
    this.changed();
  }
  end(id: string, output: string, failed: boolean) {
    const job = this.jobs.get(id); if (!job || job.ended !== undefined) return;
    this.update(id, output);
    job.state = job.state === 'stopping' ? 'stopped' : failed ? 'failed' : 'completed';
    job.ended = Date.now();
    // Never evict an active execution, even when many jobs finish together.
    for (const finished of this.list().filter(j => j.ended !== undefined).slice(50)) this.jobs.delete(finished.id);
    this.changed();
  }
  stop(id: string) {
    const job = this.jobs.get(id), controller = this.controllers.get(id);
    if (!job || !controller || job.ended !== undefined || job.state === 'stopping') return false;
    job.state = 'stopping'; controller.abort(); this.changed(); return true;
  }
  start(command: string, cwd: string, execute: (signal: AbortSignal, update: (output: string) => void) => Promise<{ output: string; failed: boolean }>) {
    const id = randomUUID(), controller = new AbortController();
    this.controllers.set(id, controller); this.begin(id, command, cwd, 'background');
    const task = Promise.resolve().then(() => execute(controller.signal, output => this.update(id, output)))
      .then(result => this.end(id, result.output, result.failed), error => this.end(id, `${this.jobs.get(id)?.output ?? ''}\n${error instanceof Error ? error.message : String(error)}`, true))
      .finally(() => { this.controllers.delete(id); this.tasks.delete(task); });
    this.tasks.add(task); return id;
  }
  clear() { if (this.tasks.size) throw new Error('Stop managed shells before clearing their history'); this.jobs.clear(); this.changed(); }
  async close() { for (const id of this.controllers.keys()) this.stop(id); await Promise.all(this.tasks); }
}

export function registerShells(pi: ExtensionAPI, jobs: ShellJobs, canStart: () => void = () => {}) {
  const shell = (name: string) => name === 'bash' || name === 'powershell';
  pi.on('tool_execution_start', (event, ctx) => {
    if (shell(event.toolName) && typeof event.args?.command === 'string') jobs.begin(event.toolCallId, event.args.command, ctx.cwd, 'foreground');
  });
  pi.on('tool_execution_update', event => { if (shell(event.toolName)) jobs.update(event.toolCallId, textContent(event.partialResult?.content, false)); });
  pi.on('tool_execution_end', event => { if (shell(event.toolName)) jobs.end(event.toolCallId, textContent(event.result?.content, false), event.isError); });
  pi.registerTool({ name: 'shell_start', label: 'Start background shell',
    description: 'Start an explicitly requested background shell (for example a local server), returning its ID immediately. Use only when background execution serves the user request. View live output in OptChat Shells or shell_status. Jobs are session-local and stopped when the profile closes. Detached child processes are not managed. Do not put secrets in commands.',
    parameters: Type.Object({ command: Type.String({ minLength: 1 }), timeout: Type.Optional(Type.Number({ minimum: 1 })) }),
    async execute(_id, args, signal, _update, ctx) {
      canStart();
      if (signal?.aborted) throw new Error('Shell start cancelled');
      const id = jobs.start(args.command, ctx.cwd, async (abort, update) => {
        const result = await createBashTool(ctx.cwd).execute(id, args, abort, partial => update(textContent(partial.content, false)));
        return { output: textContent(result.content, false), failed: result.isError === true };
      });
      return { content: [{ type: 'text', text: `Background shell ${id} started. Inspect with shell_status or /optchat shells.` }], details: { id } };
    },
  });
  pi.registerTool({ name: 'shell_status', label: 'Inspect background shell', description: 'Read a managed background shell state and bounded output, or list current session shells. Reading never waits for completion.',
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
