import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth, type Component } from '@earendil-works/pi-tui';

/**
 * Tool rows the agent ran back to back, with no text of its own between them, fold into the last one:
 * a summary line ("6 chamadas · bash ×3 · read ×2 · 14,2 s") over that call's title. A running call or
 * one that failed keeps its full row; ctrl+o (or a click on the row) shows every call as before.
 */

type Resolver = Parameters<ExtensionAPI['registerToolRenderer']>[0];
type Renderers = NonNullable<ReturnType<Resolver>>;
type CallRenderer = NonNullable<Renderers['renderCall']>;
type ResultRenderer = NonNullable<Renderers['renderResult']>;
type Theme = Parameters<CallRenderer>[1];
type Context = Parameters<CallRenderer>[2];

interface Member { name: string; group: Group; finished: boolean; error: boolean; ms?: number }
interface Group { ids: string[] }
interface RowState { finished?: boolean; error?: boolean; partial?: boolean; expanded?: boolean; hasResult?: boolean; pad?: number; theme?: Theme; title?: Component; result?: Component; baseShell?: string }

/** Which visible group each tool call belongs to, rebuilt from the session and extended as messages end. */
export class ToolGroups {
  private members = new Map<string, Member>();
  private open: Group | undefined;

  reset() { this.members.clear(); this.open = undefined; }
  /** Text the agent wrote, a user message or any other entry shown in the chat ends the run of calls. */
  close() { this.open = undefined; }

  add(message: unknown) {
    const m = message as { role?: string; content?: unknown };
    if (m?.role === 'toolResult') return;
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) { this.close(); return; }
    for (const block of m.content as Array<{ type?: string; text?: string; id?: string; name?: string }>) {
      if (block.type === 'text' && block.text?.trim()) this.close();
      else if (block.type === 'toolCall' && typeof block.id === 'string' && !this.members.has(block.id)) {
        this.open ??= { ids: [] };
        this.open.ids.push(block.id);
        this.members.set(block.id, { name: block.name ?? '?', group: this.open, finished: false, error: false });
      }
    }
  }

  load(entries: readonly unknown[]) {
    this.reset();
    for (const entry of entries as Array<{ type?: string; message?: unknown }>) {
      if (entry.type === 'message') this.add(entry.message);
      else if (entry.type === 'custom_message' || entry.type === 'compaction' || entry.type === 'branch_summary') this.close();
    }
  }

  note(id: string, state: { finished: boolean; error: boolean; ms?: number }) {
    const member = this.members.get(id);
    if (member) Object.assign(member, state);
  }

  /** `hidden`: folded into a later call; `summary`: the last call of a run of two or more that shows the run. */
  role(id: string): 'alone' | 'hidden' | 'summary' {
    const member = this.members.get(id);
    if (!member || member.group.ids.length < 2) return 'alone';
    const last = member.group.ids.at(-1) === id;
    if (last) return 'summary';
    return member.finished && !member.error ? 'hidden' : 'alone';
  }

  summary(id: string) {
    const ids = this.members.get(id)?.group.ids ?? [];
    const counts = new Map<string, number>();
    let ms = 0, errors = 0, running = 0;
    for (const other of ids) {
      const m = this.members.get(other)!;
      counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
      ms += m.ms ?? 0;
      if (m.error) errors++;
      if (!m.finished) running++;
    }
    const names = [...counts].map(([name, n]) => n > 1 ? `${name} ×${n}` : name).join(' · ');
    return { calls: ids.length, names, seconds: ms / 1000, errors, running };
  }
}

/** The configured key of app.tools.expand; Pi versions without keyHint in the render context show ctrl+o. */
const expandHint = (ctx: Context) => `(${(ctx as { keyText?: (id: string) => string }).keyText?.('app.tools.expand') || 'ctrl+o'} expande)`;

const seconds = (s: number) => s < 0.05 ? '' : `${s.toFixed(1).replace('.', ',')} s`;

/** One framed slice of a row: the call slot draws the top padding, the result slot the bottom one. */
class Slot implements Component {
  constructor(private draw: (width: number) => string[]) {}
  render(width: number) { return this.draw(width); }
  invalidate() {}
}

