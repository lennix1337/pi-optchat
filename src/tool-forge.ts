import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { commandWords, segments } from './effect-classifier.ts';
import { readExecLog, type ExecEntry } from './exec-log.ts';

/** Display default for the forged tool directory when no profile override is configured. */
export const DEFAULT_TOOL_DIR_DISPLAY = '~/.pi/agent/bin';
/** Rolling lookback window for detecting repeated bash shapes. */
export const FORGE_WINDOW_DAYS = 7;
/** Minimum repetitions inside the window to qualify as a forge candidate. */
export const FORGE_MIN_COUNT = 5;
/** Minimum distinct runs across which a shape must repeat. */
export const FORGE_MIN_RUNS = 2;
/** Number of top forge candidates included in the daily retro prompt. */
export const FORGE_TOP = 3;
/** Inactivity window after which a forged script is listed for pruning. */
export const FORGE_PRUNE_DAYS = 30;
/** Idle gap that separates inferred runs when exec-log entries omit `run`. */
export const FORGE_RUN_GAP_MS = 10 * 60_000;

const DAY_MS = 86_400_000;
const SHELL_TOOLS = new Set(['bash', 'shell_start', 'powershell']);
const SKIPPED_SCRIPT = /(?:^\.|\.(?:test|spec)\.[^.]+$|\.md$)/i;
const INTERPRETER = /^(?:pwsh|powershell|bash|sh|zsh|cmd|node|tsx|bun|deno|python3?|ruby|perl)(?:\.exe)?$/i;
const INTERPRETER_FILE_FLAG = /^-(?:File|f)$/i;
const INTERPRETER_CODE_FLAG = /^-(?:e|p|c|Command|eval|print)$/i;
const INTERPRETER_VALUE_FLAG = /^(?:-[rIm]|-(?:ExecutionPolicy|ep|WindowStyle|Version|ConfigurationName|WorkingDirectory|wd|InputFormat|OutputFormat)|--(?:import|require|loader|conditions|env-file|tsconfig))$/i;
const FILE_WITH_EXT = /^[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|jsonl|md|txt|log|csv|xml|yml|yaml|toml|sh|ps1|py|sql|html|css|env|cfg|conf|ini|lock|gz|tar|zip|bak|out|err|diff|patch)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_HASH = /^[0-9a-f]{7,64}$/i;
const PREFIXED_ID = /^(?:#\d+|[A-Z]{2,}-\d+|[a-zA-Z]+_[0-9a-fA-F]{4,}|[a-zA-Z]+[-_]\d{2,})$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{8,}$/;
const NUMBER_TOKEN = /^\d+(?:\.\d+)?(?:ms|[smhd]|kb|mb|gb)?$/i;

/** A repeated multi-step bash command shape worth turning into a tested script. */
export interface ForgeCandidate {
  shape: string;
  count: number;
  runs: number;
  example: string;
}

/** A script file discovered in the configured forged-tool directory. */
export interface ForgedScript {
  name: string;
  path: string;
  createdAt: number;
}

/** Reuse count and pruning status for one forged script. */
export interface ForgedScriptUsage extends ForgedScript {
  uses: number;
  lastUsedAt?: number;
  unusedDays: number;
  prune: boolean;
}

/** Full tool-forging report consumed by the daily retro prompt. */
export interface SkillProposal {
  shape: string;
  runs: number;
  draft: string;
}

export interface ForgeReport {
  candidates: ForgeCandidate[];
  skillProposals: SkillProposal[];
  reuse: ForgedScriptUsage[];
  prune: ForgedScriptUsage[];
  toolDir: string;
}

/** Optional input passed to `retroPrompt` to render forging, reuse and pruning guidance. */
export interface ForgeRetroInput {
  candidates: readonly ForgeCandidate[];
  skillProposals?: readonly SkillProposal[];
  reuse?: readonly ForgedScriptUsage[];
  prune?: readonly ForgedScriptUsage[];
  toolDir?: string;
}

/** Threshold overrides for `detectForgeCandidates`. */
export interface DetectForgeOptions {
  now?: number;
  windowDays?: number;
  minCount?: number;
  minRuns?: number;
  runGapMs?: number;
}

/** Options for `trackForgedReuse`. */
export interface TrackReuseOptions {
  now?: number;
  pruneDays?: number;
  home?: string;
}

/** Options for `analyzeToolForge`. */
export interface AnalyzeForgeOptions extends DetectForgeOptions, TrackReuseOptions {
  toolDir?: string;
  displayToolDir?: string;
}

/** Default on-disk directory for forged scripts under the Pi agent home. */
export function defaultToolDir(agentDir = join(homedir(), '.pi', 'agent')): string {
  return join(agentDir, 'bin');
}

/** Resolves the configured or default tool directory along with its display path. */
export function resolveToolDir(configured: string | undefined, agentDir?: string, home = homedir()): { path: string; display: string } {
  const trimmed = configured?.trim();
  if (!trimmed) return { path: defaultToolDir(agentDir ?? join(home, '.pi', 'agent')), display: DEFAULT_TOOL_DIR_DISPLAY };
  const expanded = trimmed === '~' ? home : /^~[/\\]/.test(trimmed) ? join(home, trimmed.slice(2)) : resolve(trimmed);
  return { path: expanded, display: trimmed };
}

function stripHeredocs(command: string): string {
  const out: string[] = [];
  let end: string | undefined;
  for (const line of command.split(/\r?\n/)) {
    if (end !== undefined) {
      if (line.trim() === end) end = undefined;
      continue;
    }
    const here = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(line);
    if (here) end = here[2];
    out.push(line);
  }
  return out.join(' ');
}

function maskQuotes(command: string): string {
  let out = '';
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < command.length && command[i] !== quote) {
        if (quote === '"' && command[i] === '\\' && i + 1 < command.length) i++;
        i++;
      }
      out += '<str>';
      continue;
    }
    out += ch;
  }
  return out;
}

