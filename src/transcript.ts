import { createHash } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { getCurrentSystemMessage, type SystemMessage, type UserMessage } from '@earendil-works/pi-ai';
import { CAP, PAGE, cap, end, flat, isView, mostDue, start, type Memory, type Part } from './memory.ts';
import { estimatedContextTokens } from './run-context.ts';
import { STATUS_NOTE } from './prompts.ts';
import { record } from './cache.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import { imageRef, isImage } from './images.ts';

export const RUN_BOUNDARY = 'optchat.run';
/** Subagent traffic to the main agent: a custom message on screen, a plain user message to the model, `work` in memory. */
export const REPORT_TYPE = 'optchat-report';
export const REPORT_RECEIPT = 'report:';
/** A report's receipt in memory: it marks the entry as `work` and keeps a restart from delivering the report twice. */
export const reportReceipt = (text: string) => REPORT_RECEIPT + createHash('sha256').update(text).digest('hex');

export function textContent(content: unknown, images = true): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: unknown) => {
    if (typeof part !== 'object' || part === null) return '';
    if ('type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string') return part.text;
    if (images && isImage(part)) return imageRef(part);
    return '';
  }).filter(Boolean).join('\n');
}
/** What the user typed, as Pi's input event (and so the inbox) saw it: no image references, and without the
 * `[Image …]` notes Pi appends after the text when it resizes, converts or omits an attached image. */
export function typedText(content: unknown) {
  const text = textContent(content, false);
  return { text, bare: text.replace(/\n\n\[Image[ :][^\n]*\](?:\n\[Image[ :][^\n]*\])*$/, '') };
}
/** Pi's convertToLlm sends every custom message to the model as a user message. A shown one is part of the chat, so it
 * becomes a user message here too; another extension's starts with "[customType] ", as the recipe marks background work, so
 * the compactor never takes it for the user's words. A hidden one (display false), such as context an extension injects
 * each turn, stays custom: the model still sees it, and memory and the replay leave it out. Reports reach the model and the
 * previous-exchange replay as user messages; memory logs them as `work`. */
export function asUser(message: AgentMessage): AgentMessage {
  if (message.role !== 'custom' || !message.display) return message;
  const { content, customType, timestamp } = message;
  if (customType === REPORT_TYPE) return { role: 'user', content, timestamp };
  const tag = `[${customType}] `;
  if (typeof content === 'string') return { role: 'user', content: tag + content, timestamp };
  const [first, ...rest] = content;
  if (first?.type === 'text') return { role: 'user', content: [{ ...first, text: tag + first.text }, ...rest], timestamp };
  return { role: 'user', content: [{ type: 'text', text: tag.trimEnd() }, ...content], timestamp };
}
/** A long text is never cut: it is logged as several messages in a row (recipe §1), each as long as one zoom page. */
export function pieces(text: string) {
  const parts: string[] = [];
  for (let at = 0; at < text.length;) {
    let to = Math.min(text.length, at + PAGE);
    if (to < text.length && /[\ud800-\udbff]/.test(text[to - 1])) to--;
    parts.push(text.slice(at, to)); at = to;
  }
  return parts.length ? parts : [text];
}
/** Per-turn state goes after the view, never in the system prompt, so the prompt is cached regardless of working directory. */
export function stateless(prompt: string) {
  const section = /\n*<cwd>\n([^\n]*)\n<\/cwd>/.exec(prompt);
  return section ? { prompt: prompt.replace(section[0], ''), state: `Working directory: ${section[1]}` } : { prompt, state: undefined };
}
export function logMessage(memory: Memory, message: AgentMessage, receipt?: string, original?: AgentMessage) {
  const date = new Date(message.timestamp).toISOString();
  if (message.role === 'user') for (const text of pieces(textContent(message.content))) memory.append(receipt?.startsWith(REPORT_RECEIPT) ? 'work' : 'user', text, date, receipt);
  else if (message.role === 'assistant') {
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim()) for (const text of pieces(block.text)) memory.append('talk', text, date);
      if (block.type === 'toolCall') memory.append('tool', `${block.name} ${JSON.stringify(block.arguments)}`, date);
    }
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      memory.append('echo', `Agent ${message.stopReason}: ${message.errorMessage ?? 'No further details'}`, date);
  } else if (message.role === 'toolResult') {
    // Persist the original result; zoom pages it on demand, while boundedMessage keeps the live request small.
    const result = original?.role === 'toolResult' ? original : message;
    memory.append('echo', `${result.toolName}: ${textContent(result.content, result.toolName !== 'zoom')}`, date);
  }
}
export function boundedMessage(message: AgentMessage): AgentMessage {
  if (message.role !== 'toolResult') return message;
  const text = message.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (text.length <= CAP) return message;
  return { ...message, content: [{ type: 'text', text: cap(text) }, ...message.content.filter(c => c.type === 'image')] };
}
/** The caller supplies a single settled run, including any steering after text-only replies. */
function completedExchange(history: readonly AgentMessage[]) {
  const last = history.findLastIndex(m => m.role === 'user' || m.role === 'assistant');
  const answer = history[last];
  if (answer?.role !== 'assistant' || answer.stopReason !== 'stop'
    || answer.content.some(block => block.type === 'toolCall')) return [];
  const content = answer.content.flatMap(block => block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : []);
  if (!content.some(block => block.text.trim())) return [];
  const requests: UserMessage[] = [];
  for (const message of history.slice(0, last)) {
    if (message.role === 'user') requests.push({ ...message, content: textContent(message.content) });
  }
  if (!requests.length) return [];
  return [...requests, { ...answer, content }];
}

