import type { Signal, SignalKind } from '../contracts/signals.ts';

export type ReflexAction = 'notify' | 'resolve' | 'ignore';
export type ReflexRule = {
  ruleId: string;
  action: ReflexAction;
  reason: string;
  category: 'signal_attention' | 'signal_cleared' | null;
  cooldownMs: number;
};

/** Kinds that close an open issue for the same subject. A recovery without an open issue is only recorded. */
const RECOVERY: ReadonlySet<SignalKind> = new Set([
  'ci.passed', 'pr.merged', 'shell.succeeded', 'subagent.completed', 'quota.recovered',
  'health.recovered', 'pc.recovered', 'google.recovered', 'routine.succeeded',
]);
/** Kinds the operator must see. The notification carries fixed text; the journal keeps the subject. A subagent end is
 * recorded only: its report already reaches the main agent, so there is no model turn for the reflex path to replace. */
const ATTENTION: ReadonlySet<SignalKind> = new Set([
  'ci.failed', 'pr.conflict', 'shell.failed', 'quota.exhausted', 'quota.near',
  'health.down', 'pc.disk_low', 'pc.memory_low', 'pc.maintenance_stale', 'google.unavailable',
  'routine.failed', 'slack.unanswered',
]);
/** The least time between two attention notices for the same subject. Signals inside it are stored and counted. */
export const ATTENTION_COOLDOWN_MS = 30 * 60_000;

export type ReflexContext = { openIssue: boolean; lastAttentionAt: number | null; now: number };

/**
 * Deterministic triage. No model, no tool and no effect beyond a notification: the same signal and context always
 * yield the same rule. An ignored signal is still stored, so the weekly review sees what was not escalated.
 */
export function decideReflex(signal: Pick<Signal, 'kind' | 'severity'>, context: ReflexContext): ReflexRule {
  if (RECOVERY.has(signal.kind)) {
    return context.openIssue
      ? { ruleId: `recovery.${signal.kind}`, action: 'resolve', reason: 'open issue closed by its recovery signal', category: 'signal_cleared', cooldownMs: 0 }
      : { ruleId: `recovery.${signal.kind}`, action: 'ignore', reason: 'recovery without an open issue', category: null, cooldownMs: 0 };
  }
  if (!ATTENTION.has(signal.kind)) {
    return { ruleId: `record.${signal.kind}`, action: 'ignore', reason: 'recorded only; no operator attention required', category: null, cooldownMs: 0 };
  }
  if (context.lastAttentionAt !== null && context.now - context.lastAttentionAt < ATTENTION_COOLDOWN_MS) {
    return { ruleId: `attention.${signal.kind}`, action: 'ignore', reason: 'same subject notified inside the cooldown', category: null, cooldownMs: ATTENTION_COOLDOWN_MS };
  }
  return {
    ruleId: `attention.${signal.kind}`,
    action: 'notify',
    reason: signal.severity === 'critical' ? 'critical signal needs operator attention' : 'signal needs operator attention',
    category: 'signal_attention',
    cooldownMs: ATTENTION_COOLDOWN_MS,
  };
}
