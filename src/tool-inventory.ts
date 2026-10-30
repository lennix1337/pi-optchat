import { Type } from 'typebox';
import type { ExtensionAPI, ExtensionContext, SourceInfo, ToolInfo } from '@earendil-works/pi-coding-agent';

// What the model can reach, where each tool comes from, what its declaration costs, and whether
// the instructions ever name it. A declared tool the instructions never mention tends to be
// forgotten: the model falls back to bash loops instead of the tool built for the job.

export interface ToolRow {
  name: string;
  source: string;
  exposure: ToolInfo['exposure'];
  /** Declared to the model on the next request (active and not hidden). */
  declared: boolean;
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

// Pi's default prompt lists declared tools with their snippets; those lines describe the tool, they do not route to it.
export function instructionText(systemPrompt: string): string {
  return systemPrompt.replace(/<tools>[\s\S]*?<\/tools>/g, '').replace(/<rules>[\s\S]*?<\/rules>/g, '');
}

export function names(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`).test(text);
}

const bytes = (value: unknown) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? ''), 'utf8');

export function inventory(tools: readonly ToolInfo[], active: readonly string[], systemPrompt: string): ToolRow[] {
  const text = instructionText(systemPrompt), declared = new Set(active);
  return tools.filter(tool => tool.exposure !== 'hidden').map(tool => ({
    name: tool.name,
    source: sourceOf(tool.sourceInfo),
    exposure: tool.exposure,
    declared: declared.has(tool.name),
    named: names(text, tool.name),
    bytes: bytes(tool.description) + bytes(tool.parameters) + bytes(tool.promptGuidelines ?? []),
    summary: (tool.description ?? '').split(/(?<=[.!?])\s|\n/)[0]!.slice(0, 120),
  })).sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}

/** Declared tools the instructions never name; builtins are described by Pi itself. */
export const unnamed = (rows: readonly ToolRow[]) => rows.filter(r => r.declared && !r.named && r.source !== 'builtin').map(r => r.name);

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

export function renderTools(rows: readonly ToolRow[]): string {
  const declared = rows.filter(r => r.declared), total = declared.reduce((sum, r) => sum + r.bytes, 0);
  const lines = [`Tools: ${rows.length} registered, ${declared.length} declared to the model (${kb(total)}, about ${Math.round(total / 4 / 100) / 10}k tokens per request), ${rows.length - declared.length} callable on demand.`];
  const sources = [...new Set(rows.map(r => r.source))];
  for (const source of sources) {
    const own = rows.filter(r => r.source === source);
    const on = own.filter(r => r.declared).map(r => `${r.name}${r.named ? '' : '*'} ${kb(r.bytes)}`);
    const off = own.filter(r => !r.declared).map(r => `${r.name} (${r.exposure})`);
    lines.push(`- ${source}: ${on.length ? on.join(', ') : 'none declared'}${off.length ? `; on demand: ${off.join(', ')}` : ''}`);
  }
  const missing = unnamed(rows);
  lines.push(missing.length
    ? `* Not named in the instructions (${missing.length}): ${missing.join(', ')}. Add them to the profile's Tool routing so the model knows when to use them.`
    : 'Every declared tool is named in the instructions.');
  return lines.join('\n');
}

export function registerToolInventory(pi: ExtensionAPI) {
  const rows = (ctx: ExtensionContext) => inventory(pi.getAllTools(), pi.getActiveTools(), ctx.getSystemPrompt());
  pi.registerCommand('tools', {
    description: 'List the tools the model can reach by package, their declaration size, and which ones the instructions never name',
    handler: async (_args, ctx) => ctx.ui.notify(renderTools(rows(ctx)), 'info'),
  });
  pi.registerTool({
    name: 'tool_inventory', label: 'Tool inventory', exposure: 'deferred', annotations: { readOnlyHint: true },
    description: 'Tools registered in this session: source package, exposure, declared or not, declaration bytes, and whether the instructions name them. Read-only, local.',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(_id, _args, _signal, _update, ctx) {
      const list = rows(ctx);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ tools: list, unnamed: unnamed(list) }) }], details: {} };
    },
  });
  // Once per distinct set, so a new package without a routing line is noticed the first time it loads.
  let noticed = '';
  pi.on('agent_start', (_event, ctx) => {
    const missing = unnamed(rows(ctx)), key = missing.join(',');
    if (key && key !== noticed) ctx.ui.notify(`Tools the instructions never name: ${missing.join(', ')}. /tools for details.`, 'warning');
    noticed = key;
  });
}
