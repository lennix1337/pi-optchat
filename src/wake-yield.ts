import { classifyTrigger } from './machine-turn-share.ts';

type ToolCall = { type?: string; name?: string; arguments?: { command?: string; action?: string } };
type Event = { type?: string; customType?: string; content?: string | { type?: string; text?: string }[]; timestamp?: string; message?: { role?: string; model?: string; content?: string | ToolCall[] } };
export type Wake = { start: string; messages: number; models: string[]; delivered: boolean };

function delivers(content: string | ToolCall[] | undefined): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(call => call.type === 'toolCall' && (
    (call.name === 'bash' && typeof call.arguments?.command === 'string' && /ship\.mjs|gh\s+pr\s+create|gh\s+pr\s+merge|git\s+commit/.test(call.arguments.command)) ||
    call.name === 'spawn' || (call.name === 'crew' && ['accept', 'spawn'].includes(call.arguments?.action ?? ''))
  ));
}

export function wakeYield(jsonl: string, start: number, end = Infinity): { wakes: Wake[]; summary: { wakes: number; delivered: number; without: number; messagesWithout: number; messages: number } } {
  const wakes: Wake[] = [];
  let current: Wake | undefined;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as Event;
    const time = Date.parse(event.timestamp ?? '');
    if (event.type === 'custom_message' && classifyTrigger(event) === 'heartbeat') {
      current = undefined;
      if (Number.isFinite(time) && time >= start && time <= end) {
        current = { start: event.timestamp!, messages: 0, models: [], delivered: false };
        wakes.push(current);
      }
    } else if (event.type === 'message' && event.message?.role === 'user' && classifyTrigger(event) === 'human') {
      current = undefined;
    } else if (current && event.type === 'message' && event.message?.role === 'assistant' && Number.isFinite(time) && time <= end) {
      current.messages++;
      const model = event.message.model || '(unknown model)';
      if (!current.models.includes(model)) current.models.push(model);
      current.delivered ||= delivers(event.message.content);
    }
  }
  const delivered = wakes.filter(w => w.delivered).length;
  return { wakes, summary: { wakes: wakes.length, delivered, without: wakes.length - delivered, messagesWithout: wakes.filter(w => !w.delivered).reduce((n, w) => n + w.messages, 0), messages: wakes.reduce((n, w) => n + w.messages, 0) } };
}