/** Default limit in bytes of text (16 KB, ~4,000 tokens). Most exchanges are 1-7 KB; a larger one, usually a big paste, is
 * left out entirely and the model falls back to its summaries in the memory view, zooming for the full text if it needs it. */
export const PREVIOUS_EXCHANGE = DEFAULT_SETTINGS.previousExchangeKB * 1000;

/** The latest successful run on this branch, skipping failed and unfinished runs; none if it is over `limit` bytes. */
export function previousExchange(branch: readonly SessionEntry[], limit = PREVIOUS_EXCHANGE) {
  const exchange = latestExchange(branch);
  const bytes = exchange.reduce((sum, message) => sum + Buffer.byteLength(textContent(message.content)), 0);
  return bytes <= limit ? exchange : [];
}

function latestExchange(branch: readonly SessionEntry[]) {
  let end = -1;
  let legacyEnd = branch.length;
  const messages = (entries: readonly SessionEntry[]) => entries.flatMap(entry => entry.type === 'message' ? [asUser(entry.message)] : entry.type === 'custom_message' ? [asUser({ role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, timestamp: Date.parse(entry.timestamp) })] : []);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry.type !== 'custom' || entry.customType !== RUN_BOUNDARY || !record(entry.data)) continue;
    legacyEnd = i;
    if (entry.data.state === 'end') end = i;
    else if (entry.data.state === 'start') {
      if (end >= 0) {
        const exchange = completedExchange(messages(branch.slice(i + 1, end)));
        if (exchange.length) return exchange;
      }
      end = -1;
    }
  }
  // Older sessions have no run markers. Recover a successful exchange best-effort;
  // text-only steering boundaries cannot be reconstructed for those old runs.
  const legacy = messages(branch.slice(0, legacyEnd));
  let boundary = 0;
  let latest: ReturnType<typeof completedExchange> = [];
  for (let i = 0; i < legacy.length; i++) {
    const message = legacy[i];
    if (message.role !== 'assistant' || message.stopReason === 'toolUse') continue;
    const exchange = completedExchange(legacy.slice(boundary, i + 1));
    if (exchange.length) latest = exchange;
    boundary = i + 1;
  }
  return latest;
}

