import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIONS, IRREVERSIBLE, invalidateContractCache, loadContract, parseContract, type Action, type Contract, type Level, type Rule } from './autonomy.ts';
import { PROTECTED_ACTIONS } from './autonomy-self-edit.ts';
import { record } from './cache.ts';
import { atomicWrite, readJsonl, readJsonOr } from './store.ts';

/** Clean operator approvals in the lookback window required before proposing `ask -> report` (act+notify). */
export const DEFAULT_PROMOTION_THRESHOLD = 5;
/** Rolling lookback window in days for approvals and zero-override eligibility. */
export const DEFAULT_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;
const LOG_FILE = 'autonomy-log.jsonl';
const CONTRACT_FILE = 'autonomy.json';
const KNOWN_ACTIONS = new Set<string>(ACTIONS);
const PROTECTED_SET = new Set<string>([...PROTECTED_ACTIONS, ...IRREVERSIBLE]);
const LOWER_LEVEL: Record<Level, Level> = { free: 'report', report: 'ask', ask: 'ask' };

/** Optional profile configuration (`autonomyLadder` in config.json). */
export interface AutonomyLadderConfig {
  /** Clean operator approvals needed to emit a promotion proposal (default 5). */
  promotionThreshold?: number;
  /** Rolling lookback window in days (default 30). */
  windowDays?: number;
}

/** Why a config.json `autonomyLadder` entry cannot be used, or undefined when valid. */
export function invalidAutonomyLadder(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) return 'autonomyLadder must be { "promotionThreshold"?: integer >= 1, "windowDays"?: number > 0 }.';
  const { promotionThreshold, windowDays } = value;
  if (promotionThreshold !== undefined && (!Number.isSafeInteger(promotionThreshold) || Number(promotionThreshold) < 1)) {
    return 'autonomyLadder.promotionThreshold must be a positive integer.';
  }
  if (windowDays !== undefined && (typeof windowDays !== 'number' || !Number.isFinite(windowDays) || windowDays <= 0)) {
    return 'autonomyLadder.windowDays must be a positive number.';
  }
  return undefined;
}

/** True for protected classes (from autonomy-self-edit + irreversible effects) and any non-classifier key such as `*` or account/credential changes. */
export function isProtectedAction(action: string): boolean {
  return !KNOWN_ACTIONS.has(action) || PROTECTED_SET.has(action);
}

/** Recorded outcome in `autonomy-log.jsonl`; entries without `outcome` come from `logReported`. */
export type LadderOutcome = 'reported' | 'approved' | 'denied' | 'override' | 'demoted';

/** One line in `autonomy-log.jsonl`. */
export interface LadderLogEntry {
  at: number;
  action: string;
  targets: string[];
  summary: string;
  rule?: string;
  outcome?: LadderOutcome;
}

/** Per-action counts within the lookback window. */
export interface ActionCount {
  action: string;
  approvals: number;
  overrides: number;
  reported: number;
  lastApprovalAt?: number;
  lastOverrideAt?: number;
}

/** A read-only suggestion to loosen one unprotected action class from `ask` to `report` (act+notify); never applied automatically. */
export interface PromotionProposal {
  action: Action;
  from: 'ask';
  to: 'report';
  approvals: number;
  overrides: 0;
  windowDays: number;
  threshold: number;
  lastApprovalAt: number;
}

/** Result of automatically stepping an action class down in a contract. */
export interface DemotionResult {
  contract: Contract;
  changed: boolean;
  from?: Level;
  to?: Level;
}

/** Appends one operator approval, denial, override, or automatic demotion to `autonomy-log.jsonl`. */
export function logAutonomyOutcome(
  dir: string,
  entry: Omit<LadderLogEntry, 'outcome'> & { outcome: Exclude<LadderOutcome, 'reported'> },
): void {
  appendFileSync(join(dir, LOG_FILE), `${JSON.stringify(entry)}\n`);
}

/** Reads valid entries from `autonomy-log.jsonl`; missing files return empty and torn lines are skipped. */
export function readAutonomyLog(dir: string): LadderLogEntry[] {
  return readJsonl<LadderLogEntry>(
    join(dir, LOG_FILE),
    value => record(value) && typeof value.at === 'number' && Number.isFinite(value.at) && typeof value.action === 'string' && value.action.length > 0,
  );
}

/** Counts operator approvals vs overrides/denials per action class within `[now - windowDays, now]`. */
export function tallyAutonomyLog(
  entries: readonly LadderLogEntry[],
  { now = Date.now(), windowDays = DEFAULT_WINDOW_DAYS }: { now?: number; windowDays?: number } = {},
): Map<string, ActionCount> {
  const since = now - windowDays * DAY_MS;
  const counts = new Map<string, ActionCount>();
  for (const item of entries) {
    if (!Number.isFinite(item.at) || item.at < since || item.at > now || !item.action) continue;
    let bucket = counts.get(item.action);
    if (!bucket) {
      bucket = { action: item.action, approvals: 0, overrides: 0, reported: 0 };
      counts.set(item.action, bucket);
    }
    if (item.outcome === 'approved') {
      bucket.approvals++;
      bucket.lastApprovalAt = bucket.lastApprovalAt === undefined ? item.at : Math.max(bucket.lastApprovalAt, item.at);
    } else if (item.outcome === 'denied' || item.outcome === 'override') {
      bucket.overrides++;
      bucket.lastOverrideAt = bucket.lastOverrideAt === undefined ? item.at : Math.max(bucket.lastOverrideAt, item.at);
    } else if (item.outcome === undefined || item.outcome === 'reported') {
      bucket.reported++;
    }
  }
  return counts;
}

