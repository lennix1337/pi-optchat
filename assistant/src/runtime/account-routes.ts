import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strings as stringList } from '../contracts/validation.ts';

/**
 * Picks the account the draft executor tries next, following pi-multi-account's own files under the
 * Pi agent directory (read-only): its provider priority, pins and error patterns, its shared
 * cooldowns, and each account's saved default model. The executor never writes those files; its own
 * failures cool a route in memory only.
 */
export type Route = { provider: string; model: string };
export type RouteFailure = 'limit' | 'auth' | 'model' | 'transient';
type Json = Record<string, unknown>;

const HOUR = 3_600_000;
const DEFAULT_PATTERNS: Record<RouteFailure | 'ignore', string[]> = {
  ignore: ['context window', 'context length', 'too many tokens', 'input is too long'],
  auth: ['401', 'unauthorized', 'authentication', 'invalid api key', 'invalid token', 'token expired', 'no api key', 'credit balance is too low'],
  limit: ['429', 'rate limit', 'rate_limit', 'usage limit', 'quota', 'insufficient_quota', 'too many requests', 'payment required'],
  model: ['model_not_found', 'model not found', 'unknown model', 'model unavailable', 'does not have access to model'],
  transient: ['500', '502', '503', '504', '529', 'overloaded', 'unavailable', 'timeout', 'timed out', 'econnreset', 'econnrefused', 'fetch failed', 'network error'],
};
const PATTERN_KEYS: Record<RouteFailure | 'ignore', string> = {
  ignore: 'ignoreErrorPatterns', auth: 'authErrorPatterns', limit: 'limitErrorPatterns', model: 'modelErrorPatterns', transient: 'transientErrorPatterns',
};

function readJson(path: string): Json {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
  } catch { return {}; }
}
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
/** A well-formed list of distinct nonempty strings, or none: a malformed rotation setting is ignored, not partly applied. */
const strings = (value: unknown): string[] => stringList(value) ? value as string[] : [];
/** A positive number at `map[key]` (a cooldown end or duration), else 0. */
const positiveAt = (map: unknown, key: string): number => { const value = record(map)[key]; return typeof value === 'number' && value > 0 ? value : 0; };

/** `anthropic-account-2` and `anthropic` belong to the same account group. */
export function accountGroup(provider: string): string { return provider.replace(/-account-\d+$/, ''); }
const accountNumber = (provider: string): number => Number(/-account-(\d+)$/.exec(provider)?.[1] ?? 1);

export class AccountRoutes {
  private readonly agentDir: string;
  private readonly fixed: Route | undefined;
  private readonly now: () => number;
  private readonly cooled = new Map<string, number>();
  constructor(agentDir: string, fixed?: Route, now: () => number = Date.now) {
    this.agentDir = agentDir; this.fixed = fixed; this.now = now;
  }
  private files() {
    return { failover: readJson(join(this.agentDir, 'provider-failover.json')), state: readJson(join(this.agentDir, 'provider-failover-state.json')),
      settings: readJson(join(this.agentDir, 'settings.json')) };
  }
  /** An account's saved default: its pin, else Pi's saved default for that group, else the rotation's last choice, else its live catalog's first model. */
  private defaultModel(provider: string, files: ReturnType<AccountRoutes['files']>): string | undefined {
    const group = accountGroup(provider);
    const pin = record(files.failover.pinnedModels)[group];
    if (typeof pin === 'string' && pin) return pin;
    const { defaultProvider, defaultModel } = files.settings;
    if (typeof defaultProvider === 'string' && typeof defaultModel === 'string' && accountGroup(defaultProvider) === group) return defaultModel;
    const switches = (Array.isArray(files.state.lastSwitches) ? files.state.lastSwitches : []).map(record)
      .filter(entry => typeof entry.to === 'string').sort((a, b) => Number(b.at ?? 0) - Number(a.at ?? 0));
    for (const entry of switches) {
      const [to, ...rest] = (entry.to as string).split('/');
      if (accountGroup(to) === group && rest.length) return rest.join('/');
    }
    const catalog = record(record(files.state.codexModelCatalogByProvider)[provider]).models;
    const first = (Array.isArray(catalog) ? catalog.map(record) : []).sort((a, b) => Number(a.priority ?? 0) - Number(b.priority ?? 0))[0]?.id;
    return typeof first === 'string' ? first : undefined;
  }
  private cooling(route: Route, state: Json): boolean {
    const now = this.now(), key = `${route.provider}/${route.model}`;
    return positiveAt(state.exhaustedUntilByProvider, route.provider) > now || positiveAt(state.invalidatedByProvider, route.provider) > now ||
      positiveAt(state.exhaustedUntilByModel, key) > now || (this.cooled.get(key) ?? 0) > now;
  }
  /** Ordered usable routes among the authenticated `available` models: Pi's default account first, then the rotation's priority. */
  candidates(available: Route[]): Route[] {
    const files = this.files();
    const offered = new Set(available.map(route => `${route.provider}/${route.model}`));
    const has = (route: Route) => offered.has(`${route.provider}/${route.model}`);
    if (this.fixed) return has(this.fixed) && !this.cooling(this.fixed, files.state) ? [this.fixed] : [];
    const priority = strings(files.failover.providerPriority);
    const others = files.failover.includeOtherProviders !== false;
    const primary = typeof files.settings.defaultProvider === 'string' ? files.settings.defaultProvider : '';
    const rank = (provider: string) => provider === primary ? -1 : priority.includes(accountGroup(provider)) ? priority.indexOf(accountGroup(provider)) : others ? priority.length : Infinity;
    const routes: Route[] = [];
    for (const provider of new Set(available.map(item => item.provider))) {
      if (rank(provider) === Infinity) continue;
      const model = this.defaultModel(provider, files);
      if (model && has({ provider, model })) routes.push({ provider, model });
    }
    return routes.sort((a, b) => rank(a.provider) - rank(b.provider) || accountNumber(a.provider) - accountNumber(b.provider) || a.provider.localeCompare(b.provider))
      .filter(route => !this.cooling(route, files.state));
  }
  /** A route failure the rotation would fail over on, or null for errors that are not the account's fault. */
  classify(message: string): RouteFailure | null {
    const failover = this.files().failover;
    const text = message.toLowerCase();
    const matches = (kind: RouteFailure | 'ignore') => {
      const configured = strings(failover[PATTERN_KEYS[kind]]);
      return (configured.length ? configured : DEFAULT_PATTERNS[kind]).some(pattern => text.includes(pattern.toLowerCase()));
    };
    if (matches('ignore')) return null;
    return (['auth', 'limit', 'model', 'transient'] as const).find(matches) ?? null;
  }
  /** Cools this route in memory with the rotation's cooldown for that failure kind. */
  record(route: Route, failure: RouteFailure): void {
    const failover = this.files().failover;
    const ms = failure === 'transient' ? positiveAt(failover, 'transientCooldownMs') || 60_000 : positiveAt(failover, 'cooldownMs') || 6 * HOUR;
    this.cooled.set(`${route.provider}/${route.model}`, this.now() + ms);
  }
}
