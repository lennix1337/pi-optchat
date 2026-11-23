import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { getAgentDir, parseSkillBlock, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { scanSkills } from './live-resources.ts';

/** Default rolling lookback window (in days) for skill usage stocktake reports. */
export const DEFAULT_STOCKTAKE_DAYS = 30;

const DAY_MS = 86_400_000;
const USAGE_ERROR = 'Usage: /skill-stocktake [days] (positive whole number, e.g. 30 or 14d)';

/** Minimal skill metadata needed to attribute session reads to an installed skill. */
export interface SkillRef {
  name: string;
  filePath: string;
}

/** Aggregated read count and pruning status for one installed skill. */
export interface SkillUsageRow {
  name: string;
  filePath: string;
  reads: number;
  lastReadAt?: number;
  pruneCandidate: boolean;
}

/** Report-only summary of installed skill reads over the requested lookback window. */
export interface SkillStocktakeReport {
  days: number;
  since: number;
  until: number;
  sessionsDir: string;
  sessionsScanned: number;
  sessionsMissing: boolean;
  skills: SkillUsageRow[];
  pruneCandidates: SkillUsageRow[];
}

/** Inputs and injectable seams for `skillStocktake`. */
export interface SkillStocktakeOptions {
  cwd?: string;
  agentDir?: string;
  home?: string;
  sessionsDir?: string;
  loadedPaths?: readonly string[];
  skills?: readonly SkillRef[];
  days?: number;
  now?: number;
}

/** Registration options for the `/skill-stocktake` slash command. */
export interface RegisterSkillStocktakeOptions {
  agentDir?: string;
  home?: string;
  sessionsDir?: string;
  defaultDays?: () => number | undefined;
  now?: () => number;
}

type ContentPart = { type?: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type SessionEvent = {
  type?: string;
  cwd?: string;
  timestamp?: string | number;
  message?: {
    role?: string;
    timestamp?: string | number;
    toolCallId?: string;
    isError?: boolean;
    content?: ContentPart[] | string;
  };
};

interface SkillBucket {
  name: string;
  filePath: string;
  reads: number;
  lastReadAt?: number;
}

function parseTimestamp(value: string | number | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value === 'string' && value.trim()) return Date.parse(value);
  return Number.NaN;
}

function expandPath(rawPath: string, home: string, baseDir?: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return '';
  let expanded = trimmed === '~' ? home : /^~[/\\]/.test(trimmed) ? join(home, trimmed.slice(2)) : trimmed;
  if (/^\/[a-z](?:\/|$)/i.test(expanded)) expanded = `${expanded[1]}:${expanded.slice(2)}`;
  if (!isAbsolute(expanded) && !/^[a-z]:[/\\]/i.test(expanded) && !expanded.startsWith('/') && baseDir) {
    expanded = resolve(baseDir, expanded);
  }
  return expanded;
}

function normalizePathKey(expandedPath: string): string {
  const slashes = expandedPath.replaceAll('\\', '/');
  const parts: string[] = [];
  const rooted = slashes.startsWith('/');
  for (const part of slashes.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') {
      if (parts.length === 1 && /^[a-z]:$/i.test(parts[0]!)) continue;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const joined = (rooted ? '/' : '') + parts.join('/');
  const caseInsensitive = process.platform === 'win32' || /^[a-z]:(?:\/|$)/i.test(joined);
  return caseInsensitive ? joined.toLowerCase() : joined;
}

function safeRealpath(path: string): string | undefined {
  try { return realpathSync.native(path); } catch { return undefined; }
}

function listSessionFiles(dir: string, since: number): { missing: boolean; files: string[] } {
  if (!existsSync(dir)) return { missing: true, files: [] };
  let rootStat;
  try { rootStat = statSync(dir); } catch { return { missing: true, files: [] }; }
  if (rootStat.isFile()) return { missing: false, files: rootStat.mtimeMs >= since ? [dir] : [] };
  if (!rootStat.isDirectory()) return { missing: true, files: [] };

  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let entryStat;
    try { entryStat = statSync(full); } catch { continue; }
    if (entryStat.isDirectory()) {
      let children: string[];
      try { children = readdirSync(full); } catch { continue; }
      for (const child of children) {
        if (!child.endsWith('.jsonl')) continue;
        const childFull = join(full, child);
        try { if (statSync(childFull).mtimeMs >= since) files.push(childFull); } catch { continue; }
      }
    } else if (entryStat.isFile() && name.endsWith('.jsonl') && entryStat.mtimeMs >= since) {
      files.push(full);
    }
  }
  return { missing: false, files: files.sort() };
}

function unwrapToolCalls(event: SessionEvent): { id?: string; name: string; arguments?: Record<string, unknown> }[] {
  if (event.type !== 'message' || event.message?.role !== 'assistant' || !Array.isArray(event.message.content)) return [];
  return event.message.content.filter(part => part.type === 'toolCall').flatMap(part => {
    if (part.name === 'multi_tool_use.parallel' && Array.isArray(part.arguments?.tool_uses)) {
      return part.arguments.tool_uses
        .filter((item): item is { recipient_name: string; parameters?: Record<string, unknown> } =>
          typeof item === 'object' && item !== null && typeof (item as { recipient_name?: unknown }).recipient_name === 'string')
        .map(item => ({ id: part.id, name: item.recipient_name.replace(/^functions\./u, ''), arguments: item.parameters }));
    }
    return typeof part.name === 'string' ? [{ id: part.id, name: part.name, arguments: part.arguments }] : [];
  });
}

function messageText(content: ContentPart[] | string | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text!).join('\n');
}

