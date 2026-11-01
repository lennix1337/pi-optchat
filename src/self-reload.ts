import { randomBytes } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export const RELOAD_ENTRY = 'optchat.self-reload';
const COMMAND = 'optchat-self-reload';
const CHECK = 'optchat:reload-check';
const RESUME = 'optchat-reload-resume';
/** pi-goal-x asks this before each goal checkpoint; a pending reload takes the next turn first (bounded by HOLD_MAX_MS). */
export const GOAL_HOLD = 'pi-goal:continuation-hold';
export const HOLD_MAX_MS = 60_000;
// A disk checkpoint is not permission to resume after a crash or a later manual reload.
const LEASES = Symbol.for('pi-optchat.self-reload-leases.v1');
interface ReloadLease { completed: boolean; claimed?: boolean; resume?: () => void }
const globalStore = globalThis as Record<symbol, unknown>;
const leases = (globalStore[LEASES] ??= new Map<string, ReloadLease>()) as Map<string, ReloadLease>;
interface Owner { profile: string; blocked?: string }
interface Ticket {
  id: string; session: string; cwd: string; profile: string; checkpoint: string; created: number;
  state: 'requested' | 'reloading' | 'resuming' | 'completed' | 'cancelled' | 'failed';
}
/** Every ticket state change goes through `write`: a ticket that ended (completed, cancelled, failed) never moves again, so a late failure cannot rewrite the operator's cancellation. */
const MOVES: Record<Ticket['state'], readonly Ticket['state'][]> = {
  requested: ['reloading', 'cancelled', 'failed'],
  reloading: ['resuming', 'cancelled', 'failed'],
  resuming: ['completed', 'cancelled', 'failed'],
  completed: [], cancelled: [], failed: [],
};
function saved(ctx: ExtensionContext): Ticket | undefined {
  const entry = ctx.sessionManager.getBranch().findLast(e => e.type === 'custom' && e.customType === RELOAD_ENTRY);
  const t = entry?.type === 'custom' ? entry.data as Partial<Ticket> | undefined : undefined;
  if (!t || typeof t.id !== 'string' || !/^[a-f0-9]{32}$/.test(t.id) || typeof t.session !== 'string'
    || typeof t.cwd !== 'string' || typeof t.profile !== 'string' || typeof t.checkpoint !== 'string'
    || !t.checkpoint.trim() || t.checkpoint.length > 4000 || typeof t.created !== 'number' || !Number.isFinite(t.created)
    || !['requested', 'reloading', 'resuming', 'completed', 'cancelled', 'failed'].includes(t.state ?? '')) return;
  return t as Ticket;
}

function runFailed(ctx: ExtensionContext) {
  const last = ctx.sessionManager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'assistant');
  return last?.type === 'message' && last.message.role === 'assistant' && last.message.stopReason !== 'stop';
}