/** Ends every subagent report, so the parent knows it can check the report against what the child did. */
export const fullChat = (id: string) => `Full chat: zoom("${id}")`;
export const withoutFullChat = (text: string) => text.replace(/\n\nFull chat: zoom\("[\w-]+"\)$/gm, '');
const TASK = '\n</chat>\n\nYour task:\n';
/** Tool-call entries are capped so a page holds many steps; tool-result text stays complete for paging. */
const STEP = 1_000;
/** A text-only subagent transcript for zoom(agent): tool-result text is complete, but image blocks are omitted. */
export function runTranscript(messages: readonly AgentMessage[]) {
  const task = messages.find(message => message.role === 'user');
  return messages.flatMap(message => {
    if (message.role === 'user') {
      // Only the task prompt holds the memory view (src/agents.ts): `${view}\n\nYour task:\n${task}`.
      const text = textContent(message.content, false), at = text.indexOf(TASK);
      return [`user|${message === task && isView(text) && at >= 0 ? text.slice(at + '\n</chat>\n\n'.length) : text}`];
    }
    if (message.role === 'toolResult') return [`echo|${message.toolName}: ${textContent(message.content, false)}`];
    if (message.role !== 'assistant') return [];
    return [...message.content.flatMap(block => block.type === 'text' && block.text.trim() ? [`talk|${block.text}`]
      : block.type === 'toolCall' ? [`tool|${cap(`${block.name} ${JSON.stringify(block.arguments)}`, STEP)}`] : []),
    ...message.stopReason === 'error' || message.stopReason === 'aborted' ? [`echo|Agent ${message.stopReason}: ${message.errorMessage ?? 'No further details'}`] : []];
  }).join('\n');
}

/** The status line naming running agents by id and the first words of their task, and running background shells by id and command; none while nothing runs. */
export function atWork(runs: readonly { id: string; task: string }[], shells: readonly { id: string; command: string }[] = []) {
  if (!runs.length && !shells.length) return undefined;
  const brief = (text: string) => {
    const words = flat(text).replaceAll('"', "'").split(/\s+/).filter(Boolean), start = words.slice(0, 6).join(' ');
    // Six words, but never more than 60 characters: a task can be one long word.
    const preview = [...start].slice(0, 60).join('');
    return `"${preview}${words.length > 6 || preview.length < start.length ? '…' : ''}"`;
  };
  const parts = [
    ...runs.length ? [`Agents at work now: ${runs.map(({ id, task }) => `${id} ${brief(task)}`).join(', ')}.`] : [],
    ...shells.length ? [`Shells running now: ${shells.map(({ id, command }) => `${id} ${brief(command)}`).join(', ')}.`] : [],
  ];
  return STATUS_NOTE + parts.join(' ');
}

/** Label wake-only inputs independently of the message that carries the historical view. */
function labelWakeEvents(run: AgentMessage[]): AgentMessage[] {
  if (run.some(message => message.role === 'user')) return run;
  return run.map(message => {
    if (message.role !== 'custom') return message;
    const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    return { ...message, content: [{ type: 'text' as const,
      text: `Extension event (${message.customType}), not a new user instruction or authorization:\n\n` }, ...content] };
  });
}

/** Keep one completed exchange plus the current run; all other history comes from the view.
 * `state` follows the view; `status` goes last after cached content and only with new input. */
