export type Trigger = 'human' | 'machine' | 'heartbeat' | 'unknown' | 'worker';
type Content = string | { type?: string; text?: string }[];
type Event = { type?: string; customType?: string; content?: Content; timestamp?: string; message?: { role?: string; content?: Content; model?: string } };
export type Counts = Record<Trigger, number>;
export type Share = { total: number; machine: number };
export type Tally = { models: Map<string, Counts>; opusBefore: Share; opusAfter: Share; machineAfter: Map<string, number> };

const textOf = (content?: Content): string => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text ?? '').join('') : '';

export function classifyTrigger(event: Event): Trigger {
  const text = textOf(event.type === 'custom_message' ? event.content : event.message?.content);
  if (text.startsWith('[OptChat heartbeat]')) return 'heartbeat';
  // A subagent's final report is a manager decision, not a notice: wake-model.ts keeps it on the main model.
  if (event.customType === 'optchat-report' && /^\[[0-9a-f]{8}\] /.test(text)) return 'worker';
  if (['gitwatch', 'optchat-report', 'optchat-reload-resume'].includes(event.customType ?? '') ||
      ['[gitwatch]', '[optchat-reload-resume]', '[shell ', '[OptChat claim check]'].some(prefix => text.startsWith(prefix))) return 'machine';
  return event.type === 'message' && event.message?.role === 'user' ? 'human' : 'unknown';
}

export function tallySession(jsonl: string, start: number, cut?: number, end = Infinity): Tally {
  const result: Tally = { models: new Map(), opusBefore: { total: 0, machine: 0 }, opusAfter: { total: 0, machine: 0 }, machineAfter: new Map() };
  let trigger: Trigger = 'unknown';
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as Event;
    if (event.type === 'custom_message' || (event.type === 'message' && event.message?.role !== 'assistant' && event.message?.role !== 'toolResult')) {
      trigger = classifyTrigger(event);
    } else if (event.type === 'message' && event.message?.role === 'assistant') {
      const time = Date.parse(event.timestamp ?? '');
      if (!Number.isFinite(time) || time < start || time > end) continue;
      const model = event.message.model || '(unknown model)';
      const counts = result.models.get(model) ?? { human: 0, machine: 0, heartbeat: 0, unknown: 0, worker: 0 };
      counts[trigger]++;
      result.models.set(model, counts);
      if (cut !== undefined && time >= cut && trigger === 'machine') result.machineAfter.set(model, (result.machineAfter.get(model) ?? 0) + 1);
      if (model.startsWith('claude-opus') && cut !== undefined) {
        const share = time < cut ? result.opusBefore : result.opusAfter;
        share.total++;
        if (trigger === 'machine') share.machine++;
      }
    }
  }
  return result;
}
