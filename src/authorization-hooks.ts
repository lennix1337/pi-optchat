import type { ExtensionAPI, ExtensionContext, InputEventResult } from '@earendil-works/pi-coding-agent';
import { EffectApprovals, touchesContract, type ApprovalMode, type PendingApproval, type Settled } from './authorization.ts';
import { classifyEffects, describeDecision, logReported, type Decision, type Effect, type Repo } from './autonomy.ts';
import { readProfileEffectPolicy } from './effect-policy.ts';
import { judgeSelfEdit } from './autonomy-self-edit.ts';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { worktreeRemovalRefusal } from './worktree-guard.ts';

const WIDGET = 'optchat-approval';
type UiContext = Pick<ExtensionContext, 'sessionManager' | 'ui'>;
/** Where the operator's autonomy.json lives (the open profile), or undefined when no profile is open. */
export type ContractDir = () => string | undefined;

// BEL makes Windows Terminal flash the taskbar (or beep) when the operator is in another window.
const terminalBell = () => { if (process.stdout.isTTY) process.stdout.write('\x07'); };

const label = ({ kind, tool }: PendingApproval) => kind ?? tool;
const summaries = (pending: PendingApproval[]) => pending.map(p => p.summary).join('; ');

function widgetLines([latest, ...older]: PendingApproval[]) {
  return [
    `\u23f8 Waiting for your approval \u2014 ${label(latest)}: ${latest.summary}`,
    `  /approve  run it once     /deny  drop it${older.length ? `     (${older.length} older pending: ${older.map(label).join(', ')})` : ''}`,
  ];
}

/** Keeps the pending calls above the editor until they are approved, denied or expire. */
function pendingDisplay(gate: EffectApprovals) {
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const show = (ctx: UiContext) => {
    const pending = gate.pendingFor(ctx.sessionManager.getSessionId());
    ctx.ui.setWidget?.(WIDGET, pending.length ? widgetLines(pending) : undefined);
    clearTimeout(expiry);
    if (!pending.length) return;
    expiry = setTimeout(() => show(ctx), Math.max(0, Math.min(...pending.map(p => p.expires)) - Date.now()) + 50);
    expiry.unref?.();
  };
  const hide = (ctx: UiContext) => { clearTimeout(expiry); ctx.ui.setWidget?.(WIDGET, undefined); };
  return { show, hide };
}

/** Operator-typed `/approve` or `/deny`, read with its input source; undefined for any other text. */
function operatorCommand(gate: EffectApprovals, text: string, source: string, ctx: UiContext): InputEventResult | undefined | 'pass' {
  const command = text.trim().toLowerCase();
  if (command !== '/approve' && command !== '/deny') return 'pass';
  if (source !== 'interactive') return;
  const session = ctx.sessionManager.getSessionId();
  if (command === '/approve') {
    const approved = gate.approveLatest(session, source);
    if (!approved) { ctx.ui.notify('Nothing is pending approval.', 'info'); return { action: 'handled' }; }
    ctx.ui.notify(`Approved once: ${approved.summary}`, 'info');
    // The model sees the same exact-token approval it was told to wait for.
    return { action: 'transform', text: `approve-effect ${approved.token}` };
  }
  const dropped = gate.deny(session, source);
  if (!dropped.length) { ctx.ui.notify('Nothing is pending approval.', 'info'); return { action: 'handled' }; }
  ctx.ui.notify(`Dropped: ${summaries(dropped)}`, 'info');
  return { action: 'transform', text: `Denied by the operator, do not run or retry: ${summaries(dropped)}` };
}

const NOTICES = {
  embedded: ['Not approved: approve-effect only counts as a message on its own. Type /approve to run the pending call once.', 'warning'],
  invalid: ['Effect approval refused: token expired or used, another session, or not `approve-standing push-main <absolute root>...` / `approve-standing paid-subagents`. No execution occurred. Type /approve for the call pending now.', 'warning'],
  standing: ['Standing grant active until session reset: only the granted class (exact `git -C <listed root> push origin main`, or direct `subagent` tool calls). Force, other refs, tags, nested/codemode calls and other commands still need exact approval.', 'info'],
  approved: ['Exact invocation approved once. Nested calls and retries still require their own approval.', 'info'],
} as const;
const RESULTS = { embedded: undefined, invalid: { action: 'handled' }, standing: { action: 'handled' },
  // Keep the exact interactive token as input; do not manufacture a broader user request.
  approved: { action: 'continue' } } as const satisfies Record<keyof typeof NOTICES, InputEventResult | undefined>;

/** The operator's typed order covering an effect (a line for the log), or undefined; see `orderGrantFor`. */
export type OrderGrant = (effect: Effect) => string | undefined;
/** Where the contract lives, how its targets are read, and which typed orders can lift its `ask` rules. */
interface ContractSource { dir: ContractDir; repo?: Repo; orderGrant?: OrderGrant }

