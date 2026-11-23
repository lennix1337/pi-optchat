import { statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

/** Default prompt byte budget for skills (skills list + loaded SKILL.md files); 0 disables the budget flag. */
export const DEFAULT_SKILL_BUDGET_BYTES = 32_768;

/** Per-skill prompt cost breakdown. */
export interface SkillBudgetRow {
  name: string;
  location?: string;
  /** UTF-8 bytes this skill's entry adds to the system prompt's skills list (`<available_skills>`). */
  listBytes: number;
  /** UTF-8 bytes of this skill's SKILL.md currently loaded in prompt messages. */
  loadedBytes: number;
  /** UTF-8 bytes of the SKILL.md file on disk when readable at `location`. */
  fileBytes?: number;
  /** Total prompt bytes contributed by this skill (`listBytes + loadedBytes`). */
  bytes: number;
  /** Estimated tokens for `bytes` (`Math.ceil(bytes / 4)`). */
  estimatedTokens: number;
}

/** Compact loaded-skill measurement extracted from prompt messages without retaining raw text. */
export interface LoadedSkillEntry {
  name: string;
  location?: string;
  bytes: number;
}

/** Registered skill metadata known to the session (including skills hidden from `<available_skills>`). */
export interface RegisteredSkill {
  name: string;
  location?: string;
}

/** Inputs to `skillBudget`. */
export interface SkillBudgetInput {
  systemPrompt: string;
  messages?: readonly AgentMessage[];
  loadedSkills?: readonly LoadedSkillEntry[];
  registeredSkills?: readonly RegisteredSkill[];
  budgetBytes?: number;
  statSize?: (path: string) => number | undefined;
}

/** Prompt byte/token budget report for the skills list and loaded SKILL.md files. */
export interface SkillBudgetReport {
  skills: SkillBudgetRow[];
  /** Bytes of the `<skills>` / `<available_skills>` wrapper outside individual `<skill>` entries. */
  listOverheadBytes: number;
  /** Total bytes added by the skills list in the system prompt (`listOverheadBytes + sum(row.listBytes)`). */
  listBytes: number;
  /** Total bytes added by loaded SKILL.md files in the prompt messages. */
  loadedBytes: number;
  /** Total on-disk bytes across known SKILL.md files. */
  fileBytes: number;
  /** Total bytes skills add to the prompt (`listBytes + loadedBytes`). */
  totalBytes: number;
  /** Estimated tokens for `totalBytes` (`Math.ceil(totalBytes / 4)`). */
  estimatedTokens: number;
  /** Configured byte budget (`0` = disabled). */
  budgetBytes: number;
  /** Estimated tokens for `budgetBytes`. */
  budgetTokens: number;
  /** True when `budgetBytes > 0` and `totalBytes > budgetBytes`. */
  exceeded: boolean;
  /** Bytes above `budgetBytes` (`0` when under budget or disabled). */
  overByBytes: number;
}

/** Estimates tokens from UTF-8 byte length using Pi's 4-per-token convention. */
export const estimateSkillTokens = (bytes: number) => Math.ceil(Math.max(0, bytes) / 4);

const unescapeXml = (value: string) => value
  .replace(/&apos;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&gt;/g, '>')
  .replace(/&lt;/g, '<')
  .replace(/&amp;/g, '&');

const normalizePath = (value: string) => {
  const slashed = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
};

const isSkillFilePath = (value: string) => /^skill\.md$/i.test(basename(value.replace(/\\/g, '/')));

const skillNameFromPath = (value: string, knownLocations: ReadonlyMap<string, string>) => {
  const known = knownLocations.get(normalizePath(value));
  if (known) return known;
  const normalized = value.replace(/\\/g, '/');
  const parent = basename(dirname(normalized));
  return parent && parent !== '.' && parent !== '/' ? parent : basename(normalized);
};

const fileSizeOnDisk = (path: string): number | undefined => {
  try {
    const stat = statSync(path);
    return stat.isFile() ? stat.size : undefined;
  } catch {
    return undefined;
  }
};

const contentParts = (content: unknown): string[] => {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
      parts.push((block as { text: string }).text);
    }
  }
  return parts;
};

