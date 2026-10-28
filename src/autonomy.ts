import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { record } from './cache.ts';
import { ACTIONS, classifyEffects as classify, type Action, type Effect, type Repo } from './effect-classifier.ts';

export { ACTIONS, productionWriteHost, segments, normalPath, type Action, type Effect, type Repo } from './effect-classifier.ts';

/**
 * The operator's autonomy contract (`autonomy.json` in the profile folder): which high-impact effects the agent may run
 * on its own, which it runs and reports, and which always wait for the operator. Decided from the call itself, never
 * from the conversation, so a misread "sim" cannot widen it.
 */
export const LEVELS = ['free', 'report', 'ask'] as const;
export type Level = typeof LEVELS[number];
export interface Rule { action: Action | '*'; scope: string[]; level: Level; until?: string; note?: string }
export interface Contract { version: 1; default: Level | 'advisor'; rules: Rule[] }
export interface Decision { level: Level | 'advisor'; effect?: Effect; rule?: Rule }

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => list.some(item => item === value);

/** A validated contract, or an error naming the first problem. */
export function parseContract(value: unknown): Contract {
  if (!record(value) || value.version !== 1) throw new Error('autonomy.json must be { "version": 1, "default": ..., "rules": [...] }');
  const fallback = value.default ?? 'advisor';
  if (fallback !== 'advisor' && !oneOf(LEVELS, fallback)) throw new Error(`autonomy.json default must be advisor, ${LEVELS.join(', ')}`);
  if (!Array.isArray(value.rules)) throw new Error('autonomy.json rules must be a list');
  const rules = value.rules.map((rule: unknown, index): Rule => {
    const where = `autonomy.json rule ${index + 1}`;
    if (!record(rule)) throw new Error(`${where} must be an object`);
    if (rule.action !== '*' && !oneOf(ACTIONS, rule.action)) throw new Error(`${where}: action must be * or one of ${ACTIONS.join(', ')}`);
    if (!isStrings(rule.scope) || !rule.scope.length) throw new Error(`${where}: scope must be a non-empty list of patterns`);
    if (!oneOf(LEVELS, rule.level)) throw new Error(`${where}: level must be ${LEVELS.join(', ')}`);
    if (rule.until !== undefined && (typeof rule.until !== 'string' || Number.isNaN(Date.parse(rule.until)))) throw new Error(`${where}: until must be an ISO date`);
    if (rule.note !== undefined && typeof rule.note !== 'string') throw new Error(`${where}: note must be text`);
    return { action: rule.action, scope: rule.scope, level: rule.level, ...(rule.until ? { until: rule.until } : {}), ...(rule.note ? { note: rule.note } : {}) };
  });
  return { version: 1, default: fallback, rules };
}

const cache = new Map<string, { mtime: number; contract: Contract }>();
/** The profile's contract, re-read when the file changes; undefined when there is none. Throws on an invalid file. */
export function loadContract(dir: string): Contract | undefined {
  const file = join(dir, 'autonomy.json');
  if (!existsSync(file)) return undefined;
  const mtime = statSync(file).mtimeMs, hit = cache.get(file);
  if (hit?.mtime === mtime) return hit.contract;
  const contract = parseContract(JSON.parse(readFileSync(file, 'utf8')));
  cache.set(file, { mtime, contract });
  return contract;
}

const glob = (pattern: string) => new RegExp(`^${pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`);
const strictness: Record<Level, number> = { free: 0, report: 1, ask: 2 };

/** First live rule matching the effect wins; a `*` scope matches any target. */
export function decideEffect(contract: Contract, effect: Effect, now = Date.now()): Decision {
  const rule = contract.rules.find(r => (r.action === '*' || r.action === effect.action) && (!r.until || Date.parse(r.until) > now)
    && r.scope.some(pattern => pattern === '*' || effect.targets.some(target => glob(pattern).test(target))));
  return rule ? { level: rule.level, effect, rule } : { level: contract.default, effect };
}

/** The strictest decision over every effect of a call; `advisor` when nothing asks and an effect has no rule, or the call has no recognised effect. */
export function decide(contract: Contract, effects: Effect[], now = Date.now()): Decision {
  // The gate stopped the call for a reason the classifier cannot name: the contract has nothing to say about it.
  if (!effects.length) return { level: 'advisor' };
  const decisions = effects.map(effect => decideEffect(contract, effect, now));
  const asked = decisions.find(d => d.level === 'ask');
  if (asked) return asked;
  const open = decisions.find(d => d.level === 'advisor');
  if (open) return open;
  return decisions.reduce((worst, d) => strictness[d.level as Level] > strictness[worst.level as Level] ? d : worst);
}

/** A removed worktree or a file path still belongs to the checkout around it: use the nearest existing folder. */
const existing = (path: string) => { let p = path; while (!existsSync(p) && dirname(p) !== p) p = dirname(p); return p; };
const quiet = (path: string, args: string[]) => {
  path = existing(path);
  try { return execFileSync('git', ['-C', path, ...args], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; }
  catch { return undefined; }
};
export const slugOf = (url: string) => /github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(url)?.[1].toLowerCase();
/** Reads a checkout's GitHub slug and current branch with local git only (no network). */
export const gitRepo: Repo = {
  slug: (path, remote = 'origin') => { const url = quiet(path, ['remote', 'get-url', remote]); return url && slugOf(url); },
  branch: path => quiet(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
  script: path => {
    try { return statSync(path).size <= 512 * 1024 ? readFileSync(path, 'utf8') : undefined; } catch { return undefined; }
  },
};

/** Every high-impact effect of a call, read from its arguments alone (local git only resolves slugs and branches). */
export const classifyEffects = (call: { tool: string; input: unknown; cwd: string }, repo: Repo = gitRepo) => classify(call, repo);

/** One line per effect the agent ran under a `report` rule, for the operator's briefing. */
export function logReported(dir: string, entry: { at: number; action: Action; targets: string[]; summary: string; rule?: string }) {
  appendFileSync(join(dir, 'autonomy-log.jsonl'), `${JSON.stringify(entry)}\n`);
}

export const describeDecision = ({ level, effect, rule }: Decision) =>
  `${effect ? `${effect.action} on ${effect.targets.join(', ') || 'no target'}` : 'effect'}: ${level}${rule ? ` (rule ${rule.action} ${rule.scope.join(' ')}${rule.note ? `: ${rule.note}` : ''})` : ' (no matching rule)'}`;
