import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext, SourceInfo, ToolInfo } from '@earendil-works/pi-coding-agent';
import { measureLoadedSkills, renderSkillBudget, skillBudget, skillLocations, type LoadedSkillEntry, type RegisteredSkill, type SkillBudgetReport } from './skill-budget.ts';





export interface ToolRow {
  name: string;
  source: string;
  exposure: ToolInfo['exposure'];
  /** Declared to the model on the next request (active, not hidden, and not a lazy tool). */
  declared: boolean;
  /** Active and callable from `codemode`, but its declaration is left out of requests (see lazy-tools.ts). */
  lazy: boolean;
  /** `name(arg, optional?)`: how a script calls it. */
  signature: string;
  /** Named somewhere in the instructions, skills or project context, outside tool definitions. */
  named: boolean;
  /** UTF-8 bytes of the declaration: description, parameter schema and prompt guidelines. */
  bytes: number;
  summary: string;
}

export function sourceOf(info: SourceInfo | undefined): string {
  if (!info) return 'unknown';
  if (info.path.startsWith('builtin:')) return 'builtin';
  const base = (value: string) => value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value;
  if (info.source.startsWith('npm:')) return info.source.slice(4).replace(/@[^@/]+$/, '') || info.source;
  if (info.baseDir) return base(info.baseDir);
  return /[\\/]/.test(info.source) ? base(info.source) : info.source;
}


export function instructionText(systemPrompt: string): string {
  return systemPrompt.replace(/<tools>[\s\S]*?<\/tools>/g, '').replace(/<rules>[\s\S]*?<\/rules>/g, '');
}

export function names(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`).test(text);
}

const bytes = (value: unknown) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? ''), 'utf8');

const signatureOf = (tool: ToolInfo) => {
  const schema = tool.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  const required = new Set(schema?.required ?? []);
  return `${tool.name}(${Object.keys(schema?.properties ?? {}).map(key => required.has(key) ? key : `${key}?`).join(', ')})`;
};

export function inventory(tools: readonly ToolInfo[], active: readonly string[], systemPrompt: string, lazy: ReadonlySet<string> = new Set()): ToolRow[] {
  const text = instructionText(systemPrompt), activeNames = new Set(active);
  // external: Pi scripts cannot call model-only tools.
  const hides = (tool: ToolInfo) => lazy.has(tool.name) && tool.exposure !== 'model-only';
  return tools.filter(tool => tool.exposure !== 'hidden').map(tool => ({
    name: tool.name,
    source: sourceOf(tool.sourceInfo),
    exposure: tool.exposure,
    declared: activeNames.has(tool.name) && !hides(tool),
    lazy: activeNames.has(tool.name) && hides(tool),
    signature: signatureOf(tool),
    named: names(text, tool.name),
    bytes: bytes(tool.description) + bytes(tool.parameters) + bytes(tool.promptGuidelines ?? []),
    summary: (tool.description ?? '').split(/(?<=[.!?])\s|\n/)[0]!.slice(0, 120),
  })).sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}

/** Declared tools the instructions never name; builtins are described by Pi itself. */
export const unnamed = (rows: readonly ToolRow[]) => rows.filter(r => r.declared && !r.named && r.source !== 'builtin').map(r => r.name);

/** Deferred and lazy extension tools stay out of the declarations; one line each keeps them known by name, a lazy one with its arguments.
 * MCP tools are excluded: their servers are already listed, and they can number in the dozens. */
export function onDemandIndex(rows: readonly ToolRow[]): string {
  const own = rows.filter(r => !r.declared && (r.lazy || r.exposure === 'deferred') && r.source !== 'builtin' && !r.name.startsWith('mcp__'));
  if (!own.length) return '';
  return ['Declared on demand to save tokens. Call them from `codemode` as `tools.<name>(args)`; `describeTool("<name>")` gives the arguments and the rules of use.',
    ...own.map(r => r.lazy ? `- ${r.signature}: ${r.summary.slice(0, 80)}` : `- ${r.name} (${r.source}): ${r.summary}`)].join('\n');
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

export function renderTools(rows: readonly ToolRow[], skills?: SkillBudgetReport): string {
  const declared = rows.filter(r => r.declared), total = declared.reduce((sum, r) => sum + r.bytes, 0);
  const lines = [`Tools: ${rows.length} registered, ${declared.length} declared to the model (${kb(total)}, about ${Math.round(total / 4 / 100) / 10}k tokens per request), ${rows.length - declared.length} callable on demand.`];
  const sources = [...new Set(rows.map(r => r.source))];
  for (const source of sources) {
    const own = rows.filter(r => r.source === source);
    const on = own.filter(r => r.declared).map(r => `${r.name}${r.named ? '' : '*'} ${kb(r.bytes)}`);
    const off = own.filter(r => !r.declared).map(r => `${r.name} (${r.lazy ? 'declaration hidden' : r.exposure})`);
    lines.push(`- ${source}: ${on.length ? on.join(', ') : 'none declared'}${off.length ? `; on demand: ${off.join(', ')}` : ''}`);
  }
  const missing = unnamed(rows);
  lines.push(missing.length
    ? `* Not named in the instructions (${missing.length}): ${missing.join(', ')}. Add them to the profile's Tool routing so the model knows when to use them.`
    : 'Every declared tool is named in the instructions.');
  if (skills) lines.push(renderSkillBudget(skills));
  return lines.join('\n');
}