/** Parses an optional `[days]` argument (for example `30` or `14d`) for `/skill-stocktake`. */
export function parseStocktakeDays(args: string, fallback = DEFAULT_STOCKTAKE_DAYS): number {
  const trimmed = args.trim();
  if (!trimmed) return fallback;
  const match = /^([1-9]\d*)d?$/i.exec(trimmed);
  const days = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(days) || days < 1) throw new Error(USAGE_ERROR);
  return days;
}

/** Counts how often each installed skill's `SKILL.md` was read in Pi session logs over the last `days` days. Report-only. */
export function skillStocktake(options: SkillStocktakeOptions = {}): SkillStocktakeReport {
  const days = options.days ?? DEFAULT_STOCKTAKE_DAYS;
  if (!Number.isSafeInteger(days) || days < 1) throw new Error('Stocktake window must be a positive whole number of days.');

  const now = options.now ?? Date.now();
  const since = now - days * DAY_MS;
  const home = options.home ?? homedir();
  const agentDir = options.agentDir ?? getAgentDir();
  const cwd = options.cwd ?? process.cwd();
  const sessionsDir = options.sessionsDir ?? join(agentDir, 'sessions');
  const discovered = options.skills ?? scanSkills(cwd, agentDir, options.loadedPaths ?? [], home);

  const buckets: SkillBucket[] = [];
  const byName = new Map<string, SkillBucket>();
  const byPath = new Map<string, SkillBucket>();

  for (const skill of discovered) {
    if (byName.has(skill.name)) continue;
    const bucket: SkillBucket = { name: skill.name, filePath: skill.filePath, reads: 0 };
    buckets.push(bucket);
    byName.set(skill.name, bucket);
    const expanded = expandPath(skill.filePath, home);
    if (expanded) {
      byPath.set(normalizePathKey(expanded), bucket);
      const real = safeRealpath(expanded);
      if (real) byPath.set(normalizePathKey(real), bucket);
    }
  }

  const matchPath = (rawPath: string, sessionCwd: string | undefined): SkillBucket | undefined => {
    const expanded = expandPath(rawPath, home, sessionCwd ?? cwd);
    if (!expanded) return undefined;
    const direct = byPath.get(normalizePathKey(expanded));
    if (direct) return direct;
    const real = safeRealpath(expanded);
    return real ? byPath.get(normalizePathKey(real)) : undefined;
  };

  const { missing: sessionsMissing, files } = listSessionFiles(sessionsDir, since);

  for (const file of files) {
    let raw: string;
    try { raw = readFileSync(file, 'utf8'); } catch { continue; }
    let sessionCwd: string | undefined;
    const pendingHits: { bucket: SkillBucket; at: number; callId?: string }[] = [];
    const failedCalls = new Set<string>();

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let event: SessionEvent;
      try { event = JSON.parse(line) as SessionEvent; } catch { continue; }
      if (event.type === 'session' && typeof event.cwd === 'string' && event.cwd.trim()) {
        sessionCwd = event.cwd;
        continue;
      }

      const reply = event.message;
      if (event.type === 'message' && reply?.role === 'toolResult' && typeof reply.toolCallId === 'string' && reply.isError === true) {
        failedCalls.add(reply.toolCallId);
        continue;
      }

      const at = parseTimestamp(event.timestamp ?? reply?.timestamp);
      if (!Number.isFinite(at) || at < since || at > now) continue;

      if (event.type === 'message' && reply?.role === 'user') {
        const block = parseSkillBlock(messageText(reply.content));
        if (block) {
          const bucket = (block.location ? matchPath(block.location, sessionCwd) : undefined) ?? byName.get(block.name);
          if (bucket) pendingHits.push({ bucket, at });
        }
        continue;
      }

      for (const call of unwrapToolCalls(event)) {
        const args = call.arguments;
        if (!args || typeof args !== 'object') continue;
        if (call.name === 'read' && typeof args.path === 'string') {
          const bucket = matchPath(args.path, sessionCwd);
          if (bucket) pendingHits.push({ bucket, at, callId: call.id });
        } else if (call.name === 'read_many' && Array.isArray(args.files)) {
          for (const entry of args.files) {
            if (typeof entry === 'object' && entry !== null && typeof (entry as { path?: unknown }).path === 'string') {
              const bucket = matchPath((entry as { path: string }).path, sessionCwd);
              if (bucket) pendingHits.push({ bucket, at, callId: call.id });
            }
          }
        } else if (call.name === 'skills_on_disk' && typeof args.name === 'string') {
          const bucket = byName.get(args.name);
          if (bucket) pendingHits.push({ bucket, at, callId: call.id });
        }
      }
    }

    for (const hit of pendingHits) {
      if (hit.callId && failedCalls.has(hit.callId)) continue;
      hit.bucket.reads++;
      if (hit.bucket.lastReadAt === undefined || hit.at > hit.bucket.lastReadAt) hit.bucket.lastReadAt = hit.at;
    }
  }

  const skills: SkillUsageRow[] = buckets
    .map(bucket => ({
      name: bucket.name,
      filePath: bucket.filePath,
      reads: bucket.reads,
      ...(bucket.lastReadAt === undefined ? {} : { lastReadAt: bucket.lastReadAt }),
      pruneCandidate: bucket.reads === 0,
    }))
    .sort((a, b) => b.reads - a.reads || a.name.localeCompare(b.name));

  const pruneCandidates = skills
    .filter(skill => skill.pruneCandidate)
    .sort((a, b) => a.name.localeCompare(b.name));

  return { days, since, until: now, sessionsDir, sessionsScanned: files.length, sessionsMissing, skills, pruneCandidates };
}

