import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { textContent } from '../src/transcript.ts';
import { emptyUsage } from '../src/usage.ts';

// Kept apart from support.ts: support.ts is the `--import` preload that sandboxes the environment, and must not evaluate product modules before it does.

/** A user message; the default timestamp is the one every fixture request carries. */
export const userMessage = (content: UserMessage['content'], timestamp = 1): UserMessage => ({ role: 'user', content, timestamp });

/** An assistant message from the offline `fixture` provider; `content` and `stopReason` are the only things a test varies. */
export const assistantMessage = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({
  role: 'assistant', content, timestamp: 2, stopReason, api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: emptyUsage(),
});

/** The assistant turn that asks for one tool call with no arguments. */
export const toolCallMessage = (id: string, name: string): AssistantMessage => assistantMessage([{ type: 'toolCall', id, name, arguments: {} }], 'toolUse');

export const toolResultMessage = (toolCallId: string, toolName: string, text: string, { isError = false, timestamp = 3 } = {}): ToolResultMessage => ({
  role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text }], isError, timestamp,
});

/** A message another extension sent; `display: false` makes it hidden from the user but still model context. */
export const customMessage = (customType: string, content: Extract<AgentMessage, { role: 'custom' }>['content'], display = true): Extract<AgentMessage, { role: 'custom' }> =>
  ({ role: 'custom', customType, content, display, timestamp: 1 });

/** The text of each user message, in order. */
export const userTexts = (messages: readonly AgentMessage[]): string[] => messages.filter(m => m.role === 'user').map(m => textContent(m.content));