/** Parses Pi's `<skills>` / `<available_skills>` section from the rendered system prompt. */
export function parseSkillsList(systemPrompt: string): { overheadBytes: number; entries: { name: string; location?: string; listBytes: number }[] } {
  const outer = /<skills>(?:(?!<\/skills>)[\s\S])*?<available_skills>[\s\S]*?<\/available_skills>(?:(?!<\/skills>)[\s\S])*?<\/skills>/.exec(systemPrompt);
  const available = /<available_skills>[\s\S]*?<\/available_skills>/.exec(outer ? outer[0] : systemPrompt);
  if (!available) return { overheadBytes: 0, entries: [] };
  const blockText = outer ? outer[0] : available[0];
  const entries: { name: string; location?: string; listBytes: number }[] = [];
  let entrySum = 0;
  for (const match of available[0].matchAll(/<skill>[\s\S]*?<\/skill>/g)) {
    const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(match[0]);
    if (!nameMatch) continue;
    const locationMatch = /<location>([\s\S]*?)<\/location>/.exec(match[0]);
    const listBytes = Buffer.byteLength(match[0], 'utf8');
    entrySum += listBytes;
    entries.push({
      name: unescapeXml(nameMatch[1]!.trim()),
      ...(locationMatch ? { location: unescapeXml(locationMatch[1]!.trim()) } : {}),
      listBytes,
    });
  }
  return { overheadBytes: Math.max(0, Buffer.byteLength(blockText, 'utf8') - entrySum), entries };
}

// external: Pi expands `/skill:<name>` and `skills_on_disk` returns `<skill name="..." location="...">...</skill>`.
const LOADED_SKILL_TAG = /<skill\s+name="([^"]+)"(?:\s+location="([^"]*)")?>[\s\S]*?<\/skill>/g;

/** Extracts loaded SKILL.md byte counts from prompt messages (`read`, `read_many`, `/skill:` and `skills_on_disk`). */
export function measureLoadedSkills(messages: readonly AgentMessage[], knownLocations: ReadonlyMap<string, string> = new Map()): LoadedSkillEntry[] {
  const totals = new Map<string, LoadedSkillEntry>();
  const add = (name: string, bytes: number, location?: string) => {
    if (bytes <= 0) return;
    const current = totals.get(name);
    if (current) {
      current.bytes += bytes;
      if (!current.location && location) current.location = location;
    } else {
      totals.set(name, { name, bytes, ...(location ? { location } : {}) });
    }
  };
  const scanSkillTags = (text: string) => {
    for (const match of text.matchAll(LOADED_SKILL_TAG)) {
      add(match[1]!, Buffer.byteLength(match[0], 'utf8'), match[2] || undefined);
    }
  };
  const readCalls = new Map<string, string>();
  const readManyCalls = new Map<string, readonly string[]>();

  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'toolCall') continue;
        const call = block as { id?: unknown; name?: unknown; arguments?: unknown };
        if (typeof call.id !== 'string' || !call.arguments || typeof call.arguments !== 'object') continue;
        const args = call.arguments as { path?: unknown; files?: unknown };
        if (call.name === 'read' && typeof args.path === 'string') {
          readCalls.set(call.id, args.path);
        } else if (call.name === 'read_many' && Array.isArray(args.files)) {
          const paths = args.files
            .map(entry => entry && typeof entry === 'object' ? (entry as { path?: unknown }).path : undefined)
            .filter((entry): entry is string => typeof entry === 'string');
          readManyCalls.set(call.id, paths);
        }
      }
      continue;
    }
    if (message.role === 'user' || message.role === 'custom') {
      for (const text of contentParts(message.content)) scanSkillTags(text);
      continue;
    }
    if (message.role === 'toolResult') {
      const result = message as { toolCallId?: unknown; isError?: unknown; content?: unknown };
      if (result.isError === true) continue;
      const callId = typeof result.toolCallId === 'string' ? result.toolCallId : '';
      const parts = contentParts(result.content);
      const readPath = readCalls.get(callId);
      if (readPath !== undefined) {
        if (knownLocations.has(normalizePath(readPath)) || isSkillFilePath(readPath)) {
          const total = parts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
          add(skillNameFromPath(readPath, knownLocations), total, readPath);
        }
        continue;
      }
      if (readManyCalls.has(callId)) {
        let activePath: string | undefined;
        for (const text of parts) {
          if (text.startsWith('== ') && !text.includes('\n')) {
            activePath = text.slice(3).trim();
            continue;
          }
          if (activePath && (knownLocations.has(normalizePath(activePath)) || isSkillFilePath(activePath))) {
            add(skillNameFromPath(activePath, knownLocations), Buffer.byteLength(text, 'utf8'), activePath);
          }
        }
        continue;
      }
      for (const text of parts) scanSkillTags(text);
    }
  }
  return [...totals.values()];
}

/** Builds a normalized location -> skill-name map from the system prompt skills list and registered skills. */
export function skillLocations(systemPrompt: string, registeredSkills: readonly RegisteredSkill[] = []): Map<string, string> {
  const known = new Map<string, string>();
  for (const skill of registeredSkills) {
    if (skill.location) known.set(normalizePath(skill.location), skill.name);
  }
  for (const entry of parseSkillsList(systemPrompt).entries) {
    if (entry.location) known.set(normalizePath(entry.location), entry.name);
  }
  return known;
}