/** Renders a report-only stocktake summary listing read counts and prune candidates. */
export function renderSkillStocktake(report: SkillStocktakeReport): string {
  const sessionLabel = report.sessionsMissing
    ? 'sessions directory not found'
    : `${report.sessionsScanned} session ${report.sessionsScanned === 1 ? 'log' : 'logs'}`;

  if (report.skills.length === 0) {
    return `Skill stocktake (last ${report.days}d, ${sessionLabel}): no installed skills found.`;
  }

  const lines = [
    `Skill stocktake (last ${report.days}d, ${sessionLabel}, ${report.skills.length} installed, ${report.pruneCandidates.length} prune ${report.pruneCandidates.length === 1 ? 'candidate' : 'candidates'}):`,
  ];

  for (const row of report.skills) {
    const count = `${row.reads} ${row.reads === 1 ? 'read' : 'reads'}`;
    const tail = row.pruneCandidate
      ? ' [prune candidate]'
      : row.lastReadAt === undefined ? '' : ` (last ${new Date(row.lastReadAt).toISOString().slice(0, 10)})`;
    lines.push(`- ${row.name}: ${count}${tail}`);
  }

  if (report.pruneCandidates.length > 0) {
    lines.push(`Prune candidates (${report.pruneCandidates.length}, never read in last ${report.days}d; report only): ${report.pruneCandidates.map(s => s.name).join(', ')}`);
  } else {
    lines.push(`Prune candidates (0, report only): none — every installed skill was read in the last ${report.days}d.`);
  }

  return lines.join('\n');
}

/** Registers the read-only `/skill-stocktake [days]` slash command. */
export function registerSkillStocktake(pi: ExtensionAPI, options: RegisterSkillStocktakeOptions = {}): void {
  pi.registerCommand('skill-stocktake', {
    description: 'Report installed skills, SKILL.md read counts from Pi session logs over the last N days, and never-used prune candidates (report only)',
    handler: async (args, ctx) => {
      try {
        const fallback = options.defaultDays?.() ?? DEFAULT_STOCKTAKE_DAYS;
        const days = parseStocktakeDays(args, fallback);
        const loadedPaths = pi.getCommands().filter(command => command.source === 'skill').map(command => command.sourceInfo.path);
        const report = skillStocktake({
          cwd: ctx.cwd,
          agentDir: options.agentDir,
          home: options.home,
          sessionsDir: options.sessionsDir,
          loadedPaths,
          days,
          now: options.now?.(),
        });
        ctx.ui.notify(renderSkillStocktake(report), 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });
}
