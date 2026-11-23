import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { accountGroup } from './account.ts';
import type { ModelChoice } from './compactor.ts';
import { DEFAULT_ROUTES, repoRoot, type WorkerRoutes } from './crew.ts';
import { branchMerged, type Runner } from './merged-branch.ts';
import {
  isStagedRow,
  predictionId,
  readPredictions,
  readStaged,
  stagePrediction,
  stagedOnDay,
  transitionStaged,
  type Prediction,
  type StagedEntry,
} from './predictions.ts';
import { accounts, QUOTA_NEAR_PERCENT, routeBlock, staleReadings } from './quota-health.ts';
import { knownProviders } from './wake-route.ts';

/** Default daily cap for speculative shadow staging. */
export const SHADOW_MAX_PER_DAY = 1;
/** Maximum cached quota usage percent allowed for speculative shadow work; never looser than QUOTA_NEAR_PERCENT. */
export const SHADOW_QUOTA_MAX_USED = QUOTA_NEAR_PERCENT;

/** A local git repository eligible for speculative shadow execution. */
export interface RepoTarget { name: string; path: string }

/** Options for selecting and staging the next buildable nightly prediction. */
export interface StageShadowOptions {
  dir: string;
  now?: number;
  enabled?: boolean;
  maxPerDay?: number;
  maxUsedPercent?: number;
  repos: readonly RepoTarget[];
  routes: readonly ModelChoice[];
  quotaState: unknown;
  blocks?: Readonly<Record<string, number>>;
  published?: (choice: ModelChoice) => boolean;
  isBuildable?: (repo: RepoTarget) => boolean;
}

/** Result of a shadow staging attempt on an idle heartbeat wake. */
export interface StageShadowResult {
  staged?: StagedEntry;
  route?: ModelChoice;
  reason?: 'disabled' | 'daily-cap' | 'quota' | 'no-candidate';
}

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const localDate = (at: number) => new Date(at).toLocaleDateString('sv-SE');
const nextLocalDate = (at: number) => { const d = new Date(at); d.setDate(d.getDate() + 1); return localDate(d.getTime()); };
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normPath = (path: string) => resolve(path).replace(/\\/g, '/').toLowerCase();

function familyAccounts(group: string, providers: readonly string[]): string[] {
  return [...new Set(providers.filter(provider => accountGroup(provider) === group))]
    .sort((a, b) => (a === group ? -1 : b === group ? 1 : a.localeCompare(b, undefined, { numeric: true })));
}

/**
 * Picks the first worker route with verified spare quota from `src/quota-health.ts` readings.
 * Never drops below `QUOTA_NEAR_PERCENT`, skips blocked/stale/unknown/api-key providers.
 */
export function pickWorkerQuotaRoute(
  routes: readonly ModelChoice[],
  state: unknown,
  now: number,
  blocks: Readonly<Record<string, number>> = {},
  maxUsedPercent = SHADOW_QUOTA_MAX_USED,
  published: (choice: ModelChoice) => boolean = () => true,
): ModelChoice | undefined {
  const gate = Math.min(maxUsedPercent, QUOTA_NEAR_PERCENT);
  if (!Number.isFinite(gate) || gate <= 0) return undefined;
  const activeAccounts = new Map(accounts(state, now).map(account => [account.id, account]));
  const stale = new Set(staleReadings(state, now).map(entry => entry.id));
  const usageByProvider = record(record(state).usageByProvider);
  for (const choice of routes) {
    if (!published(choice)) continue;
    if ((blocks[choice.provider] ?? 0) > now) continue;
    if (routeBlock(state, choice.provider, choice.model, now) !== undefined) continue;
    if (stale.has(choice.provider)) continue;
    if (record(usageByProvider[choice.provider]).plan === 'api-key') continue;
    const account = activeAccounts.get(choice.provider);
    if (!account || account.blockedUntil !== undefined || account.used === undefined) continue;
    if (account.used < gate) return choice;
  }
  return undefined;
}

