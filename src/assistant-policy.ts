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
  return {
    prepare: gateway.prepare.bind(gateway),
    decide: gateway.decide.bind(gateway),
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