export function buildContext(canonical: AgentMessage[], run: AgentMessage[], view: string, prompt: string,
  previous: readonly AgentMessage[] = [], state?: string, status?: string, focus?: string): AgentMessage[] {
  // `context_with_system` supplies the live system/tool deltas; replay them so Pi and our estimator receive the same active schemas.
  const system = getCurrentSystemMessage(canonical);
  const head: SystemMessage = { role: 'system', content: prompt, toolsAdded: system?.toolsAdded, timestamp: 0 };
  // Hidden extension messages can start native background-completion runs too. Keep them custom:
  // display is a UI choice, not an indication that Pi has no current input.
  if (!run.some(m => m.role === 'user' || m.role === 'custom'))
    throw new Error('OptChat has no current input message; refusing to send historical context.');
  const inputs = labelWakeEvents(run);
  const history = [...previous, ...inputs].filter(m => m.role !== 'system');
  const anchor = history.find(m => m.role === 'user') ?? inputs.find(m => m.role === 'custom');
  const messages = history.map(message => {
    if (message !== anchor || message.role !== 'user' && message.role !== 'custom') return message;
    // OpenAI joins text blocks with nothing between them, so the user's words start their own paragraph after the view.
    const content = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    const paragraph = <T extends (typeof content)[number]>(block: T): T => block.type === 'text' ? { ...block, text: `\n\n${block.text}` } : block;
    const [first, ...rest] = content;
    return { ...message, content: [{ type: 'text' as const, text: view }, ...(focus ? [{ type: 'text' as const, text: `\n\n${focus}` }] : []),
      ...(state ? [{ type: 'text' as const, text: `\n\n${state}` }] : []),
      ...(first ? [paragraph(first)] : []), ...rest] };
  });
  return [head, ...messages, ...status && messages.at(-1)?.role !== 'toolResult' ? [{ role: 'user' as const, content: [{ type: 'text' as const, text: status }], timestamp: 0 }] : []];
}

const VIEW_OPEN = '<chat>\n';
const VIEW_CLOSE = '\n</chat>';
/** Parses the captured tiled view, excluding entries logged after it was rendered. */
function viewParts(view: string) {
  if (!isView(view) || !view.endsWith(VIEW_CLOSE)) return;
  const body = view.slice(VIEW_OPEN.length, -VIEW_CLOSE.length), lines = body ? body.split('\n') : [];
  const parts: { part: Part; text: string }[] = [];
  let covered = 0;
  for (const line of lines) {
    const match = /^(\d+)\+(\d+)\|(.*)$/.exec(line);
    if (!match) return;
    const at = Number(match[1]), size = Number(match[2]), level = Math.log2(size);
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(size) || size < 1 || !Number.isInteger(level) || at % size) return;
    const part = { l: level, i: at / size };
    if (start(part) !== covered) return;
    covered = end(part);
    parts.push({ part, text: match[3] });
  }
  return parts;
}
/** Estimates the complete assembled request and coarsens only through already-built summary nodes. */
export function budgetContext(memory: Memory, canonical: AgentMessage[], run: AgentMessage[], view: string, prompt: string, inputBudget: number,
  previous: readonly AgentMessage[] = [], state?: string, status?: string, focus?: string): { messages: AgentMessage[]; tokens: number; fits: boolean } {
  // Focus is expendable retrieval detail: omit it before coarsening any chronological history.
  if (focus) {
    const messages = buildContext(canonical, run, view, prompt, previous, state, status, focus);
    const tokens = estimatedContextTokens(messages);
    if (tokens <= inputBudget) return { messages, tokens, fits: true };
  }
  const build = (text: string) => buildContext(canonical, run, text, prompt, previous, state, status);
  let messages = build(view), tokens = estimatedContextTokens(messages), best = { messages, tokens, fits: tokens <= inputBudget };
  if (best.fits) return best;
  const lines = viewParts(view);
  if (!lines) return best;
  const parts = lines.map(line => line.part);
  while (parts.length > 1) {
    const at = mostDue(parts, end(parts.at(-1)!), part => !!memory.node(part));
    if (at < 0) break;
    const first = parts[at], parent = { l: first.l + 1, i: first.i / 2 };
    const summary = memory.node(parent);
    if (!summary) break;
    parts.splice(at, 2, parent);
    lines.splice(at, 2, { part: parent, text: flat(summary.text) });
    const text = `${VIEW_OPEN}${lines.map(({ part, text: line }) => `${start(part)}+${2 ** part.l}|${line}`).join('\n')}${VIEW_CLOSE}`;
    messages = build(text); tokens = estimatedContextTokens(messages);
    if (tokens <= inputBudget) return { messages, tokens, fits: true };
    if (tokens < best.tokens) best = { messages, tokens, fits: false };
  }
  return best;
}