export interface ToolInventoryOptions {
  /** Byte budget for skills list + loaded SKILL.md files (`0` disables flagging). */
  skillBudgetBytes?: () => number;
}

const registeredSkills = (pi: ExtensionAPI): RegisteredSkill[] => {
  if (typeof pi.getCommands !== 'function') return [];
  return pi.getCommands()
    .filter(command => command.source === 'skill')
    .map(command => ({
      name: command.name.replace(/^skill:/, ''),
      ...(command.sourceInfo?.path ? { location: command.sourceInfo.path } : {}),
    }));
};

export function registerToolInventory(pi: ExtensionAPI, lazy: () => ReadonlySet<string> = () => new Set(), options: ToolInventoryOptions = {}) {
  const rows = (ctx: ExtensionContext) => inventory(pi.getAllTools(), pi.getActiveTools(), ctx.getSystemPrompt(), lazy());
  let loadedSkills: LoadedSkillEntry[] = [];
  const skills = (ctx: ExtensionContext) => skillBudget({
    systemPrompt: ctx.getSystemPrompt(),
    loadedSkills,
    registeredSkills: registeredSkills(pi),
    budgetBytes: options.skillBudgetBytes?.(),
  });
  pi.on('context_with_system', (event, ctx) => {
    loadedSkills = measureLoadedSkills(event.messages, skillLocations(ctx.getSystemPrompt(), registeredSkills(pi)));
  });
  pi.on('session_start', () => { loadedSkills = []; });
  pi.on('session_shutdown', () => { loadedSkills = []; });
  pi.registerCommand('tools', {
    description: 'List the tools the model can reach by package, their declaration size, which ones the instructions never name, and skill prompt budget',
    handler: async (_args, ctx) => ctx.ui.notify(renderTools(rows(ctx), skills(ctx)), 'info'),
  });
  pi.registerTool({
    name: 'tool_inventory', label: 'Tool inventory', exposure: 'deferred', annotations: { readOnlyHint: true },
    description: 'Tools registered in this session (source, exposure, declaration bytes, unnamed) plus skill prompt bytes/tokens vs configured budget. Read-only, local.',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _args, _signal, _update, ctx) {
      const list = rows(ctx);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ tools: list, unnamed: unnamed(list), skills: skills(ctx) }) }], details: {} };
    },
  });


  pi.on('before_agent_start', event => {
    const index = onDemandIndex(inventory(pi.getAllTools(), pi.getActiveTools(), '', lazy()));
    if (index) event.systemPromptOptions.sections.on_demand_tools = index;
    else delete event.systemPromptOptions.sections.on_demand_tools;
  });

  let noticed = '';
  pi.on('agent_start', (_event, ctx) => {
    const missing = unnamed(rows(ctx)), key = missing.join(',');
    if (key && key !== noticed) ctx.ui.notify(`Tools the instructions never name: ${missing.join(', ')}. /tools for details.`, 'warning');
    noticed = key;
  });
}