function isLiveRule(rule: Rule, now: number): boolean {
  return !rule.until || Date.parse(rule.until) > now;
}

function fallbackLevel(contract: Contract, action: Action, now: number): Level {
  const wildcard = contract.rules.find(rule => isLiveRule(rule, now) && rule.action === '*' && rule.scope.includes('*'));
  if (wildcard) return wildcard.level;
  return IRREVERSIBLE.includes(action) ? 'ask' : contract.default;
}

function actionAsksInContract(contract: Contract, action: Action, now: number): boolean {
  for (const rule of contract.rules) {
    if (!isLiveRule(rule, now)) continue;
    if (rule.action === action && rule.level === 'ask') return true;
    if ((rule.action === action || rule.action === '*') && rule.scope.includes('*')) return rule.level === 'ask';
  }
  return contract.default === 'ask' || IRREVERSIBLE.includes(action);
}

/** Emits promotion proposals (`ask -> report`) for unprotected actions reaching `threshold` clean approvals with zero overrides in `windowDays`. */
export function promotionProposals(
  entries: readonly LadderLogEntry[],
  {
    contract,
    now = Date.now(),
    threshold = DEFAULT_PROMOTION_THRESHOLD,
    windowDays = DEFAULT_WINDOW_DAYS,
  }: { contract?: Contract; now?: number; threshold?: number; windowDays?: number } = {},
): PromotionProposal[] {
  const tally = tallyAutonomyLog(entries, { now, windowDays });
  const out: PromotionProposal[] = [];
  for (const [action, stats] of tally) {
    if (isProtectedAction(action)) continue;
    if (stats.overrides > 0 || stats.approvals < threshold || stats.lastApprovalAt === undefined) continue;
    const known = action as Action;
    if (contract && !actionAsksInContract(contract, known, now)) continue;
    out.push({
      action: known,
      from: 'ask',
      to: 'report',
      approvals: stats.approvals,
      overrides: 0,
      windowDays,
      threshold,
      lastApprovalAt: stats.lastApprovalAt,
    });
  }
  return out.sort((a, b) => a.action.localeCompare(b.action));
}

/** Human-readable proposal line for wake, retro, and briefing reports. */
export function formatProposalLine(proposal: PromotionProposal): string {
  return `PROMOTION PROPOSAL: ${proposal.action} (ask -> act+notify / report) — ${proposal.approvals} clean approvals, 0 overrides in ${proposal.windowDays}d (requires operator approval)`;
}

function profileLadderConfig(dir: string, override?: AutonomyLadderConfig): AutonomyLadderConfig | undefined {
  if (override !== undefined) return override;
  const raw = readJsonOr<{ autonomyLadder?: unknown }>(join(dir, 'config.json'), {}).autonomyLadder;
  return raw !== undefined && invalidAutonomyLadder(raw) === undefined ? raw as AutonomyLadderConfig : undefined;
}

/** Reads pending promotion proposals for a profile directory; fails closed (`[]`) when `autonomy.json` is unreadable. */
export function readPromotionProposals(
  dir: string,
  { now = Date.now(), config }: { now?: number; config?: AutonomyLadderConfig } = {},
): PromotionProposal[] {
  let contract: Contract;
  try { contract = loadContract(dir) ?? { version: 1, default: 'report', rules: [] }; }
  catch { return []; }
  const cfg = profileLadderConfig(dir, config);
  return promotionProposals(readAutonomyLog(dir), {
    contract,
    now,
    threshold: cfg?.promotionThreshold ?? DEFAULT_PROMOTION_THRESHOLD,
    windowDays: cfg?.windowDays ?? DEFAULT_WINDOW_DAYS,
  });
}

/** Formatted promotion proposal lines for a profile directory; empty when none qualify. */
export function ladderProposalLines(dir: string, now = Date.now(), config?: AutonomyLadderConfig): string[] {
  return readPromotionProposals(dir, { now, config }).map(formatProposalLine);
}

/**
 * Pure automatic demotion for one action class: steps every live non-`ask` rule for `action` down one rung
 * (`free -> report`, `report -> ask`), and adds a catch-all rule before any `*` rule when the unruled fallback is not `ask`.
 */
