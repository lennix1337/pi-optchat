import { decide, loadContract, type Decision, type Effect } from './autonomy.ts';

export type ProfileEffectDecision = Decision & { problem?: string };

/** Shared contract evaluation. Effects must be derived by the trusted native hook or adapter, never supplied as authority by content. */
export function readProfileEffectPolicy(dir: string | undefined, effects: () => Effect[]): ProfileEffectDecision | undefined {
  if (!dir) return undefined;
  try {
    const contract = loadContract(dir);
    return contract && decide(contract, effects());
  } catch {
    // Parser and filesystem errors can include private configuration bytes or paths.
    return { level: 'ask', problem: 'invalid or unavailable policy; inspect the active profile configuration privately' };
  }
}
