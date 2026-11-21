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

/** Optional local LLM pre-triage endpoint (Ollama or llama.cpp OpenAI-compatible). Off by default; fails open to `react`. */
export interface LocalTriageConfig {
  enabled?: boolean;
  kind?: 'ollama' | 'openai';
  url?: string;
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_LOCAL_TIMEOUT_MS = 5_000;
const LOCAL_TRIAGE_PROMPT = `Decide whether this heartbeat snapshot needs a cloud model wake (REACT) or is purely idle/noise with nothing actionable (DROP).
Answer with one line: DROP: <short reason> or REACT: <short reason>.`;

/** Why a config.json `localTriage` entry can't be used, or undefined if it can. */
export function invalidLocalTriage(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const cfg = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!cfg) return 'localTriage must be an object.';
  if (cfg.enabled !== undefined && typeof cfg.enabled !== 'boolean') return 'localTriage.enabled must be a boolean.';
  if (cfg.kind !== undefined && cfg.kind !== 'ollama' && cfg.kind !== 'openai') return 'localTriage.kind must be "ollama" or "openai".';
  if (cfg.url !== undefined && (typeof cfg.url !== 'string' || !/^https?:\/\//i.test(cfg.url))) return 'localTriage.url must be an http(s) URL.';
  if (cfg.model !== undefined && (typeof cfg.model !== 'string' || !cfg.model.trim())) return 'localTriage.model must be a non-empty string.';
  if (cfg.timeoutMs !== undefined && (typeof cfg.timeoutMs !== 'number' || !Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs <= 0)) {
    return 'localTriage.timeoutMs must be a positive number.';
  }
  if (cfg.enabled === true && (!cfg.url || !cfg.model)) return 'localTriage requires url and model when enabled is true.';
  return undefined;
}

/** Leniently parses a local model's `drop | react` reply; returns undefined when ambiguous so the caller fails open. */
export function parseLocalTriageVerdict(text: string): { decision: 'drop' | 'react'; reason: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const jsonStart = trimmed.indexOf('{'), jsonEnd = trimmed.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    try {
      const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
      const raw = typeof parsed.decision === 'string' ? parsed.decision : typeof parsed.action === 'string' ? parsed.action : '';
      const word = raw.trim().toLowerCase();
      if (word === 'drop' || word === 'react') {
        const reason = typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : `local model (${word})`;
        return { decision: word, reason };
      }
    } catch {   }
  }
  const match = /^\s*\**\s*(DROP|REACT)\b\**\s*[:\-–—]?\s*(.*)$/im.exec(trimmed);
  if (!match) return undefined;
  const decision = match[1]!.toLowerCase() as 'drop' | 'react';
  const reason = match[2]?.trim() || `local model (${decision})`;
  return { decision, reason };
}

/** Queries an optional local Ollama/llama.cpp endpoint for `drop | react`. Always fails open (`react`) when disabled or unavailable. */
export async function queryLocalTriage(
  config: LocalTriageConfig | undefined,
  snapshot: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ decision: 'drop' | 'react'; reason: string }> {
  if (!config?.enabled) return { decision: 'react', reason: 'local triage disabled' };
  if (!config.url || !config.model) return { decision: 'react', reason: 'local triage unconfigured (fail-open)' };
  const kind = config.kind ?? (/\/v1\/chat\/completions\b/i.test(config.url) ? 'openai' : 'ollama');
  const body = kind === 'openai'
    ? { model: config.model, messages: [{ role: 'system', content: LOCAL_TRIAGE_PROMPT }, { role: 'user', content: snapshot }], temperature: 0, max_tokens: 48, stream: false }
    : { model: config.model, prompt: `${LOCAL_TRIAGE_PROMPT}\n\n${snapshot}`, stream: false, options: { temperature: 0, num_predict: 48 } };
  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS),
    });
    if (!response.ok) return { decision: 'react', reason: `local triage HTTP ${response.status} (fail-open)` };
    const data = await response.json() as { response?: unknown; message?: { content?: unknown }; content?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
    const text = typeof data.response === 'string' ? data.response
      : typeof data.message?.content === 'string' ? data.message.content
      : typeof data.content === 'string' ? data.content
      : typeof data.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content
      : '';
    return parseLocalTriageVerdict(text) ?? { decision: 'react', reason: 'local triage uncertain (fail-open)' };
  } catch {
    return { decision: 'react', reason: 'local triage unavailable (fail-open)' };
  }
}