/** Ordered candidate worker routes for shadow staging, expanding configured code-worker families across known accounts. */
export function workerRoutesForShadow(
  config: { workerModels?: WorkerRoutes },
  main: { provider: string } | undefined,
  state: unknown,
  blocks: Readonly<Record<string, number>> = {},
): ModelChoice[] {
  const choices = config.workerModels?.code?.length ? config.workerModels.code : DEFAULT_ROUTES.code;
  const known = knownProviders(state, blocks);
  const mainGroup = main ? accountGroup(main.provider) : undefined;
  const ordered = [...choices].sort((a, b) => (accountGroup(a.provider) === mainGroup ? -1 : accountGroup(b.provider) === mainGroup ? 1 : 0));
  const expanded: ModelChoice[] = [];
  for (const choice of ordered) {
    const group = accountGroup(choice.provider);
    const providers = familyAccounts(group, [choice.provider, ...(main && accountGroup(main.provider) === group ? [main.provider] : []), ...known]);
    if (main && accountGroup(main.provider) === group) {
      const rest = providers.filter(p => p !== main.provider);
      providers.splice(0, providers.length, main.provider, ...rest);
    }
    for (const provider of providers) {
      if (!expanded.some(item => item.provider === provider && item.model === choice.model)) {
        expanded.push({ ...choice, provider });
      }
    }
  }
  return expanded;
}

/** Resolves configured local repo paths (or fallback checkout root) into unique RepoTarget records. */
export function configuredShadowRepos(paths: readonly string[] | undefined, fallbackCwd?: string): RepoTarget[] {
  const raw = paths?.length ? paths : (fallbackCwd ? [repoRoot(fallbackCwd)].filter((p): p is string => !!p) : []);
  const seen = new Set<string>();
  const targets: RepoTarget[] = [];
  for (const entry of raw) {
    const clean = entry.trim();
    if (!clean) continue;
    const key = normPath(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = basename(clean.replace(/[\\/]+$/, ''));
    if (name) targets.push({ name, path: clean });
  }
  return targets;
}

/** Matches a prediction to a buildable repository via its explicit `repo` field or repo name mentioned in text/evidence. */
export function resolvePredictionRepo(
  prediction: Pick<Prediction, 'text' | 'evidence' | 'repo'>,
  repos: readonly RepoTarget[],
  isBuildable: (repo: RepoTarget) => boolean = repo => existsSync(join(repo.path, '.git')),
): RepoTarget | undefined {
  if (prediction.repo?.trim()) {
    const wanted = prediction.repo.trim();
    const wantedLower = wanted.toLowerCase();
    const wantedPath = normPath(wanted);
    const matched = repos.find(r => r.name.toLowerCase() === wantedLower || normPath(r.path) === wantedPath);
    return matched && isBuildable(matched) ? matched : undefined;
  }
  const haystack = `${prediction.text} ${prediction.evidence ?? ''}`;
  const bySpecificity = [...repos].sort((a, b) => b.name.length - a.name.length);
  for (const repo of bySpecificity) {
    const pattern = new RegExp(`(?:^|[^\\w.-])${escapeRegex(repo.name)}(?=$|[^\\w.-])`, 'i');
    if (pattern.test(haystack) && isBuildable(repo)) return repo;
  }
  return undefined;
}

/** Deterministic safe local git branch name for a staged shadow prediction. */
export function shadowBranchName(day: string, text: string): string {
  const slug = text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36).replace(/-+$/, '') || 'task';
  const suffix = predictionId(day, text).slice(-6);
  return `shadow/${slug}-${suffix}`;
}

/** Concise local-only speculative worker brief derived from a nightly prediction. */
export function shadowBrief(prediction: Pick<Prediction, 'day' | 'text' | 'evidence'>, repo: RepoTarget, branch: string): string {
  const context = prediction.evidence ? ` Context: ${prediction.evidence}.` : '';
  return `Speculative shadow draft for predicted request (${prediction.day}): ${prediction.text}.${context} Work in ${repo.name} on local branch ${branch}, add tests and run checks, commit locally only; never push, open a PR, merge, deploy or spend.`;
}

/**
 * Selects and stages at most one buildable, unstaged nightly prediction when shadow execution is enabled,
 * below the daily cap, and a worker route clears the quota-health gate.
 */
