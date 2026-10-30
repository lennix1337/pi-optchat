import type { ExtensionAPI, ExtensionContext, InputEventResult } from '@earendil-works/pi-coding-agent';
import { EffectApprovals, touchesContract, type ApprovalMode, type PendingApproval, type Settled } from './authorization.ts';
import { readGitHubIdentity, type AdvisorRequest, type AdvisorVerdict } from './effect-advisor.ts';
import { classifyEffects, describeDecision, logReported, type Decision, type Effect, type Repo } from './autonomy.ts';
import { readProfileEffectPolicy } from './effect-policy.ts';

const WIDGET = 'optchat-approval';
type UiContext = Pick<ExtensionContext, 'sessionManager' | 'ui'>;
export type Advisor = (request: AdvisorRequest, ctx: ExtensionContext) => Promise<AdvisorVerdict>;
/** Where the operator's autonomy.json lives (the open profile), or undefined when no profile is open. */
export type ContractDir = () => string | undefined;

const textOf = (content: unknown) => typeof content === 'string' ? content
  : Array.isArray(content) ? content.flatMap(block => (block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n') : '';

/** The operator's last few typed messages, so the advisor can tell a requested push from an unrequested one. */
function recentRequests(ctx: UiContext, count = 4, chars = 600) {
  const requests: string[] = [];
  const branch = ctx.sessionManager.getBranch?.() ?? [];
  for (let i = branch.length - 1; i >= 0 && requests.length < count; i--) {
    const entry = branch[i];
    if (entry.type !== 'message' || entry.message.role !== 'user') continue;
    const text = textOf(entry.message.content).replace(/\s+/g, ' ').trim();
    if (text && !/^approve-(?:effect|standing)\b/.test(text)) requests.unshift(text.length > chars ? `${text.slice(0, chars - 1)}\u2026` : text);
  }
  return requests;
}

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
  const effect = decision.effect!;
  try { logReported(dir, { at: Date.now(), action: effect.action, targets: effect.targets, summary: pending.summary, rule: decision.rule?.note }); }
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

/** The contract's word on a refused call: `run`, a refusal note, or undefined when it has no rule (the advisor decides). */
function contractVerdict({ dir: contractDir, repo, orderGrant }: ContractSource, pending: PendingApproval, call: { tool: string; input: unknown; cwd: string }, ctx: ExtensionContext): 'run' | { note: string } | undefined {
  if (touchesContract(call)) return { note: 'Only the operator changes autonomy.json: neither the contract nor the advisor can approve this. ' };
  const dir = contractDir(), effects = classifyEffects(call, repo);
  let decision = readProfileEffectPolicy(dir, () => effects);
  if (decision?.level === 'ask' && !decision.problem && orderGrant && dir) {
    const lifted = liftOrdered(dir, effects, orderGrant, pending, ctx);
    if (lifted === 'run') return 'run';
    decision = lifted ?? decision;
  }
  if (!decision || decision.level === 'advisor') return undefined;
  if (decision.level === 'ask') return { note: decision.problem ? `autonomy.json is unreadable (${decision.problem}), so every high-impact call waits for the operator. `
    : `autonomy.json says this waits for the operator: ${describeDecision(decision)}. ` };
  if (decision.level === 'report' && dir && decision.effect) reportEffect(dir, decision, pending, ctx);
  return 'run';
}

/** One advisor verdict on a pending call: undefined when it approved (the call may run once), else the refusal note. */
async function askAdvisor(advise: Advisor, gate: EffectApprovals, pi: ExtensionAPI, pending: PendingApproval, call: { session: string; tool: string; input: unknown }, ctx: ExtensionContext) {
  try {
    const githubIdentity = pending.kind === 'push' || pending.kind === 'publish' ? await readGitHubIdentity(pi.exec?.bind(pi)) : undefined;
    const verdict = await advise({ kind: pending.kind, tool: call.tool, input: call.input, cwd: ctx.cwd, requests: recentRequests(ctx), githubIdentity }, ctx);
    if (verdict.approve && gate.approveByAdvisor(call.session, pending.token)) {
      ctx.ui.notify(`Auto-approved by ${verdict.model} \u2014 ${label(pending)}: ${pending.summary} (${verdict.reason})`, 'info');
      return undefined;
    }
    return `The approval advisor (${verdict.model}) refused it: ${verdict.reason}. `;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Approval advisor unavailable (${reason}); this call waits for you.`, 'warning');
    return `The approval advisor was unavailable (${reason}). `;
  }
}

/** Gate admission where a refused call is decided by the operator's autonomy.json when it has a rule, else goes to the
 * advisor, once per pending call; `note` explains a refusal neither lifted. */
function advisedAdmission(gate: EffectApprovals, pi: ExtensionAPI, { advisor, grant, contract }: { advisor?: Advisor; grant: boolean; contract: ContractSource }) {
  // A delegated session never gets one: its calls wait for the operator in the owning session.
  const advise = grant && process.env.OPTCHAT_EFFECT_ADVISOR !== 'off' ? advisor : undefined;
  const notes = new Map<string, string>();
  /** The refusal note for a pending call, or undefined once the contract or the advisor approved it. */
  const decide = async (pending: PendingApproval, call: { session: string; cwd: string; tool: string; input: unknown }, ctx: ExtensionContext) => {
    const verdict = contractVerdict(contract, pending, call, ctx);
    if (verdict === 'run') { gate.approveByAdvisor(call.session, pending.token); return undefined; }
    if (verdict) return verdict.note;
    return advise ? askAdvisor(advise, gate, pi, pending, call, ctx) : '';
  };
  return {
    async admit(call: { session: string; cwd: string; tool: string; input: unknown }, ctx: ExtensionContext) {
      const refusal = gate.admit(call);
      const pending = refusal?.token ? gate.pendingFor(call.session).find(p => p.token === refusal.token) : undefined;
      if (!pending || notes.has(pending.token)) return { refusal, note: (pending && notes.get(pending.token)) ?? '' };
      const note = await decide(pending, call, ctx);
      // Approved: admitting the same call again consumes the one-shot approval.
      if (note === undefined) return { refusal: gate.admit(call), note: '' };
      if (note) notes.set(pending.token, note);
      return { refusal, note };
    },
    clear: () => notes.clear(),
  };
}

/** All grants are user-input provenance checked; no model-callable grant tool exists. `OPTCHAT_EFFECT_APPROVALS=1` gates every effect, `=risk` only the high-impact classes. */
export function registerEffectApprovals(pi: ExtensionAPI, { enabled = undefined as boolean | undefined, grant = true, mode = undefined as ApprovalMode | undefined, bell = terminalBell, advisor = undefined as Advisor | undefined,
  contractDir = (() => undefined) as ContractDir, repo = undefined as Repo | undefined,
  /** The operator's typed order that lifts an `ask` rule for one effect (see `orderGrantFor`). */
  orderGrant = undefined as OrderGrant | undefined,
  /** Called once per call that waits for the operator (after the contract and the advisor), e.g. to ask on Slack. */
  onPending = undefined as ((pending: PendingApproval, session: string, gate: EffectApprovals) => void) | undefined,
  /** Called when such a call stops waiting (approved, denied, superseded or expired), wherever it was decided. */
  onSettled = undefined as ((token: string, outcome: Settled) => void) | undefined } = {}) {
  const env = process.env.OPTCHAT_EFFECT_APPROVALS;
  if (!(enabled ?? (env === '1' || env === 'risk'))) return;
  const gate = new EffectApprovals({ mode: mode ?? (env === 'risk' ? 'risk' : 'all'), onSettled: (token, outcome) => onSettled?.(token, outcome) });
  const display = pendingDisplay(gate);
  const alerted = new Set<string>();
  const advised = advisedAdmission(gate, pi, { advisor, grant, contract: { dir: contractDir, repo, orderGrant } });
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
  pi.on('tool_call', async (event, ctx) => {
    const session = ctx.sessionManager.getSessionId();
    const call = { session, cwd: ctx.cwd, tool: event.toolName, input: event.input };
    if (!grant) return gate.admit(call) && { block: true, reason: 'Not executed: delegated sessions cannot grant effect approvals. Ask the operator to perform this action in the owning interactive session; do not relay approval tokens through agents.' };
    const { refusal, note } = await advised.admit(call, ctx);
    display.show(ctx);
    if (!refusal) return;
    const pending = gate.pendingFor(session).find(p => p.token === refusal.token);
    if (pending && !alerted.has(pending.token)) {
      alerted.add(pending.token);
      ctx.ui.notify(`Approval needed \u2014 ${label(pending)}: ${pending.summary}. Type /approve to run it once, /deny to drop it.`, 'warning');
      bell();
      onPending?.(pending, session, gate);
    }
    return { block: true, reason: note + refusal.reason };
  });
  const reset = (ctx: UiContext) => { gate.clear(); alerted.clear(); advised.clear(); if (grant) display.hide(ctx); };
  pi.on('session_start', (_event, ctx) => reset(ctx));
  pi.on('session_shutdown', (_event, ctx) => reset(ctx));
  return gate;
}
