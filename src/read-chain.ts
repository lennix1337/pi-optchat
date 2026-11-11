import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { onlyReads } from './crew.ts';

/** Tools that only read, whatever their input. */
const READ_TOOLS = new Set(['read', 'read_many', 'grep', 'find', 'ls', 'zoom', 'date', 'output_read', 'project_evidence', 'shell_status', 'ripwire', 'specialist_memory']);
/** For these tools only some actions read. */
const READ_ACTIONS: Record<string, (action: unknown) => boolean> = {
  crew: action => action === 'list' || action === 'read' || action === 'view' || action === 'zoom',
  commitments: action => action === 'list',
  gitwatch: action => action === undefined || action === 'status',
  lsp: action => typeof action === 'string' && action !== 'rename',
};

export type ToolCall = { id?: string; name: string; input?: unknown };

/** Whether one tool call only reads. Anything unknown, or bash that is not plainly reading, is not. */
export function isReadOnlyCall(call: ToolCall): boolean {
  if (READ_TOOLS.has(call.name)) return true;
  const input = call.input && typeof call.input === 'object' ? call.input as Record<string, unknown> : {};
  if (call.name === 'bash') return typeof input.command === 'string' && onlyReads(input.command);
  return READ_ACTIONS[call.name]?.(input.action) === true;
}

export const BATCH_HINT = '[batch] Two lone reads in a row: put the next independent reads in one reply (parallel calls, read_many, or one codemode script).';

/** Counts consecutive turns whose only tool call reads. */
export class ReadChain {
  private length = 0;
  private hinted = false;
  /** The call whose result carries the hint. */
  private target: string | undefined;
  reset() { this.length = 0; this.hinted = false; this.target = undefined; }
  /** One finished assistant turn: its tool calls (none when it only answered). */
  turn(calls: ToolCall[]) {
    this.target = undefined;
    if (calls.length !== 1 || !isReadOnlyCall(calls[0]!)) { this.length = 0; this.hinted = false; return; }
    if (++this.length >= 2 && !this.hinted) { this.hinted = true; this.target = calls[0]!.id ?? calls[0]!.name; }
  }
  /** Whether this tool result is the one that carries the hint; true once per chain. A failed result keeps its text exact: the next lone read carries the hint instead. */
  claim(id: string | undefined, name: string, failed = false) {
    if (this.target === undefined || this.target !== (id ?? name)) return false;
    this.target = undefined;
    if (failed) this.hinted = false;
    return !failed;
  }
}

/** The main session's reminder to batch independent reads: appended once per chain to the result of the second lone read. */
export function registerReadChainHint(pi: ExtensionAPI, enabled: () => boolean = () => true) {
  const chain = new ReadChain();
  pi.on('agent_start', () => chain.reset());
  pi.on('message_end', ({ message }) => {
    if (message.role !== 'assistant') return;
    const parts = Array.isArray(message.content) ? message.content : [];
    if (!enabled()) return chain.reset();
    chain.turn(parts.filter(part => part.type === 'toolCall').map(part => ({ id: part.id, name: part.name, input: part.arguments })));
  });
  pi.on('tool_result', event => {
    if (!enabled() || !chain.claim(event.toolCallId, event.toolName, event.isError)) return;
    return { content: [...event.content, { type: 'text' as const, text: `\n${BATCH_HINT}` }] };
  });
}