export function stageNextPrediction(options: StageShadowOptions): StageShadowResult {
  if (options.enabled === false) return { reason: 'disabled' };
  const now = options.now ?? Date.now();
  const today = localDate(now);
  const tomorrow = nextLocalDate(now);
  const maxPerDay = options.maxPerDay ?? SHADOW_MAX_PER_DAY;
  if (maxPerDay <= 0 || stagedOnDay(options.dir, today).length >= maxPerDay) return { reason: 'daily-cap' };

  const route = pickWorkerQuotaRoute(options.routes, options.quotaState, now, options.blocks, options.maxUsedPercent, options.published);
  if (!route) return { reason: 'quota' };

  const rows = readPredictions(options.dir);
  const closedKeys = new Set<string>();
  const predicted: Prediction[] = [];
  for (const row of rows) {
    const k = JSON.stringify([row.day, row.text]);
    if (isStagedRow(row) || row.status !== 'predicted') {
      closedKeys.add(k);
    } else {
      predicted.push(row);
    }
  }
  const eligible = predicted
    .filter(p => (p.day === today || p.day === tomorrow) && !closedKeys.has(JSON.stringify([p.day, p.text])))
    .sort((a, b) => a.day.localeCompare(b.day) || a.at - b.at);

  for (const candidate of eligible) {
    const repo = resolvePredictionRepo(candidate, options.repos, options.isBuildable);
    if (!repo) continue;
    const branch = shadowBranchName(candidate.day, candidate.text);
    const brief = shadowBrief(candidate, repo, branch);
    const staged = stagePrediction(options.dir, {
      day: candidate.day,
      text: candidate.text,
      repo: repo.name,
      repoPath: repo.path,
      branch,
      brief,
    }, now);
    return { staged, route };
  }
  return { reason: 'no-candidate' };
}

/** Wake-prompt instructions telling the agent to launch a worker on a local branch for a staged prediction. */
export function shadowWakeNote(staged: StagedEntry, route?: ModelChoice): string {
  const location = staged.repoPath ? `${staged.repo} (${staged.repoPath})` : staged.repo;
  const routeLine = route ? ` Available worker route: ${route.provider}/${route.model}.` : '';
  return [
    `Speculative shadow task staged (${staged.id}): "${staged.text}" in ${location} on local branch \`${staged.branch}\`.${routeLine}`,
    `Launch a worker via \`spawn\` (kind \`code\`, cwd \`${staged.repoPath ?? staged.repo}\`) to implement it on local branch \`${staged.branch}\` in an isolated worktree.`,
    `Brief: ${staged.brief}`,
    'Authority for speculative shadow work: commit locally on the local branch only; do not push, open a PR, merge, deploy, or spend.',
  ].join('\n');
}

/** Checks active staged entries against git merge state (`branchMerged`) and marks merged branches as accepted. */
export async function reconcileAcceptedShadow(
  dir: string,
  options: { now?: number; repos?: readonly RepoTarget[]; isMerged?: (repoPath: string, branch: string) => Promise<boolean>; runner?: Runner } = {},
): Promise<StagedEntry[]> {
  const active = readStaged(dir, { status: 'staged' });
  if (!active.length) return [];
  const now = options.now ?? Date.now();
  const repoByName = new Map((options.repos ?? []).map(r => [r.name.toLowerCase(), r.path]));
  const isMerged = options.isMerged ?? ((repoPath: string, branch: string) => branchMerged(repoPath, branch, options.runner));
  const accepted: StagedEntry[] = [];
  for (const entry of active) {
    const path = entry.repoPath ?? repoByName.get(entry.repo.toLowerCase()) ?? entry.repo;
    if (!path) continue;
    if (await isMerged(path, entry.branch)) {
      accepted.push(transitionStaged(dir, entry.id, 'accepted', `branch ${entry.branch} merged`, now));
    }
  }
  return accepted;
}

/** Marks any active staged entry matching `branch` as accepted after a direct merge. */
export function acceptStagedBranch(dir: string, branch: string, evidence?: string, now = Date.now()): StagedEntry[] {
  return readStaged(dir, { status: 'staged' })
    .filter(entry => entry.branch === branch)
    .map(entry => transitionStaged(dir, entry.id, 'accepted', evidence ?? `branch ${branch} merged`, now));
}
