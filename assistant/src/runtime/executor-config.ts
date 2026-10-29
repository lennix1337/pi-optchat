import { isAbsolute } from 'node:path';
import { boundedText, strings } from '../contracts/validation.ts';

/**
 * `provider`+`model` pin one route; without them the executor rotates over every logged-in account's saved default.
 * `tools: true` is the operator's opt-in (default off) to isolated offline browser previews, each gated by a review
 * that only the local operator's `executor.mjs` can decide.
 */
export type ExecutorConfig = { agentDir: string; channels: string[]; provider?: string; model?: string; tools?: true };
const line = (max: number) => (value: unknown) => boundedText(max)(value) && !/[\x00-\x1f]/.test(value as string);
export function validExecutorConfig(value: unknown): value is ExecutorConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!Object.keys(v).every(key => ['agentDir', 'channels', 'provider', 'model', 'tools'].includes(key)) || ('provider' in v) !== ('model' in v) || ('tools' in v && v.tools !== true)) return false;
  if (!line(4096)(v.agentDir) || !isAbsolute(v.agentDir as string)) return false;
  if ('provider' in v && !(line(200)(v.provider) && line(200)(v.model))) return false;
  return strings(v.channels) && (v.channels as string[]).length > 0 && (v.channels as string[]).length <= 20 && (v.channels as string[]).every(line(80));
}
