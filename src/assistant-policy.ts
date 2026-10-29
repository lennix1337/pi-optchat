import { hash } from 'node:crypto';
import { createGateway, type EffectMetadata, type EffectRequest } from '../assistant/src/policy/gateway.ts';
import { inspectEgress } from '../assistant/src/policy/egress.ts';
import { logReported, type Effect } from './autonomy.ts';
import { readProfileEffectPolicy } from './effect-policy.ts';

/** Registered by trusted host code, never populated from task/email/HTTP metadata. */
export interface AssistantEffectAdapter {
  accepts(metadata: Readonly<EffectMetadata>): boolean;
  classify(metadata: Readonly<EffectMetadata>): 'read' | 'review' | Effect[];
  invoke(bytes: Uint8Array, metadata: Readonly<EffectMetadata>): unknown | Promise<unknown>;
}
export interface AssistantPolicyOptions {
  databasePath: string;
  profileId: string;
  operatorAuthority: object;
  contractDir: () => string | undefined;
  /** Owned by the host policy loader; must change whenever effective policy or adapter grants change. */
  policyVersion: () => string;
  knownSecrets: () => readonly string[];
  adapters: Readonly<Record<string, AssistantEffectAdapter>>;
  now?: () => number;
}

export interface AssistantReview { reviewId: string; metadata: Readonly<EffectMetadata>; payload: Uint8Array; reasons: readonly string[] }
const MAX_REVIEWS = 32;
export type AssistantPolicy = ReturnType<typeof createAssistantPolicy>;

/** Explicit host-only factory. No service activation, model tool, bearer approval endpoint or shell sandbox. */
export function createAssistantPolicy(options: AssistantPolicyOptions) {
  const { contractDir, policyVersion, knownSecrets } = options;
  const adapters = new Map(Object.entries(options.adapters).map(([name, adapter]) => [name, Object.freeze({
    accepts: adapter.accepts.bind(adapter), classify: adapter.classify.bind(adapter), invoke: adapter.invoke.bind(adapter),
  })]));
  const gateway = createGateway({
    databasePath: options.databasePath, profileId: options.profileId, operatorAuthority: options.operatorAuthority, now: options.now,
    inspect: bytes => inspectEgress(bytes, knownSecrets()),
    policy: metadata => {
      const adapter = adapters.get(metadata.adapter);
      if (!adapter || !adapter.accepts(metadata) || metadata.policyVersion !== policyVersion()) return 'deny';
      const effects = adapter.classify(metadata);
      if (effects === 'read') return 'allow';
      if (effects === 'review') return 'review';
      const decision = readProfileEffectPolicy(contractDir(), () => effects);
      return decision?.level === 'free' || decision?.level === 'report' ? 'allow' : 'review';
    },
  });
  // Exact bytes awaiting a human live only in this process: a reload drops them and the producer must prepare again.
  const reviews = new Map<string, AssistantReview>();
  const live = () => { const now = (options.now ?? Date.now)(); for (const [id, r] of reviews) if (r.metadata.expiresAt <= now) reviews.delete(id); return reviews; };
  return {
    prepare(request: EffectRequest) {
      const result = gateway.prepare(request);
      if (result.decision === 'review') {
        const pending = live();
        if (pending.size >= MAX_REVIEWS) pending.delete(pending.keys().next().value!);
        pending.set(result.reviewId, Object.freeze({ reviewId: result.reviewId, metadata: result.metadata, payload: result.payload, reasons: inspectEgress(result.payload, knownSecrets()).reasons }));
      }
      return result.decision === 'review' ? { decision: result.decision, reviewId: result.reviewId } : result;
    },
    /** Pending exact reviews for display; holds no authority. */
    reviews: () => [...live().values()],
    decide(reviewId: string, decision: 'approve' | 'deny', authority: object, rule?: Parameters<typeof gateway.decide>[3]) {
      gateway.decide(reviewId, decision, authority, rule);
      reviews.delete(reviewId);
    },
    revoke: gateway.revoke.bind(gateway),
    status: gateway.status.bind(gateway),
    close: gateway.close.bind(gateway),
    dispatch: (request: EffectRequest) => gateway.dispatch(request, async (bytes, metadata) => {
      const adapter = adapters.get(metadata.adapter)!;
      const effects = adapter.classify(metadata), dir = contractDir();
      if (Array.isArray(effects)) {
        const decision = readProfileEffectPolicy(dir, () => effects);
        if (decision?.level === 'report' && dir && decision.effect) {
          logReported(dir, { at: Date.now(), action: decision.effect.action, targets: decision.effect.targets,
            summary: `Assistant dispatch ${hash('sha256', metadata.operationId)}`, rule: decision.rule?.note });
        }
      }
      return adapter.invoke(bytes, metadata);
    }),
  };
}
