import type { RunInfo } from './runs.ts';

/** Persisted effective SDK values, not today's profile defaults or invented aliases. */
export function agentModel(run: Pick<RunInfo, 'model' | 'thinking'>) {
  const safe = (value: string) => value.replace(/[\x00-\x20\x7f-\x9f]/g, '');
  const model = safe(run.model.slice(run.model.indexOf('/') + 1)) || 'unknown';
  return `${model}(${safe(run.thinking) || 'unknown'})`;
}