/** Measures per-skill and total bytes/tokens added to the prompt, compared against the configured budget. */
export function skillBudget(input: SkillBudgetInput): SkillBudgetReport {
  const budgetBytes = Math.max(0, Math.floor(input.budgetBytes ?? DEFAULT_SKILL_BUDGET_BYTES));
  const statSize = input.statSize ?? fileSizeOnDisk;
  const parsed = parseSkillsList(input.systemPrompt);
  const rows = new Map<string, { name: string; location?: string; listBytes: number; loadedBytes: number }>();
  const knownLocations = new Map<string, string>();

  const ensure = (name: string, location?: string) => {
    let row = rows.get(name);
    if (!row) {
      row = { name, listBytes: 0, loadedBytes: 0, ...(location ? { location } : {}) };
      rows.set(name, row);
    } else if (!row.location && location) {
      row.location = location;
    }
    if (location) knownLocations.set(normalizePath(location), name);
    return row;
  };

  for (const skill of input.registeredSkills ?? []) ensure(skill.name, skill.location);
  for (const entry of parsed.entries) {
    const row = ensure(entry.name, entry.location);
    row.listBytes += entry.listBytes;
  }

  const loaded = input.loadedSkills ?? (input.messages ? measureLoadedSkills(input.messages, knownLocations) : []);
  for (const entry of loaded) {
    const resolvedName = entry.location ? knownLocations.get(normalizePath(entry.location)) ?? entry.name : entry.name;
    const row = ensure(resolvedName, entry.location);
    row.loadedBytes += entry.bytes;
  }

  let listEntryBytes = 0;
  let loadedBytes = 0;
  let fileBytes = 0;
  const skills: SkillBudgetRow[] = [];
  for (const row of rows.values()) {
    const bytes = row.listBytes + row.loadedBytes;
    const onDisk = row.location ? statSize(row.location) : undefined;
    listEntryBytes += row.listBytes;
    loadedBytes += row.loadedBytes;
    if (onDisk !== undefined) fileBytes += onDisk;
    skills.push({
      name: row.name,
      ...(row.location ? { location: row.location } : {}),
      listBytes: row.listBytes,
      loadedBytes: row.loadedBytes,
      ...(onDisk !== undefined ? { fileBytes: onDisk } : {}),
      bytes,
      estimatedTokens: estimateSkillTokens(bytes),
    });
  }
  skills.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

  const listBytes = parsed.overheadBytes + listEntryBytes;
  const totalBytes = listBytes + loadedBytes;
  const exceeded = budgetBytes > 0 && totalBytes > budgetBytes;
  return {
    skills,
    listOverheadBytes: parsed.overheadBytes,
    listBytes,
    loadedBytes,
    fileBytes,
    totalBytes,
    estimatedTokens: estimateSkillTokens(totalBytes),
    budgetBytes,
    budgetTokens: estimateSkillTokens(budgetBytes),
    exceeded,
    overByBytes: exceeded ? totalBytes - budgetBytes : 0,
  };
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
const ktok = (tokens: number) => tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

/** Formats a `SkillBudgetReport` for `/tools` and human-readable reports. */
export function renderSkillBudget(report: SkillBudgetReport): string {
  const listed = report.skills.filter(skill => skill.listBytes > 0).length;
  const loaded = report.skills.filter(skill => skill.loadedBytes > 0).length;
  const budgetText = report.budgetBytes > 0
    ? report.exceeded
      ? `vs ${kb(report.budgetBytes)} budget [OVER BUDGET by ${kb(report.overByBytes)}]`
      : `vs ${kb(report.budgetBytes)} budget (ok)`
    : '(no budget set)';
  const lines = [
    `Skills: ${listed} listed (${kb(report.listBytes)}), ${loaded} loaded in prompt (${kb(report.loadedBytes)}), total ${kb(report.totalBytes)} (~${ktok(report.estimatedTokens)} tokens) ${budgetText}.`,
  ];
  for (const skill of report.skills) {
    const parts = [`list ${kb(skill.listBytes)}`];
    if (skill.loadedBytes > 0) parts.push(`loaded ${kb(skill.loadedBytes)}`);
    if (skill.fileBytes !== undefined) parts.push(`file ${kb(skill.fileBytes)}`);
    lines.push(`- ${skill.name}: ${kb(skill.bytes)} (${parts.join(', ')}, ~${ktok(skill.estimatedTokens)} tokens)`);
  }
  return lines.join('\n');
}