type ChainOp = '|' | '&&' | ';';

function splitChain(command: string): { steps: string[]; ops: ChainOp[] } {
  const masked = maskQuotes(stripHeredocs(command));
  const rawSteps: string[] = [];
  const rawOps: ChainOp[] = [];
  let current = '';
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    const next = masked[i + 1];
    if (ch === '&' && next === '&') {
      rawSteps.push(current.trim());
      rawOps.push('&&');
      current = '';
      i++;
      continue;
    }
    if (ch === '|' && next === '|') {
      current += '||';
      i++;
      continue;
    }
    if (ch === '|') {
      rawSteps.push(current.trim());
      rawOps.push('|');
      current = '';
      continue;
    }
    if (ch === ';') {
      rawSteps.push(current.trim());
      rawOps.push(';');
      current = '';
      continue;
    }
    current += ch;
  }
  rawSteps.push(current.trim());

  const steps: string[] = [];
  const ops: ChainOp[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const step = rawSteps[i];
    if (!step) continue;
    if (steps.length > 0 && i > 0) ops.push(rawOps[i - 1]);
    steps.push(step);
  }
  return { steps, ops };
}

function isPathToken(token: string): boolean {
  if (/^https?:\/\//i.test(token)) return true;
  if (/^[a-zA-Z]:[/\\]/.test(token) || /^~(?:[/\\]|$)/.test(token) || /^\.\.?[/\\]/.test(token)) return true;
  if (token.includes('/') || token.includes('\\')) return true;
  return FILE_WITH_EXT.test(token);
}

function isIdToken(token: string): boolean {
  if (UUID.test(token)) return true;
  if (HEX_HASH.test(token) && ((/[0-9]/.test(token) && /[a-f]/i.test(token)) || token.length >= 32)) return true;
  if (PREFIXED_ID.test(token)) return true;
  return OPAQUE_ID.test(token) && /[a-zA-Z]/.test(token) && /\d/.test(token);
}

function normalizeValue(token: string, preferPath: boolean): string {
  if (token === '<str>') return '<str>';
  if (isPathToken(token)) return '<path>';
  if (ISO_DATE.test(token)) return '<num>';
  if (isIdToken(token)) return '<id>';
  if (NUMBER_TOKEN.test(token)) return '<num>';
  return preferPath ? '<path>' : token;
}

function normalizeStep(step: string): string {
  const tokens = step.split(/\s+/).filter(Boolean);
  return tokens.map((token, index) => {
    if (token === '<str>') return '<str>';
    if (/^\d*[<>]+&\d+$/.test(token) || /^\d*[<>]{1,2}$/.test(token)) return token;
    const redir = /^(\d*[<>]{1,2})(.+)$/.exec(token);
    if (redir) return `${redir[1]}${normalizeValue(redir[2], true)}`;
    const assign = /^(--?[A-Za-z][\w-]*|[A-Za-z_]\w*)=(.+)$/.exec(token);
    if (assign) return `${assign[1]}=${normalizeValue(assign[2], false)}`;
    if (/^-\d+$/.test(token)) return '-<num>';
    if (token.startsWith('-')) return token;
    if (index === 0) return (/^[a-zA-Z]:[/\\]|^~[/\\]|^\.\.?[/\\]|[/\\]/.test(token) ? '<path>' : token);
    return normalizeValue(token, false);
  }).join(' ');
}

/** Whether a bash command has at least two non-empty steps linked by pipes, `&&` or `;` outside quotes. */
export function isMultiStepCommand(command: string): boolean {
  return splitChain(command).steps.length >= 2;
}

/** Normalizes a bash command into a reusable shape by replacing paths, ids, numbers and quoted text. */
export function normalizeCommand(command: string): string {
  const { steps, ops } = splitChain(command);
  if (steps.length === 0) return '';
  let out = normalizeStep(steps[0]);
  for (let i = 1; i < steps.length; i++) {
    const op = ops[i - 1];
    out += op === ';' ? `; ${normalizeStep(steps[i])}` : ` ${op} ${normalizeStep(steps[i])}`;
  }
  return out;
}

/** Finds multi-step bash shapes repeated at least `minCount` times in `windowDays` across `minRuns` runs, ranked by frequency. */
export function detectForgeCandidates(entries: readonly ExecEntry[], options: DetectForgeOptions = {}): ForgeCandidate[] {
  const now = options.now ?? Date.now();
  const since = now - (options.windowDays ?? FORGE_WINDOW_DAYS) * DAY_MS;
  const minCount = options.minCount ?? FORGE_MIN_COUNT;
  const minRuns = options.minRuns ?? FORGE_MIN_RUNS;
  const runGapMs = options.runGapMs ?? FORGE_RUN_GAP_MS;

  const timed = entries
    .map(entry => ({ entry, at: Date.parse(entry.at) }))
    .filter(row => !Number.isNaN(row.at) && row.at >= since && row.entry.source !== 'background')
    .sort((a, b) => a.at - b.at);

  const grouped = new Map<string, { count: number; runs: Set<string>; example: string; lastAt: number }>();
  let gapRun = 0;
  let lastGapAt: number | undefined;

  for (const { entry, at } of timed) {
    let runKey: string;
    if (typeof entry.run === 'string' && entry.run.trim() !== '') {
      runKey = `run:${entry.run}`;
    } else {
      if (lastGapAt !== undefined && at - lastGapAt > runGapMs) gapRun++;
      lastGapAt = at;
      runKey = `gap:${gapRun}`;
    }
    if (entry.name !== 'bash' || typeof entry.target !== 'string' || !entry.target.trim()) continue;
    if (!isMultiStepCommand(entry.target)) continue;
    const shape = normalizeCommand(entry.target);
    if (!shape) continue;
    const current = grouped.get(shape) ?? { count: 0, runs: new Set<string>(), example: entry.target.trim(), lastAt: at };
    current.count++;
    current.runs.add(runKey);
    if (at >= current.lastAt) {
      current.example = entry.target.trim();
      current.lastAt = at;
    }
    grouped.set(shape, current);
  }

  return [...grouped.entries()]
    .filter(([, data]) => data.count >= minCount && data.runs.size >= minRuns)
    .sort((a, b) => b[1].count - a[1].count || b[1].runs.size - a[1].runs.size || b[1].lastAt - a[1].lastAt || a[0].localeCompare(b[0]))
    .map(([shape, data]) => ({ shape, count: data.count, runs: data.runs.size, example: data.example }));
}

/** Lists forged script files present in `toolDir`, using their earliest filesystem timestamp as creation time. */
export function listForgedScripts(toolDir: string): ForgedScript[] {
  if (!existsSync(toolDir)) return [];
  const scripts: ForgedScript[] = [];
  for (const entry of readdirSync(toolDir, { withFileTypes: true })) {
    if (SKIPPED_SCRIPT.test(entry.name)) continue;
    const full = join(toolDir, entry.name);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    const createdAt = stat.birthtimeMs > 0 ? Math.min(stat.birthtimeMs, stat.mtimeMs) : stat.mtimeMs;
    scripts.push({ name: entry.name, path: full, createdAt });
  }
  return scripts.sort((a, b) => a.name.localeCompare(b.name));
}

const unquote = (word: string) => word.replace(/^(['"])(.*)\1$/s, '$2');

function normalizeFsPath(filePath: string, home: string): string {
  const cleanHome = home.replaceAll('\\', '/').replace(/\/+$/, '');
  const expanded = unquote(filePath).replaceAll('\\', '/').replace(/^~(?=\/|$)/, cleanHome).replace(/^\/([a-z])(?=\/|$)/i, '$1:');
  const parts: string[] = [];
  for (const part of expanded.split('/')) {
    if (part === '.' || (part === '' && parts.length)) continue;
    if (part === '..' && parts.length > 1) parts.pop();
    else parts.push(part);
  }
  return parts.join('/').toLowerCase().replace(/\/+$/, '');
}

function invokedTargets(command: string): string[] {
  const targets: string[] = [];
  for (const part of segments(command, '')) {
    const words = commandWords(part.command);
    if (!words.length) continue;
    const first = unquote(words[0]);
    targets.push(first);
    const base = first.split(/[/\\]/).at(-1) ?? '';
    if (!INTERPRETER.test(base)) continue;
    for (let i = 1; i < words.length; i++) {
      const word = unquote(words[i]);
      if (INTERPRETER_FILE_FLAG.test(word)) {
        if (i + 1 < words.length) targets.push(unquote(words[i + 1]));
        break;
      }
      if (INTERPRETER_CODE_FLAG.test(word)) break;
      if (INTERPRETER_VALUE_FLAG.test(word)) { i++; continue; }
      if (word.startsWith('-')) continue;
      targets.push(word);
      break;
    }
  }
  return targets;
}

function matchesScript(target: string, scriptNameLower: string, scriptPathLower: string, home: string): boolean {
  if (/[/\\]/.test(target)) return normalizeFsPath(target, home) === scriptPathLower;
  return target.toLowerCase() === scriptNameLower;
}

/** Counts later shell exec-log calls that invoke each forged script and flags scripts unused for `pruneDays` days. */
export function trackForgedReuse(entries: readonly ExecEntry[], scripts: readonly ForgedScript[], options: TrackReuseOptions = {}): { reuse: ForgedScriptUsage[]; prune: ForgedScriptUsage[] } {
  const now = options.now ?? Date.now();
  const pruneDays = options.pruneDays ?? FORGE_PRUNE_DAYS;
  const pruneMs = pruneDays * DAY_MS;
  const home = options.home ?? homedir();

  const state = scripts.map(script => ({
    script,
    nameLower: script.name.toLowerCase(),
    pathLower: normalizeFsPath(script.path, home),
    uses: 0,
    lastUsedAt: undefined as number | undefined,
  }));

  for (const entry of entries) {
    if (entry.source === 'background' || !SHELL_TOOLS.has(entry.name) || typeof entry.target !== 'string') continue;
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) continue;
    const targets = invokedTargets(entry.target);
    if (!targets.length) continue;
    for (const item of state) {
      if (at < item.script.createdAt) continue;
      if (!targets.some(target => matchesScript(target, item.nameLower, item.pathLower, home))) continue;
      item.uses++;
      if (item.lastUsedAt === undefined || at > item.lastUsedAt) item.lastUsedAt = at;
    }
  }

  const reuse: ForgedScriptUsage[] = state.map(item => {
    const lastActive = item.lastUsedAt ?? item.script.createdAt;
    const idleMs = Math.max(0, now - lastActive);
    const unusedDays = Math.floor(idleMs / DAY_MS);
    return { ...item.script, uses: item.uses, ...(item.lastUsedAt === undefined ? {} : { lastUsedAt: item.lastUsedAt }), unusedDays, prune: idleMs >= pruneMs };
  }).sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name));

  const prune = reuse
    .filter(item => item.prune)
    .sort((a, b) => (a.lastUsedAt ?? a.createdAt) - (b.lastUsedAt ?? b.createdAt) || a.name.localeCompare(b.name));

  return { reuse, prune };
}

/** Drafts are based on successful commands, not proof that the enclosing task finished. */
export function proposeSkills(entries: readonly ExecEntry[], options: DetectForgeOptions = {}): SkillProposal[] {
  const now = options.now ?? Date.now();
  const successful = entries.filter(entry => entry.class === 'ok' && Date.parse(entry.at) <= now);
  return detectForgeCandidates(successful, { ...options, now, windowDays: FORGE_WINDOW_DAYS, minCount: 3, minRuns: 3 })
    .map(({ shape, runs }) => {
      const name = `repeated-task-${createHash('sha256').update(shape).digest('hex').slice(0, 12)}`;
      const display = JSON.stringify(shape);
      const draft = `---\nname: ${name}\ndescription: ${JSON.stringify(`Use when a task matches this observed command shape: ${shape}`)}\n---\n\n# Repeated task proposal\n\n## When to use\n\nUse when the task matches ${display}. This is a draft inferred from successful commands, not evidence that the tasks finished.\n\n## Inputs\n\nIdentify the target, working directory, and values represented by placeholders in the shape.\n\n## Steps\n\n1. Review the observed shape ${display} and the actual task; replace placeholders only after inspecting the relevant context.\n2. Adapt the steps to the task and permitted effects. Do not execute the shape verbatim.\n\n## Validation\n\nCheck the real result against the requested outcome; a successful command alone is not proof of task completion.\n\n## What needs approval\n\nCheck current authority before any gated effect; the observed history grants no permission.\n\n## Return\n\nReport the result, evidence, and any unverified or blocked work.\n`;
      return { shape, runs, draft };
    });
}

/** Runs candidate detection and forged-script reuse/pruning analysis over a profile's exec log and tool directory. */
export function analyzeToolForge(profileDir: string, options: AnalyzeForgeOptions = {}): ForgeReport {
  const toolDir = options.toolDir ?? defaultToolDir();
  const entries = readExecLog(profileDir);
  const candidates = detectForgeCandidates(entries, options);
  const scripts = listForgedScripts(toolDir);
  const { reuse, prune } = trackForgedReuse(entries, scripts, options);
  return { candidates, skillProposals: proposeSkills(entries, options), reuse, prune, toolDir: options.displayToolDir ?? options.toolDir ?? DEFAULT_TOOL_DIR_DISPLAY };
}

/** Formats top forge candidates, reuse counts and 30-day prune candidates as lines for the daily retro prompt. */
export function formatForgeRetroLines(report: ForgeRetroInput, limit = FORGE_TOP): string[] {
  const toolDir = report.toolDir ?? DEFAULT_TOOL_DIR_DISPLAY;
  const lines: string[] = [];
  const top = report.candidates.slice(0, limit);
  if (top.length > 0) {
    lines.push(`Tool forging candidates (top ${top.length} repeated multi-step bash shapes in the last ${FORGE_WINDOW_DAYS} d). Turn each into a tested script under ${toolDir} and expose it through a skill:`);
    for (const candidate of top) {
      lines.push(`- ${candidate.shape} (${candidate.count}x across ${candidate.runs} runs; e.g. \`${candidate.example}\`)`);
    }
  }
  const skillProposals = (report.skillProposals ?? []).slice(0, limit);
  if (skillProposals.length) {
    lines.push('Skill proposals (dry-run drafts only; review and validate before use, no automatic merge):');
    for (const proposal of skillProposals) {
      lines.push(`Observed across ${proposal.runs} successful runs; task completion is not established.`, proposal.draft);
    }
  }
  const activeReuse = (report.reuse ?? []).filter(item => item.uses > 0 && !item.prune);
  if (activeReuse.length > 0) {
    lines.push(`Forged script reuse (${toolDir}):`);
    for (const item of activeReuse) {
      lines.push(`- ${item.name}: ${item.uses} calls`);
    }
  }
  const stale = report.prune ?? [];
  if (stale.length > 0) {
    lines.push(`Forged scripts unused for ${FORGE_PRUNE_DAYS}+ days in ${toolDir} (candidates to prune):`);
    for (const item of stale) {
      lines.push(`- ${item.name} (${item.uses} calls, unused ${item.unusedDays} d)`);
    }
  }
  return lines;
}