function frame(state: RowState, width: number, inner: string[], top: boolean, bottom: boolean) {
  const theme = state.theme!, pad = state.pad ?? 1;
  const bg = state.partial ? 'toolPendingBg' : state.error ? 'toolErrorBg' : 'toolSuccessBg';
  const line = (text: string) => {
    const body = ' '.repeat(pad) + text;
    return theme.bg(bg, body + ' '.repeat(Math.max(0, width - visibleWidth(body))));
  };
  return [...(top ? [line('')] : []), ...inner.map(line), ...(bottom ? [line('')] : [])];
}

function fallbackCall(name: string): CallRenderer {
  return (args, theme) => {
    const json = JSON.stringify(args ?? {});
    return new Slot(width => [truncateToWidth(`${theme.fg('toolTitle', theme.bold(name))} ${theme.fg('muted', json === '{}' ? '' : json)}`, width)]);
  };
}

const fallbackResult: ResultRenderer = (result, { expanded }, theme) => {
  const text = (result.content ?? []).flatMap(c => c.type === 'text' ? [c.text] : []).join('\n');
  const lines = text ? text.split('\n') : [];
  const shown = expanded ? lines : lines.slice(0, 10);
  const more = lines.length - shown.length;
  return new Slot(width => [...shown.map(l => truncateToWidth(theme.fg('toolOutput', l), width)), ...(more > 0 ? [theme.fg('muted', `... (${more} more lines)`)] : [])]);
};

export function groupedRenderers(name: string, base: Renderers | undefined, groups: ToolGroups): Renderers {
  const baseCall = base?.renderCall ?? fallbackCall(name), baseResult = base?.renderResult ?? fallbackResult;
  const selfShell = base?.renderShell === 'self';
  const hidden = (ctx: Context, state: RowState) => !state.expanded && state.finished && groups.role(ctx.toolCallId) === 'hidden';
  const folded = (ctx: Context, state: RowState) => !state.expanded && !state.partial && !state.error && groups.role(ctx.toolCallId) === 'summary';
  return {
    renderShell: 'self',
    renderCall(args, theme, ctx) {
      const state = ctx.state as RowState;
      // HTML export renders every call as partial: only the live TUI marks a row finished, so exports never fold.
      Object.assign(state, { finished: !ctx.isPartial, error: ctx.isError, partial: ctx.isPartial, expanded: ctx.expanded, pad: ctx.outputPad, theme, baseShell: base?.renderShell });
      if (!ctx.isPartial) groups.note(ctx.toolCallId, { finished: true, error: ctx.isError, ms: ctx.durationMs });
      state.title = baseCall(args, theme, { ...ctx, lastComponent: state.title });
      return new Slot(width => {
        if (hidden(ctx, state)) return [];
        const inner = width - 2 * (state.pad ?? 1);
        if (!folded(ctx, state)) {
          const lines = state.title!.render(selfShell ? width : inner);
          return selfShell ? lines : frame(state, width, lines, true, !state.hasResult);
        }
        const s = groups.summary(ctx.toolCallId);
        const parts = [`${s.calls} chamadas`, s.names, seconds(s.seconds), s.errors ? theme.fg('error', `${s.errors} com erro`) : ''].filter(Boolean);
        const head = `${theme.fg('toolTitle', '▸')} ${theme.fg('muted', parts.join(' · '))} ${theme.fg('dim', expandHint(ctx))}`;
        const title = state.title!.render(inner - 2)[0] ?? '';
        return frame(state, width, [truncateToWidth(head, inner), truncateToWidth(`${theme.fg('dim', '└')} ${title}`, inner)], true, true);
      });
    },
    renderResult(result, options, theme, ctx) {
      const state = ctx.state as RowState;
      state.hasResult = true;
      state.result = baseResult(result, options, theme, { ...ctx, lastComponent: state.result });
      return new Slot(width => {
        if (hidden(ctx, state) || folded(ctx, state)) return [];
        if (selfShell) return state.result!.render(width);
        return frame(state, width, state.result!.render(width - 2 * (state.pad ?? 1)), false, true);
      });
    },
  };
}

/** Folds back-to-back tool rows in the TUI; PI_TOOL_GROUPS=0 keeps every row as Pi draws it. */
export function mountToolGroups(pi: ExtensionAPI) {
  if (process.env.PI_TOOL_GROUPS === '0') return;
  const groups = new ToolGroups();
  pi.registerToolRenderer((name, next) => groupedRenderers(name, next(), groups));
  const load = (_event: unknown, ctx: ExtensionContext) => { groups.load(ctx.sessionManager.getBranch()); };
  pi.on('session_start', load);
  pi.on('session_tree', load);
  pi.on('message_end', event => { groups.add(event.message); });
}