/** Pi's own estimate for an image when it decides to compact: 4,800 characters, about 1,200 tokens. */
const IMAGE_CHARS = 4_800;
/** Characters a message adds to a request: its text, thinking, tool-call arguments and images, as Pi estimates them. Framing is left out. */
export function messageChars(message: AgentMessage) {
  if (!('content' in message)) return 0;
  const { content } = message;
  if (typeof content === 'string') return content.length;
  return content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : block.type === 'thinking' ? block.thinking.length
    : block.type === 'toolCall' ? JSON.stringify(block.arguments).length : block.type === 'image' ? IMAGE_CHARS : 0), 0);
}
/** The share of the model's window the current turn's verbatim messages may fill before they move into memory (#146): the
 * profile's Turn refresh threshold, unless `OPTCHAT_REFRESH_AT` gives one (0 turns it off). */
export function refreshFraction(setting: number, env = process.env.OPTCHAT_REFRESH_AT) {
  const override = env?.trim() ? Number(env) : NaN;
  return Number.isFinite(override) ? override : setting;
}
/** That share in characters, at ~4 characters a token; none when off or the window is unknown. */
export function refreshBudget(contextWindow: number | undefined, fraction: number) {
  return contextWindow && fraction > 0 ? Math.floor(contextWindow * fraction * 4) : undefined;
}
const chars = (messages: readonly AgentMessage[]) => messages.reduce((sum, m) => sum + messageChars(m), 0);
/** The run's current input: its first user message, or when a hidden extension message (a background wake) started it, its first custom one. */
const currentTask = (run: readonly AgentMessage[]) => run.find(m => m.role === 'user') ?? run.find(m => m.role === 'custom');
/** Where a refresh would cut the run: the last model reply, so its tool calls and their results stay whole. 0 when there is none after the task. */
export function lastStep(run: readonly AgentMessage[]) {
  const current = currentTask(run), task = current ? run.indexOf(current) : -1, step = run.findLastIndex(m => m.role === 'assistant');
  return step > task && task >= 0 ? step : 0;
}
/** The run's new `keep` and the size it moves into the view, when what is sent since the last refresh passes the budget.
 * What stays verbatim (the task and the last step) must fit in half the budget: a bigger last step, such as many parallel
 * reads, would otherwise pass the budget again on the next call and refresh every call. It waits for a smaller step instead. */
export function refreshPoint(run: readonly AgentMessage[], keep: number, budget: number | undefined) {
  const cut = lastStep(run), task = currentTask(run);
  if (!budget || cut <= keep) return undefined;
  const size = chars(run.slice(keep));
  if (size <= budget || (task ? messageChars(task) : 0) + chars(run.slice(cut)) > budget / 2) return undefined;
  return { cut, size };
}
/** The task, all live user/custom instructions, and the newest whole exchange stay exact across refresh. */
export function refreshedRun(run: readonly AgentMessage[], keep: number, note: string): AgentMessage[] {
  const task = currentTask(run);
  if (!keep || !task) return [...run];
  const retained = [...run.slice(0, keep).filter(message => message === task || message.role === 'user' || message.role === 'custom'),
    ...run.slice(keep).filter(message => message !== task)];
  const content = typeof task.content === 'string' ? [{ type: 'text' as const, text: task.content }] : task.content;
  const refreshedTask = { ...task, content: [...content, { type: 'text' as const, text: `\n\n${note}` }] };
  const taskAt = retained.indexOf(task);
  if (taskAt < 0) retained.unshift(refreshedTask);
  else retained[taskAt] = refreshedTask;
  return retained;
}
