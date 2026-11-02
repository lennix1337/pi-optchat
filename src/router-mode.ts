import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { HANDOFF_MAX_BYTES, handoffEnvelope } from './handoff-envelope.ts';

/**
 * Router mode (opt-in, off by default): the main agent talks to the operator and dispatches. Execution is not in its tool
 * set: commands, file edits and outside actions go to isolated workers started with spawn, whose reports return as
 * messages. The article this follows found that a neutral prompt never made the main session delegate, so the
 * restriction is in the tool set, where the model cannot choose around it.
 */
/** Tools that execute commands, change files or act outside OptChat. A router's model never sees them. */
export const ROUTER_WITHHELD: readonly string[] = ['bash', 'powershell', 'edit', 'write', 'shell_start', 'codemode', 'browser_harness', 'desktop', 'project_checks'];

export const ROUTER_DOC = `# Router mode
You route and report; you do not execute. Commands, builds, tests, git and file edits are not in your tool set. For such work, call spawn with one self-contained task per worker, naming its cwd; a worker runs in its own session with the full tools and reports back as a message. Read memory and report to the operator yourself. When a report arrives, state its outcome; do not re-run its work. Tasks and guidance are capped at ${HANDOFF_MAX_BYTES} bytes: put larger material in a file or memory page and pass its path or ID.`;

/** The state key survives a /reload (same process), so tools taken out before a reload are still given back after it. */
const STATE = Symbol.for('pi-optchat.router-removed');
const store = globalThis as Record<symbol, string[] | undefined>;

/**
 * The active tool set for router mode on or off. On: the withheld tools are taken out, and remembered. Off: the tools
 * taken out earlier that are still registered come back, and only those. Pure.
 */
export function routerToolSet(active: readonly string[], on: boolean, removed: readonly string[], registered: readonly string[]): { active: string[]; removed: string[] } {
  const withheld = new Set(ROUTER_WITHHELD);
  if (on) {
    const taken = active.filter(name => withheld.has(name));
    return { active: active.filter(name => !withheld.has(name)), removed: [...new Set([...removed, ...taken])] };
  }
  const known = new Set(registered), present = new Set(active);
  const back = removed.filter(name => known.has(name) && !present.has(name));
  return { active: [...active, ...back], removed: [] };
}

/** Applies router mode to the session's active tools; a no-op when the set is already right, so off costs nothing. */
export function syncRouterTools(pi: ExtensionAPI, on: boolean) {
  const active = pi.getActiveTools();
  const next = routerToolSet(active, on, store[STATE] ?? [], pi.getAllTools().map(tool => tool.name));
  store[STATE] = next.removed;
  if (next.active.length !== active.length || next.active.some((name, index) => name !== active[index])) pi.setActiveTools(next.active);
}

/**
 * What the router reads of a worker's end: its outcome, bounded, with pointers to its run and transcript. The full chat
 * stays in the worker's session; the router does not get it.
 */
export function routerReport(run: { id: string; report?: string; sessionFile?: string }): string {
  const pointers = [{ kind: 'run' as const, ref: run.id }, ...(run.sessionFile ? [{ kind: 'file' as const, ref: run.sessionFile }] : [])];
  return handoffEnvelope({ id: run.id, from: `worker ${run.id}`, to: 'router', summary: run.report ?? 'No final answer recorded.', pointers }).text;
}