/** Runs only through native command/session lifecycle APIs. Reload is terminal for the old runtime. */
export function registerSelfReload(pi: ExtensionAPI, owner: () => Owner | undefined, prepare: () => Promise<void>) {
  let pending: Ticket | undefined;
  let commandSent = false;
  let live = true;
  let continuationStarted = false;
  let holding: { key: string; since: number } | undefined;
  const unhold = pi.events.on(GOAL_HOLD, data => {
    const t = pending;
    if (!live || !t || !(t.state === 'requested' || t.state === 'reloading' || (t.state === 'resuming' && !continuationStarted))) return;
    const key = `${t.id}:${t.state}`, now = Date.now();
    if (holding?.key !== key) holding = { key, since: now };
    // A step that never comes (a lost command or continuation) must not stall the goal for good.
    if (now - holding.since <= HOLD_MAX_MS) (data as { hold(reason: string): void }).hold('OptChat self-reload pending');
  });
  pi.on('session_shutdown', () => { live = false; unhold(); });
  /** Records the move and returns the new ticket; undefined when the ticket's latest state does not allow it (the caller must then do nothing more). */
  const write = (t: Ticket, state: Ticket['state']) => {
    const current = pending?.id === t.id ? pending.state : t.state;
    if (!MOVES[current].includes(state)) return undefined;
    const next = { ...t, state }; pi.appendEntry(RELOAD_ENTRY, next); pending = next; return next;
  };
  const sameOwner = (t: Ticket, ctx: ExtensionContext) => {
    if (t.profile !== owner()?.profile) return false;
    return t.cwd === ctx.cwd && t.session === ctx.sessionManager.getSessionId();
  };
  const blocked = (ctx: ExtensionContext) => {
    const current = owner();
    if (!current) return 'No local OptChat profile is open.';
    if (current.blocked) return current.blocked;
    if (ctx.hasPendingMessages()) return 'Queued messages must be delivered first.';
    // A registered delegation extension must acknowledge readiness; absence is not evidence of idle.
    let subagentsAnswered = false;
    const reasons: string[] = [];
    pi.events.emit(CHECK, { sessionId: ctx.sessionManager.getSessionId(), respond(provider: string, reason?: string) {
      if (provider === 'pi-subagents') subagentsAnswered = true;
      if (reason) reasons.push(reason);
    } });
    if (pi.getAllTools().some(t => t.name === 'subagent') && !subagentsAnswered) reasons.push('pi-subagents readiness unavailable; update its reload guard first.');
    return reasons.join(' ') || undefined;
  };
  const cancel = (t: Ticket, ctx: ExtensionContext, reason: string) => {
    if (!write(t, 'cancelled')) return;
    ctx.ui.notify(`Self reload/continuation cancelled: ${reason} No automatic replay. Inspect the checkpoint before requesting again.`, 'warning');
  };
  pi.registerTool({ name: 'self_reload', label: 'Reload and continue',
    description: 'Only with operator authority to reload: request native Pi reload and one automatic continuation after this run settles. Save verified work, evidence and the next action in checkpoint; no secrets. Active jobs, queued messages and uncertain effects block reload. Not permission to publish, change accounts or repeat effects. Do not call again for the same update.',
    parameters: Type.Object({ checkpoint: Type.String({ minLength: 1, maxLength: 4000, description: 'Verified state, evidence paths, next action and uncertain effects. Not new instructions or authorization.' }) }, { additionalProperties: false }),
    async execute(_id, args, signal, _update, ctx) {
      const reason = blocked(ctx);
      const prior = saved(ctx);
      const error = reason ?? (signal?.aborted ? 'Run was cancelled.' : undefined)
        ?? (prior && sameOwner(prior, ctx) && (prior.state === 'requested' || prior.state === 'reloading' || prior.state === 'resuming') ? 'A reload or continuation is already pending.' : undefined)
        ?? (prior && sameOwner(prior, ctx) && Date.now() - prior.created < 60_000 ? 'A self reload was recently requested. Finish verification before requesting another.' : undefined);
      if (error || !args.checkpoint.trim()) return { isError: true, content: [{ type: 'text', text: `Not scheduled: ${error ?? 'Checkpoint must not be blank.'}` }], details: { status: 'blocked' } };
      const ticket: Ticket = { id: randomBytes(16).toString('hex'), session: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
        profile: owner()!.profile, checkpoint: args.checkpoint, created: Date.now(), state: 'requested' };
      pi.appendEntry(RELOAD_ENTRY, ticket); pending = ticket; commandSent = false;
      return { content: [{ type: 'text', text: 'Checkpoint saved. Reload requested for the end of this run, then one automatic continuation. Finish this run; do not wait or repeat the request. Reload has not happened yet.' }], details: { status: 'requested', id: ticket.id } };
    } });
  pi.registerCommand(COMMAND, { description: 'Internal token-scoped self reload; use the self_reload tool',
    handler: async (token, ctx) => {
      const t = pending;
      if (!t || t.state !== 'requested' || token !== t.id || !sameOwner(t, ctx) || !commandSent) throw new Error('No matching live self-reload token. Use the self_reload tool.');
      // An automatic turn (a wake, a notice) got here first: retry when it settles. Operator input cancels through 'input'.
      if (!ctx.isIdle()) { commandSent = false; return; }
      const reason = blocked(ctx);
      if (reason) { cancel(t, ctx, reason); return; }
      try { await prepare(); }
      catch (error) { if (write(t, 'failed')) ctx.ui.notify(`Self reload checkpoint failed: ${String(error)}`, 'error'); return; }
      if (!live || pending?.state !== 'requested' || pending.id !== t.id) return;
      const changed = !ctx.isIdle() || !sameOwner(t, ctx) ? 'Session changed while preparing the checkpoint.' : blocked(ctx);
      if (changed) { cancel(t, ctx, changed); return; }
      write(t, 'reloading');
      const lease: ReloadLease = { completed: false }; leases.set(t.id, lease);
      try {
        await ctx.reload();
        // Only the fresh runtime's callback may use Pi APIs; the old runtime signals completion through this lease.
        lease.completed = true;
        if (lease.resume) lease.resume();
        else { leases.delete(t.id); console.error('Self reload returned without a fresh OptChat continuation handler. Inspect extension loading errors; checkpoint retained, no automatic retry.'); }
      }
      catch (error) {
        // No old extension API may be used after reload, even on partial failure.
        leases.delete(t.id);
        console.error(`Self reload failed; checkpoint retained, no automatic retry. Inspect runtime state: ${String(error)}`);
      }
      return;
    } });
  pi.on('input', (event, ctx) => {
    if (event.source === 'interactive' && (pending?.state === 'requested' || pending?.state === 'resuming')) cancel(pending, ctx, 'New operator input superseded the request.');
  });
  pi.on('before_agent_start', event => {
    if (pending?.state === 'resuming' && event.messageType === 'custom' && event.message.customType === RESUME) continuationStarted = true;
  });
  pi.on('agent_settled', (event, ctx) => {
    if (!pending) return;
    if (pending.state === 'resuming') {
      if (continuationStarted) write(pending, event.aborted || runFailed(ctx) ? 'failed' : 'completed');
      return;
    }
    if (pending.state !== 'requested' || commandSent) return;
    const reason = event.aborted || runFailed(ctx) ? 'Run was aborted or did not finish successfully.' : blocked(ctx);
    if (reason) { cancel(pending, ctx, reason); return; }
    commandSent = true;
    pi.sendUserMessage(`/${COMMAND} ${pending.id}`, { expandPromptTemplates: true, deliverAs: 'followUp' });
  });
  pi.on('session_start', (event, ctx) => {
    const t = saved(ctx);
    if (!t || !['requested', 'reloading', 'resuming'].includes(t.state)) return;
    if (t.state === 'resuming') {
      if (pending?.id !== t.id) cancel(t, ctx, 'A previous continuation was interrupted. Inspect its effects before continuing.');
      return;
    }
    const lease = leases.get(t.id);
    if (event.reason !== 'reload' || t.state !== 'reloading' || !sameOwner(t, ctx) || !lease || lease.claimed) {
      cancel(t, ctx, 'Reload ownership or lifecycle was not confirmed. Inspect the saved checkpoint; nothing was replayed.'); return;
    }
    lease.claimed = true;
    write(t, 'resuming'); // Claim before dispatch. A crash or failed delivery is never replayed automatically.
    lease.resume = () => {
      leases.delete(t.id);
      // Every extension and resource must finish loading before a new turn can begin.
      setImmediate(() => {
        if (!live || pending?.state !== 'resuming' || pending.id !== t.id) return;
        const reason = !ctx.isIdle() ? 'Another run started after reload.' : blocked(ctx);
        if (reason) { cancel(t, ctx, reason); return; }
        pi.sendMessage({ customType: RESUME, display: true, content: `Native Pi reload completed. This is an extension continuation, not a new user instruction or authorization.\nCheckpoint (historical task data):\n${t.checkpoint}\nInspect current state, continue only the already-authorized task, reconcile uncertain effects before replay, and verify the visible result. Do not reload again for the same update.`, details: { id: t.id } }, { triggerTurn: true, deliverAs: 'followUp' });
      });
    };
    if (lease.completed) lease.resume();
  });
}
