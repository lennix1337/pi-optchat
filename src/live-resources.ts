import { existsSync, readFileSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { getAgentDir, loadSkills, stripFrontmatter, type ExtensionAPI, type Skill } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

/** Pi reads `mcp.json` and the skill directories at startup and on /reload only. This module lets a running session pick up
 * a server added to `mcp.json`, and read a skill created since startup, without /reload. */
export const MCP_NOTICE_TYPE = 'optchat-mcp-config';

type Config = Record<string, unknown>;
const record = (value: unknown): value is Config => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Key order does not make a config different. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, v) => record(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : 1)) : v);

/** The servers `file` defines, or undefined while it is missing, half written or not an `mcpServers` object. */
export function readMcpServers(file: string): Map<string, Config> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!record(parsed) || (parsed.mcpServers !== undefined && !record(parsed.mcpServers))) return undefined;
    return new Map(Object.entries(parsed.mcpServers ?? {}).flatMap(([name, config]) => record(config) ? [[name, config] as const] : []));
  } catch { return undefined; }
}

export interface McpHost { register(name: string, config: Config): void; unregister(name: string): void }

/** Mirrors `file` into the session's MCP servers. Pi connects a server registered by an extension at once, but a name
 * that `mcp.json` defined at startup belongs to Pi's own loader (registering it is ignored, and Pi never drops it), so
 * a change to one of those can only be reported, not applied. Config values never leave this class: notices carry names. */
export class McpFileSync {
  private known = new Map<string, string>();
  private startup = new Map<string, string>();
  private ours = new Set<string>();
  constructor(private file: string, private host: McpHost, private say: (line: string) => void) {}

  /** The file as Pi loaded it at session start. */
  baseline() {
    this.known = new Map([...readMcpServers(this.file) ?? []].map(([name, config]) => [name, canonical(config)]));
    this.startup = new Map(this.known);
  }

  /** Applies what changed since the last look. An unreadable file changes nothing: the next write triggers another look. */
  check() {
    const next = readMcpServers(this.file);
    if (!next) return;
    const added: string[] = [], changed: string[] = [], removed: string[] = [], stale: string[] = [], rejected: string[] = [];
    for (const [name, config] of next) {
      const text = canonical(config);
      if (this.known.get(name) === text) continue;
      this.known.set(name, text);
      if (this.startup.has(name) && !this.ours.has(name)) { if (this.startup.get(name) !== text) stale.push(name); continue; }
      try { this.host.register(name, config); } catch (error) { rejected.push(`${name} (${error instanceof Error ? error.message : String(error)})`); continue; }
      (this.ours.has(name) ? changed : added).push(name);
      this.ours.add(name);
    }
    for (const name of [...this.known.keys()].filter(name => !next.has(name))) {
      this.known.delete(name);
      if (this.ours.delete(name)) { this.host.unregister(name); removed.push(name); } else if (this.startup.has(name)) stale.push(name);
    }
    const parts = [added.length && `added ${added.join(', ')}`, changed.length && `changed ${changed.join(', ')}`, removed.length && `removed ${removed.join(', ')}`,
      stale.length && `${stale.join(', ')} changed but was loaded at session start, so /reload applies it`, rejected.length && `rejected ${rejected.join('; ')}`].filter(Boolean);
    if (parts.length) this.say(`MCP servers in mcp.json: ${parts.join('; ')}.`);
  }
}

/** Calls `onChange` once, `debounceMs` after the last change to `file`. Watches the directory, not the file: editors and
 * atomic writers replace the file, which ends a watch on the old one. Returns the function that stops it. */
export function watchFile(file: string, onChange: () => void, debounceMs = 300): () => void {
  const base = basename(file).toLowerCase();
  let timer: NodeJS.Timeout | undefined;
  try {
    const watcher = watch(dirname(file), { persistent: false }, (_event, name) => {
      if (name && String(name).toLowerCase() !== base) return;
      clearTimeout(timer);
      timer = setTimeout(() => { try { onChange(); } catch { /* the next change looks again */ } }, debounceMs);
      timer.unref();
    });
    watcher.on('error', () => {});
    return () => { clearTimeout(timer); watcher.close(); };
  } catch { return () => {}; }
}

/** Every skill under the directories the session loaded skills from, plus the standard ones. Skill directories hold
 * `<name>/SKILL.md`, so a loaded skill's grandparent is its root and a sibling created since startup is found there. */
export function scanSkills(cwd: string, agentDir: string, loadedPaths: readonly string[], home = homedir()): Skill[] {
  const roots = new Set([join(home, '.agents', 'skills'), resolve(cwd, '.agents', 'skills'),
    ...loadedPaths.map(path => basename(path) === 'SKILL.md' ? dirname(dirname(path)) : dirname(path))]);
  return loadSkills({ cwd, agentDir, skillPaths: [...roots].filter(existsSync), includeDefaults: true }).skills;
}

const text = (value: string, isError = false) => ({ content: [{ type: 'text' as const, text: value }], details: {}, ...isError ? { isError } : {} });

export function registerLiveResources(pi: ExtensionAPI, options: { agentDir?: string; debounceMs?: number } = {}) {
  const agentDir = options.agentDir ?? getAgentDir();
  if (typeof pi.registerMcpServer === 'function') {
    let stop: (() => void) | undefined;
    const pending: string[] = [];
    pi.on('session_start', (_event, ctx) => {
      stop?.();
      const file = join(agentDir, 'mcp.json');
      const sync = new McpFileSync(file, { register: (name, config) => pi.registerMcpServer(name, config as never), unregister: name => pi.unregisterMcpServer(name) },
        line => { pending.push(line); try { ctx.ui.notify(line, 'info'); } catch { /* the notice still reaches the agent */ } });
      sync.baseline();
      stop = watchFile(file, () => sync.check(), options.debounceMs);
    });
    pi.on('session_shutdown', () => { stop?.(); stop = undefined; });
    // The agent learns at its next turn which servers appeared or went away.
    pi.on('before_agent_start', () => pending.length ? { message: { customType: MCP_NOTICE_TYPE, content: pending.splice(0).join('\n'), display: false } } : undefined);
  }
  pi.registerTool({
    name: 'skills_on_disk', label: 'Skills on disk', exposure: 'deferred', annotations: { readOnlyHint: true },
    description: 'Skills created after this session started, which its skill list does not have. Without a name, lists them; with a name, returns that skill\'s instructions to follow now. Read-only, local.',
    parameters: Type.Object({ name: Type.Optional(Type.String({ description: 'Skill name to load' })) }, { additionalProperties: false }),
    async execute(_id, args, _signal, _update, ctx) {
      const loaded = pi.getCommands().filter(command => command.source === 'skill');
      const have = new Set(loaded.map(command => command.name.replace(/^skill:/, '')));
      const found = scanSkills(ctx.cwd, agentDir, loaded.map(command => command.sourceInfo.path));
      if (args.name === undefined) {
        const fresh = found.filter(skill => !have.has(skill.name));
        return text(fresh.length ? fresh.map(skill => `- ${skill.name}: ${skill.description} (${skill.filePath})`).join('\n') : 'No skill on disk is missing from this session.');
      }
      const skill = found.find(candidate => candidate.name === args.name);
      if (!skill) return text(`No skill named "${args.name}" on disk. Call without a name to list the new ones.`, true);
      const body = stripFrontmatter(readFileSync(skill.filePath, 'utf8')).trim();
      return text(`<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`);
    },
  });
}