function reportEffect(dir: string, decision: Decision, pending: PendingApproval, ctx: ExtensionContext) {
  const { effect } = decision;
  try { logReported(dir, { at: Date.now(), action: effect?.action ?? 'unclassified', targets: effect?.targets ?? [], summary: pending.summary, rule: decision.rule?.note }); }
  catch (error) { ctx.ui.notify(`Could not record a reported effect in autonomy-log.jsonl: ${error instanceof Error ? error.message : String(error)}`, 'warning'); }
  ctx.ui.notify(`Ran under autonomy.json (report) \u2014 ${describeDecision(decision)}: ${pending.summary}`, 'info');
}

/**
 * What the operator's typed order names runs and is logged; the rest of the call is judged as if alone. `run` when the
 * order covers every effect, the rest's decision when it no longer asks, else undefined (nothing lifted, nothing logged).
 */
function liftOrdered(dir: string, effects: Effect[], orderGrant: OrderGrant, pending: PendingApproval, ctx: ExtensionContext): 'run' | Decision | undefined {
  const orders = effects.map(effect => [effect, orderGrant(effect)] as const);
  const rest = orders.filter(([, line]) => !line).map(([effect]) => effect);
  if (rest.length === effects.length) return undefined;
  const remaining = rest.length ? readProfileEffectPolicy(dir, () => rest) : undefined;
  if (remaining?.level === 'ask') return undefined;
  for (const [effect, line] of orders) if (line) reportEffect(dir, { level: 'report', effect, rule: { action: effect.action, scope: ['*'], level: 'report', note: line } }, pending, ctx);
  return remaining ?? 'run';
}

/** The contract's word on a refused call: `run`, a refusal note, or undefined when no profile is open (the operator decides). */
function contractVerdict({ dir: contractDir, repo, orderGrant }: ContractSource, pending: PendingApproval, call: { tool: string; input: unknown; cwd: string }, ctx: ExtensionContext): 'run' | { note: string } | undefined {
  if (touchesContract(call, contractDir())) {
    const self = judgeSelfEdit(contractDir(), call);
    if (self?.ok) {
      const dir = contractDir()!;
      try { appendFileSync(join(dir, 'autonomy-log.jsonl'), `${JSON.stringify({ at: Date.now(), action: 'contract-self-edit', targets: [join(dir, 'autonomy.json')], summary: self.summary, rule: 'operator 03/11: the daily retro adjusts autonomy.json outside the protected rules' })}\n`); }
      catch (error) { ctx.ui.notify(`Could not log the autonomy.json self-edit: ${error instanceof Error ? error.message : String(error)}`, 'warning'); }
      ctx.ui.notify(self.summary, 'info');
      return 'run';
    }
    return { note: `Only the operator changes autonomy.json here${self ? ` (${self.reason})` : ''}: the contract cannot approve it. An edit/write of the file that leaves the protected rules and the default alone runs by itself. ` };
  }
  const dir = contractDir(), effects = classifyEffects(call, repo);
  let decision = readProfileEffectPolicy(dir, () => effects);
  if (decision?.level === 'ask' && !decision.problem && orderGrant && dir) {
    const lifted = liftOrdered(dir, effects, orderGrant, pending, ctx);
    if (lifted === 'run') return 'run';
    decision = lifted ?? decision;
  }
  if (!decision) return undefined;
  if (decision.level === 'ask') return { note: decision.problem ? `autonomy.json is unreadable (${decision.problem}), so every high-impact call waits for the operator. `
    : `autonomy.json says this waits for the operator: ${describeDecision(decision)}. ` };
  // A call with no recognised effect is logged only when the gate named a risk class for it: in `all` mode that is every tool call.
  if (decision.level === 'report' && dir && (decision.effect || pending.kind)) reportEffect(dir, decision, pending, ctx);
  return 'run';
}

/** Gate admission where a refused call is decided by the operator's autonomy.json, once per pending call; `note` explains a refusal it did not lift. */
function contractAdmission(gate: EffectApprovals, contract: ContractSource) {
  const notes = new Map<string, string>();
  /** The refusal note for a pending call, or undefined once the contract approved it. */
  const decide = (pending: PendingApproval, call: { session: string; cwd: string; tool: string; input: unknown }, ctx: ExtensionContext) => {
    const verdict = contractVerdict(contract, pending, call, ctx);
    if (verdict === 'run') { gate.approveByContract(call.session, pending.token); return undefined; }
    return verdict ? verdict.note : '';
  };
  return {
    admit(call: { session: string; cwd: string; tool: string; input: unknown }, ctx: ExtensionContext) {
      const refusal = gate.admit(call);
      const pending = refusal?.token ? gate.pendingFor(call.session).find(p => p.token === refusal.token) : undefined;
      if (!pending || notes.has(pending.token)) return { refusal, note: (pending && notes.get(pending.token)) ?? '' };
      const note = decide(pending, call, ctx);
      // Approved: admitting the same call again consumes the one-shot approval.
      if (note === undefined) return { refusal: gate.admit(call), note: '' };
      if (note) notes.set(pending.token, note);
      return { refusal, note };
    },
    clear: () => notes.clear(),
  };
}

/**
 * Holds each new pending call until the run ends (or `holdMs` passes), then passes on the ones still waiting: one the
 * operator already decided in the meantime is never announced.
 */
