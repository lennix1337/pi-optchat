import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { getToolStateChanges, type SystemMessage, type Tool } from '@earendil-works/pi-ai';
import { isView } from './memory.ts';

type Sections = Readonly<Record<string, string | null | undefined>>;
interface State { prompt: string; tools: readonly Tool[]; sections: Sections }
/** The head a cache entry was written with, kept in the session so a reload sends the same one. */
export type SavedHead = Readonly<State & { model: string }>;
const isSaved = (value: unknown): value is SavedHead => {
  const v = value as Partial<SavedHead> | null;
  return typeof v === 'object' && v !== null && typeof v.prompt === 'string' && typeof v.model === 'string' && Array.isArray(v.tools)
    && typeof v.sections === 'object' && v.sections !== null;
};
export interface HeadOptions {
  /** `provider/id`: another model has no entry to keep. */
  model: string;
  /** The model takes later system messages in place ({@link nativeHead}). */
  native: boolean;
  /** The prefix's entry has expired: rewriting the head costs nothing more. */
  cold: boolean;
  /** Changes when the view is captured again (a new turn, a refresh): everything after it is written again anyway. */
  epoch: number;
  /** Pi's current prompt sections, replayed from the session's system messages. */
  sections: Sections;
}

/**
 * Whether Pi sends this model later system messages in place, so the head can stay as its cache entry was written. Tool
 * changes need no flag of their own: Pi sends them natively where the API allows (Anthropic tool blocks, Responses
 * `additional_tools`) and otherwise falls back to the current tool list, which the head would have sent anyway.
 */
export const nativeHead = (compat: Readonly<Record<string, unknown>>) => compat.supportsMidConvoSystemMessages === true;

const text = (content: SystemMessage['content']) => typeof content === 'string' ? content : content.map(block => block.text).join('');
const holdsView = (message: AgentMessage) => (message.role === 'user' || message.role === 'custom') && Array.isArray(message.content)
  && message.content.some(block => block.type === 'text' && isView(block.text));

/** The change from one state to another as a system message Pi sends in place: tools added, withdrawn or redefined, and prompt
 * sections updated. Undefined when the prompt changed in a way no section update explains. */
function change(from: State, to: State, timestamp: number): { message?: SystemMessage } | undefined {
  const { toolsAdded, toolsRemoved } = getToolStateChanges(from.tools, to.tools);
  const sections: Record<string, string | null> = {};
  if (from.prompt !== to.prompt) {
    let prompt = from.prompt;
    for (const name of new Set([...Object.keys(from.sections), ...Object.keys(to.sections)])) {
      const old = from.sections[name], now = to.sections[name] ?? null;
      if (old === now || !old) continue;
      const at = prompt.indexOf(old);
      // A section the prompt does not hold verbatim (the working directory goes after the view) needs no update.
      if (at < 0 || prompt.indexOf(old, at + 1) >= 0) continue;
      prompt = prompt.slice(0, at) + (now ?? '') + prompt.slice(at + old.length);
      sections[name] = now;
    }
    if (prompt !== to.prompt) return undefined;
  }
  if (!toolsAdded.length && !toolsRemoved.length && !Object.keys(sections).length) return {};
  return { message: { role: 'system', content: '', ...(Object.keys(sections).length ? { sections } : {}),
    ...(toolsAdded.length ? { toolsAdded } : {}), ...(toolsRemoved.length ? { toolsRemoved } : {}), timestamp } };
}

/**
 * Keeps the request's leading system message, and with it the tool list before it, as it was when its cache entry was written.
 * Anthropic caches tools, then the system prompt, then messages: a tool enabled mid-session (web_enable, a goal's tools) or an
 * edited AGENTS.md otherwise rewrites the whole request, view included. Later changes go after the view instead, as the system
 * messages Pi sends natively (`tool_addition`, `tool_removal`, section updates): a change from earlier turns right after the
 * message that holds the view, a change during this turn where it happened, so every message sent before stays in place.
 * The head is rebuilt only when its entry is gone anyway (cold cache, another model) or the model has no such messages.
 */
export class StableHead {
  private base?: SavedHead;
  private last?: State;
  private epoch?: number;
  /** From the base to the state when the view was captured; sent right after it. */
  private turn?: SystemMessage;
  /** Changes during this turn, each before the first message newer than the one it followed. */
  private changes: SystemMessage[] = [];

  /** The current base, the same object until the head is rewritten. */
  saved(): SavedHead | undefined { return this.base; }

  /** Takes the base a previous process saved (anything else clears it): the next request compares Pi's state with it. */
  restore(saved: unknown) {
    this.base = isSaved(saved) ? saved : undefined;
    this.last = this.base; this.epoch = undefined; this.turn = undefined; this.changes = [];
  }

  apply(messages: AgentMessage[], options: HeadOptions): AgentMessage[] {
    const [head, ...rest] = messages;
    if (head?.role !== 'system') return messages;
    const current: State = { prompt: text(head.content), tools: head.toolsAdded ?? [], sections: options.sections };
    const reset = () => { this.base = { ...current, model: options.model }; this.last = current; this.epoch = options.epoch; this.turn = undefined; this.changes = []; return messages; };
    if (!options.native || options.cold || !this.base || this.base.model !== options.model) return reset();
    const anchor = rest.findIndex(holdsView);
    if (this.epoch !== options.epoch) {
      const turn = change(this.base, current, anchor >= 0 ? rest[anchor].timestamp : 0);
      if (!turn) return reset();
      this.turn = turn.message; this.changes = []; this.last = current; this.epoch = options.epoch;
    } else {
      const step = change(this.last!, current, Math.max(0, ...rest.map(message => message.timestamp)));
      if (!step) return reset();
      if (step.message) this.changes.push(step.message);
      this.last = current;
    }
    const out: AgentMessage[] = [{ ...head, content: this.base.prompt, toolsAdded: [...this.base.tools] }, ...rest];
    if (!this.base.tools.length) delete (out[0] as SystemMessage).toolsAdded;
    for (const message of this.changes) {
      // Before the first message after the one it followed; a status line (timestamp 0) at the end stays last.
      let at = out.findIndex((m, j) => j > anchor + 1 && m.role !== 'system' && m.timestamp > message.timestamp);
      if (at < 0) at = out.at(-1)?.timestamp === 0 && out.length > anchor + 2 ? out.length - 1 : out.length;
      out.splice(at, 0, message);
    }
    if (this.turn) out.splice(anchor + 2, 0, this.turn);
    return out;
  }
}
