import { hash } from 'node:crypto';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { AssistantPolicy, AssistantReview } from './assistant-policy.ts';

/** Largest content a terminal reviewer can read whole; anything bigger can only be denied here. */
const MAX_REVIEW_CHARS = 4000;
const escape = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const field = (value: string) => escape(JSON.stringify(value));

/** The whole content as escaped text, or undefined when it cannot be shown entirely (binary, malformed or too long). */
function readable(bytes: Uint8Array): string | undefined {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return undefined; }
  const shown = escape(text);
  return shown.length <= MAX_REVIEW_CHARS ? shown : undefined;
}

function describe(r: AssistantReview, withContent: boolean) {
  const m = r.metadata, content = readable(r.payload);
  return [
    `Review ${r.reviewId}`,
    `${field(m.adapter)} ${field(m.action)} · account ${field(m.account)} → destination ${field(m.destination)}`,
    `task ${field(m.taskId)} · run ${field(m.runId)} · policy ${field(m.policyVersion)} · expires ${new Date(m.expiresAt).toISOString()}`,
    `content: ${r.payload.byteLength} bytes, sha256 ${hash('sha256', r.payload).slice(0, 16)}…${r.reasons.length ? ` · flagged: ${r.reasons.join(', ')}` : ''}`,
    ...withContent ? [content === undefined ? '(content cannot be shown whole in the terminal; it can only be denied here)' : `---\n${content}\n---`] : [],
  ].join('\n');
}

/**
 * The operator's review of assistant effects. Only a command typed in the interactive terminal reaches the host
 * authority; models, RPC clients, the HTTP API and task or message content have no path to it.
 */
export function registerAssistantReview(pi: ExtensionAPI, source: () => AssistantPolicy | undefined, authority: object) {
  pi.registerCommand('assistant-review', { description: 'Review exact assistant effects awaiting approval: list | approve <id> | deny <id>', handler: async (args: string, ctx: ExtensionCommandContext) => {
    const [action = 'list', id, ...extra] = args.trim().split(/\s+/).filter(Boolean);
    const policy = source();
    if (!policy) { ctx.ui.notify('No assistant effect policy is active in this session.', 'info'); return; }
    if (extra.length || (action === 'list' ? id !== undefined : action !== 'approve' && action !== 'deny' || !id)) {
      ctx.ui.notify('Usage: /assistant-review [list|approve <reviewId>|deny <reviewId>]', 'error'); return;
    }
    if (action === 'list') {
      const pending = policy.reviews();
      ctx.ui.notify(pending.length ? pending.map(r => describe(r, true)).join('\n\n') : 'No assistant effects await review.', 'info'); return;
    }
    if (ctx.mode !== 'tui' || !ctx.hasUI) { ctx.ui.notify('Assistant reviews are decided only in the interactive terminal.', 'error'); return; }
    const review = policy.reviews().find(r => r.reviewId === id);
    if (!review) { ctx.ui.notify('No such pending review (expired, decided, or lost on reload: the producer must prepare it again).', 'warning'); return; }
    try {
      if (action === 'deny') { policy.decide(review.reviewId, 'deny', authority); ctx.ui.notify(`Denied ${review.reviewId}.`, 'info'); return; }
      if (readable(review.payload) === undefined) { ctx.ui.notify('Not approved: the content cannot be shown whole here. Deny it or review it in a dedicated viewer.', 'warning'); return; }
      const confirmed = await ctx.ui.confirm('Approve this exact effect once?', describe(review, true));
      if (!confirmed) { ctx.ui.notify('Not approved.', 'info'); return; }
      policy.decide(review.reviewId, 'approve', authority);
      ctx.ui.notify(`Approved once: ${review.reviewId}. Only this content, account and destination may dispatch.`, 'info');
    } catch {
      ctx.ui.notify('Review decision refused (expired, already decided or unavailable); nothing was approved.', 'warning');
    }
  } });
}
