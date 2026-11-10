import type { ModelChoice } from './compactor.ts';
import { brasiliaDayTime } from './pc-health.ts';
import { routeBlock } from './quota-health.ts';

/** What a wake may run on right now. A `choice` is the first route that is not out of quota; with none, `until` is when the
 * earliest blocked route comes back. Neither: nothing is known about any route, so the wake goes ahead as before. */
export interface RouteDecision { choice?: ModelChoice; until?: number; why?: string }

/**
 * The first of `routes` (best first) whose provider is neither out of quota in the cached state nor blocked by a recent failed
 * wake (`blocks`, provider -> until). Routes the registry does not publish are skipped. Reads only; it never calls a model.
 */
export function pickWakeRoute(routes: ModelChoice[], state: unknown, blocks: Readonly<Record<string, number>>, now: number,
  published: (choice: ModelChoice) => boolean = () => true): RouteDecision | undefined {
  const blocked: { choice: ModelChoice; until: number }[] = [];
  for (const choice of routes) {
    if (!published(choice)) continue;
    const ends = [routeBlock(state, choice.provider, choice.model, now), blocks[choice.provider]].filter((at): at is number => at !== undefined && at > now);
    if (!ends.length) return { choice };
    blocked.push({ choice, until: Math.max(...ends) });
  }
  if (!blocked.length) return undefined;
  const until = Math.min(...blocked.map(route => route.until));
  return { until, why: blocked.map(route => `${route.choice.provider}/${route.choice.model} até ${brasiliaDayTime(route.until)}`).join('; ') };
}

/** Every provider id the cached quota file or the failed-wake blocks mention: the accounts a wake could be routed across. */
export function knownProviders(state: unknown, blocks: Readonly<Record<string, number>> = {}): string[] {
  const data = state !== null && typeof state === 'object' ? state as Record<string, unknown> : {};
  const keys = (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [];
  return [...new Set([...keys(data.usageByProvider), ...keys(data.exhaustedUntilByProvider), ...Object.keys(blocks)])];
}
