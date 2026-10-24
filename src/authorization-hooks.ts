import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { EffectApprovals } from './authorization.ts';

/** All grants are user-input provenance checked; no model-callable grant tool exists. */
export function registerEffectApprovals(pi: ExtensionAPI, { enabled = process.env.OPTCHAT_EFFECT_APPROVALS === '1', grant = true } = {}) {
  if (!enabled) return;
  const gate = new EffectApprovals();
  // Child SDK prompt/steer calls default to interactive even when manager-authored.
  if (grant) pi.on('input', (event, ctx) => {
    const result = gate.approve(ctx.sessionManager.getSessionId(), event.source, event.text);
    if (result === 'ignored') return;
    if (result === 'invalid') {
      ctx.ui.notify('Effect approval refused: token expired, already used or belongs to another session. No execution occurred.', 'warning');
      return { action: 'handled' };
    }
    ctx.ui.notify('Exact invocation approved once. Nested calls and retries still require their own approval.', 'info');
    // Keep the exact interactive token as input; do not manufacture a broader user request.
    return { action: 'continue' };
  });
  pi.on('tool_call', (event, ctx) => {
    const refusal = gate.admit({ session: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, tool: event.toolName, input: event.input });
    if (refusal) return { block: true, reason: grant ? refusal.reason : 'Not executed: delegated sessions cannot grant effect approvals. Ask the operator to perform this action in the owning interactive session; do not relay approval tokens through agents.' };
  });
  pi.on('session_start', () => { gate.clear(); });
  pi.on('session_shutdown', () => { gate.clear(); });
}