function heldUntilRunEnds(gate: EffectApprovals, announce: (pending: PendingApproval, session: string) => void, holdMs: number) {
  const held = new Map<string, { session: string; timer: ReturnType<typeof setTimeout> }>();
  const release = (token: string) => {
    const entry = held.get(token);
    if (!entry) return;
    clearTimeout(entry.timer);
    held.delete(token);
    const pending = gate.pendingFor(entry.session).find(p => p.token === token);
    if (pending) announce(pending, entry.session);
  };
  return {
    hold(pending: PendingApproval, session: string) {
      const timer = setTimeout(() => release(pending.token), holdMs);
      timer.unref?.();
      held.set(pending.token, { session, timer });
    },
    flush: () => [...held.keys()].forEach(release),
    clear: () => { held.forEach(({ timer }) => clearTimeout(timer)); held.clear(); },
  };
}

/** All grants are user-input provenance checked; no model-callable grant tool exists. `OPTCHAT_EFFECT_APPROVALS=1` gates every effect, `=risk` only the high-impact classes. */
export function registerEffectApprovals(pi: ExtensionAPI, { enabled = undefined as boolean | undefined, grant = true, mode = undefined as ApprovalMode | undefined, bell = terminalBell,
  contractDir = (() => undefined) as ContractDir, repo = undefined as Repo | undefined,
  /** The operator's typed order that lifts an `ask` rule for one effect (see `orderGrantFor`). */
  orderGrant = undefined as OrderGrant | undefined,
  /** Called once per call that waits for the operator (after the contract), e.g. to ask on Slack. */
  onPending = undefined as ((pending: PendingApproval, session: string, gate: EffectApprovals) => void) | undefined,
  /** Called when such a call stops waiting (approved, denied, superseded or expired), wherever it was decided. */
  onSettled = undefined as ((token: string, outcome: Settled) => void) | undefined,
  /** Longest a pending call is held back from `onPending` while the run goes on. */
  holdMs = 3 * 60_000 } = {}) {
  const env = process.env.OPTCHAT_EFFECT_APPROVALS;
  const guard = (event: { toolName: string; input: unknown }, cwd: string) => {
    if (event.toolName !== 'bash' || !event.input || typeof event.input !== 'object' || !('command' in event.input) || typeof event.input.command !== 'string') return;
    const reason = worktreeRemovalRefusal(event.input.command, cwd);
    if (reason) return { block: true as const, reason };
  };
  if (!(enabled ?? (env === '1' || env === 'risk'))) {
    pi.on('tool_call', (event, ctx) => guard(event, ctx.cwd));
    return;
  }
  const gate = new EffectApprovals({ mode: mode ?? (env === 'risk' ? 'risk' : 'all'), contractDir, onSettled: (token, outcome) => onSettled?.(token, outcome) });
  const display = pendingDisplay(gate);
  const alerted = new Set<string>();
  const admission = contractAdmission(gate, { dir: contractDir, repo, orderGrant });
  const phone = heldUntilRunEnds(gate, (pending, session) => onPending?.(pending, session, gate), holdMs);
  // Child SDK prompt/steer calls default to interactive even when manager-authored.
  if (grant) pi.on('input', (event, ctx) => {
    const command = operatorCommand(gate, event.text, event.source, ctx);
    if (command !== 'pass') { display.show(ctx); return command; }
    const result = gate.approve(ctx.sessionManager.getSessionId(), event.source, event.text);
    if (result === 'ignored') return;
    const [message, type] = NOTICES[result];
    ctx.ui.notify(message, type);
    display.show(ctx);
    return RESULTS[result];
  });
  pi.on('tool_call', (event, ctx) => {
    const blocked = guard(event, ctx.cwd);
    if (blocked) return blocked;
    const session = ctx.sessionManager.getSessionId();
    const call = { session, cwd: ctx.cwd, tool: event.toolName, input: event.input };
    if (!grant) return gate.admit(call) && { block: true, reason: 'Not executed: delegated sessions cannot grant effect approvals. Ask the operator to perform this action in the owning interactive session; do not relay approval tokens through agents.' };
    const { refusal, note } = admission.admit(call, ctx);
    display.show(ctx);
    if (!refusal) return;
    const pending = gate.pendingFor(session).find(p => p.token === refusal.token);
    if (pending && !alerted.has(pending.token)) {
      alerted.add(pending.token);
      ctx.ui.notify(`Approval needed \u2014 ${label(pending)}: ${pending.summary}. Type /approve to run it once, /deny to drop it.`, 'warning');
      bell();
      if (onPending) phone.hold(pending, session);
    }
    return { block: true, reason: note + refusal.reason };
  });
  // The phone hears only of calls still waiting once the run ends: one the operator already decided meanwhile
  // never reaches it. Later calls of the agent do not retire a pending call: only a decision, a newer approval or expiry does.
  pi.on('agent_end', () => phone.flush());
  const reset = (ctx: UiContext) => { gate.clear(); alerted.clear(); admission.clear(); phone.clear(); if (grant) display.hide(ctx); };
  pi.on('session_start', (_event, ctx) => reset(ctx));
  pi.on('session_shutdown', (_event, ctx) => reset(ctx));
  return gate;
}