export function demoteContract(
  contract: Contract,
  action: Action,
  now = Date.now(),
  reason = 'auto-demoted on operator override/denial',
): DemotionResult {
  let changed = false;
  let from: Level | undefined;
  let to: Level | undefined;
  let hasLiveCatchAll = false;
  const rules: Rule[] = contract.rules.map(rule => {
    if (rule.action !== action || !isLiveRule(rule, now)) return rule;
    if (rule.scope.includes('*')) hasLiveCatchAll = true;
    const nextLevel = LOWER_LEVEL[rule.level];
    if (nextLevel === rule.level) return rule;
    changed = true;
    from ??= rule.level;
    to ??= nextLevel;
    return { ...rule, level: nextLevel, note: reason };
  });

  if (!hasLiveCatchAll) {
    const fallback = fallbackLevel(contract, action, now);
    const nextLevel = LOWER_LEVEL[fallback];
    if (nextLevel !== fallback) {
      changed = true;
      from ??= fallback;
      to ??= nextLevel;
      const inserted: Rule = { action, scope: ['*'], level: nextLevel, note: reason };
      const wildcardAt = rules.findIndex(rule => isLiveRule(rule, now) && rule.action === '*');
      if (wildcardAt >= 0) rules.splice(wildcardAt, 0, inserted);
      else rules.push(inserted);
    }
  }

  return { contract: changed ? { ...contract, rules } : contract, changed, ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

function readEditableContract(dir: string): { ok: true; contract: Contract } | { ok: false; error: string } {
  const file = join(dir, CONTRACT_FILE);
  if (!existsSync(file)) return { ok: true, contract: { version: 1, default: 'report', rules: [] } };
  try { return { ok: true, contract: parseContract(JSON.parse(readFileSync(file, 'utf8'))) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}

function writeContract(dir: string, contract: Contract): void {
  atomicWrite(join(dir, CONTRACT_FILE), `${JSON.stringify(contract, null, 2)}\n`);
  invalidateContractCache(dir);
}

/**
 * Logs an operator outcome (`approved`, `denied`, or `override`) to `autonomy-log.jsonl`.
 * Approvals never modify `autonomy.json`; any denial or override demotes that action class immediately.
 */
export function recordAutonomyOutcome(
  dir: string,
  entry: { at?: number; action: Action; targets: string[]; summary: string; outcome: 'approved' | 'denied' | 'override'; rule?: string },
): { demoted: boolean; from?: Level; to?: Level; error?: string } {
  const at = entry.at ?? Date.now();
  logAutonomyOutcome(dir, {
    at,
    action: entry.action,
    targets: entry.targets,
    summary: entry.summary,
    outcome: entry.outcome,
    ...(entry.rule ? { rule: entry.rule } : {}),
  });
  if (entry.outcome === 'approved') return { demoted: false };

  const loaded = readEditableContract(dir);
  if (!loaded.ok) return { demoted: false, error: loaded.error };
  const result = demoteContract(loaded.contract, entry.action, at, `auto-demoted on operator ${entry.outcome}`);
  if (!result.changed) return { demoted: false };
  writeContract(dir, result.contract);
  logAutonomyOutcome(dir, {
    at,
    action: entry.action,
    targets: entry.targets,
    summary: `auto-demoted ${entry.action}: ${result.from} -> ${result.to}`,
    outcome: 'demoted',
  });
  return { demoted: true, from: result.from, to: result.to };
}

/**
 * Applies a promotion (`ask -> report`) only when explicitly triggered by interactive operator approval.
 * Refuses non-interactive sources and protected action classes, leaving `autonomy.json` unchanged.
 */
export function applyPromotion(
  dir: string,
  action: Action,
  source: string,
  now = Date.now(),
): { applied: true; contract: Contract } | { applied: false; reason: string } {
  if (source !== 'interactive') return { applied: false, reason: 'promotion requires interactive operator approval' };
  if (isProtectedAction(action)) return { applied: false, reason: `${action} is a protected class and cannot be promoted by the ladder` };
  const loaded = readEditableContract(dir);
  if (!loaded.ok) return { applied: false, reason: `autonomy.json is unreadable: ${loaded.error}` };
  if (!actionAsksInContract(loaded.contract, action, now)) return { applied: false, reason: `${action} is not currently at ask` };

  let changed = false;
  let hasLiveCatchAll = false;
  const note = 'promoted ask -> report by operator approval';
  const rules: Rule[] = loaded.contract.rules.map(rule => {
    if (rule.action !== action || !isLiveRule(rule, now)) return rule;
    if (rule.scope.includes('*')) hasLiveCatchAll = true;
    if (rule.level !== 'ask') return rule;
    changed = true;
    return { ...rule, level: 'report', note };
  });

  if (!hasLiveCatchAll && fallbackLevel(loaded.contract, action, now) === 'ask') {
    changed = true;
    const inserted: Rule = { action, scope: ['*'], level: 'report', note };
    const wildcardAt = rules.findIndex(rule => isLiveRule(rule, now) && rule.action === '*');
    if (wildcardAt >= 0) rules.splice(wildcardAt, 0, inserted);
    else rules.push(inserted);
  }

  if (!changed) return { applied: false, reason: `${action} has no live ask rule to promote` };
  const next: Contract = { ...loaded.contract, rules };
  writeContract(dir, next);
  return { applied: true, contract: next };
}
