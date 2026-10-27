import type { ExtensionAPI, ExtensionContext, InputEventResult } from '@earendil-works/pi-coding-agent';
import { EffectApprovals, type ApprovalMode, type PendingApproval } from './authorization.ts';
import type { AdvisorRequest, AdvisorVerdict } from './effect-advisor.ts';

const WIDGET = 'optchat-approval';
type UiContext = Pick<ExtensionContext, 'sessionManager' | 'ui'>;
export type Advisor = (request: AdvisorRequest, ctx: ExtensionContext) => Promise<AdvisorVerdict>;

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

/** Gate admission where a refused call first goes to the advisor, once per pending call; `note` explains a refusal it did not lift. */
function advisedAdmission(gate: EffectApprovals, advisor: Advisor | undefined, grant: boolean) {
  // A delegated session never gets one: its calls wait for the operator in the owning session.
  const advise = grant && process.env.OPTCHAT_EFFECT_ADVISOR !== 'off' ? advisor : undefined;
  const notes = new Map<string, string>();
  const ask = async (pending: PendingApproval, call: { session: string; tool: string; input: unknown }, ctx: ExtensionContext) => {
    try {
      const verdict = await advise!({ kind: pending.kind, tool: call.tool, input: call.input, cwd: ctx.cwd, requests: recentRequests(ctx) }, ctx);
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
  };
  return {
    async admit(call: { session: string; cwd: string; tool: string; input: unknown }, ctx: ExtensionContext) {
      const refusal = gate.admit(call);
      const pending = refusal?.token && advise ? gate.pendingFor(call.session).find(p => p.token === refusal.token) : undefined;
      if (!pending || notes.has(pending.token)) return { refusal, note: (pending && notes.get(pending.token)) ?? '' };
      const note = await ask(pending, call, ctx);
      // Approved: admitting the same call again consumes the one-shot approval.
      if (note === undefined) return { refusal: gate.admit(call), note: '' };
      notes.set(pending.token, note);
      return { refusal, note };
    },
    clear: () => notes.clear(),
  };
}

/** All grants are user-input provenance checked; no model-callable grant tool exists. `OPTCHAT_EFFECT_APPROVALS=1` gates every effect, `=risk` only the high-impact classes. */
export function registerEffectApprovals(pi: ExtensionAPI, { enabled = undefined as boolean | undefined, grant = true, mode = undefined as ApprovalMode | undefined, bell = terminalBell, advisor = undefined as Advisor | undefined } = {}) {
  const env = process.env.OPTCHAT_EFFECT_APPROVALS;
  if (!(enabled ?? (env === '1' || env === 'risk'))) return;
  const gate = new EffectApprovals({ mode: mode ?? (env === 'risk' ? 'risk' : 'all') });
  const display = pendingDisplay(gate);
  const alerted = new Set<string>();
  const advised = advisedAdmission(gate, advisor, grant);
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
    }
    return { block: true, reason: note + refusal.reason };
  });
  const reset = (ctx: UiContext) => { gate.clear(); alerted.clear(); advised.clear(); if (grant) display.hide(ctx); };
  pi.on('session_start', (_event, ctx) => reset(ctx));
  pi.on('session_shutdown', (_event, ctx) => reset(ctx));
  return gate;
}
