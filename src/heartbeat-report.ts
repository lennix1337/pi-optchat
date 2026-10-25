import { readHeartbeat, type WakeRecord, type WakeSummary } from './heartbeat.ts';
import { addQueueItem, renderQueue } from './heartbeat-queue.ts';

/** The parts of Pi's messages a woken turn is read from. */
interface TurnMessage { role: string; content?: unknown; toolCallId?: string; isError?: boolean; stopReason?: string; errorMessage?: string }
interface Block { type?: string; text?: string; id?: string; name?: string; arguments?: { command?: unknown } }

const blocks = (content: unknown): Block[] => Array.isArray(content) ? content.filter((b): b is Block => !!b && typeof b === 'object') : [];
const textOf = (content: unknown) => typeof content === 'string' ? content : blocks(content).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

// `git commit`, `git -C dir push`, `git -c k=v commit`, anywhere in a shell command.
const gitEffect = /\bgit\s+(?:-[cC]\s+\S+\s+)*(?:commit|push)\b/;
const MAX_COMMITS = 20;

/** `commit <sha> <branch>`, `push <old>..<new> <branch>` or `push new <branch>` for each one git printed. */
function gitLines(output: string): string[] {
  const found: string[] = [];
  for (const m of output.matchAll(/^\[(.+?) ([0-9a-f]{7,40})\]/gm)) found.push(`commit ${m[2]} ${m[1].replace(/ \(root-commit\)$/, '')}`);
  for (const m of output.matchAll(/^[ +]\s*([0-9a-f]{7,40}\.{2,3}[0-9a-f]{7,40})\s+(\S+)\s+->/gm)) found.push(`push ${m[1]} ${m[2]}`);
  for (const m of output.matchAll(/^ \* \[new (?:branch|tag)\]\s+(\S+)\s+->/gm)) found.push(`push new ${m[1]}`);
  return found;
}

/** The last reply, the number of tool calls and the commits and pushes (from successful bash/powershell git commands) of one turn. */
export function summarizeTurn(messages: TurnMessage[]): WakeSummary {
  let tools = 0;
  const gitCalls = new Set<string>(), commits: string[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') for (const block of blocks(message.content)) {
      if (block.type !== 'toolCall') continue;
      tools++;
      const command = block.arguments?.command;
      if (block.id && ['bash', 'powershell'].includes(block.name ?? '') && typeof command === 'string' && gitEffect.test(command)) gitCalls.add(block.id);
    } else if (message.role === 'toolResult' && message.toolCallId && gitCalls.has(message.toolCallId) && !message.isError)
      for (const line of gitLines(textOf(message.content))) if (!commits.includes(line) && commits.length < MAX_COMMITS) commits.push(line);
  }
  const last = messages.findLast(m => m.role === 'assistant');
  return { reply: last ? oneLine(textOf(last.content)) || oneLine(last.errorMessage ?? '') : '', tools, commits, ...last?.stopReason ? { stopReason: last.stopReason } : {} };
}

export interface ReportContext { now: number; cap: number; minutes: number; /** Every wake of the daily cap's count; without it the report counts the logged wakes. */ wakes?: number[] }

const DAY = 24 * 60 * 60_000, SHOWN_REPLY = 100;
const clock = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const cut = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

function wakeLine(wake: WakeRecord) {
  const trigger = wake.trigger === 'check' ? `check: ${cut(wake.reason, 80)}` : 'fixed schedule';
  const took = wake.endedAt === undefined ? '' : ` after ${Math.round((wake.endedAt - wake.at) / 60_000)} min, ${plural(wake.tools ?? 0, 'tool')}`;
  const outcome = wake.outcome === 'running' ? 'still running' : wake.outcome === 'unsettled' ? 'never settled' : wake.outcome === 'error' ? `ended on an error${took}` : `${wake.outcome}${took}`;
  const reply = wake.reply ? `: ${cut(wake.reply, SHOWN_REPLY)}` : '';
  return [`  ${clock(wake.at)} ${trigger} → ${outcome}${reply}`, ...wake.commits?.length ? [`    commits: ${wake.commits.join('; ')}`] : []];
}

/** Today's wakes (local calendar day), oldest first, and what is left of the rolling 24-hour wake budget. */
export function renderReport(log: WakeRecord[], { now, cap, minutes, wakes }: ReportContext) {
  const today = log.filter(wake => new Date(wake.at).toDateString() === new Date(now).toDateString());
  const used = (wakes ?? log.map(wake => wake.at)).filter(at => now - at < DAY).length;
  const head = `${minutes > 0 ? `Heartbeat every ${minutes} min` : 'Heartbeat is off (see Heartbeat in /optchat settings)'}: ${today.length ? `${plural(today.length, 'wake')} today` : 'no wakes today'} · ${Math.max(0, cap - used)} of ${cap} wakes left in 24 h`;
  return [head, ...today.flatMap(wakeLine)].join('\n');
}

/** `/heartbeat [report | queue | add <text>]`: the text to show. */
export function heartbeatCommand(args: string, { dir, ...context }: ReportContext & { dir: string }) {
  const text = args.trim(), add = /^add(?:\s+([^]*))?$/.exec(text);
  if (add) { addQueueItem(dir, add[1] ?? ''); return `Added to the heartbeat work queue: ${oneLine(add[1] ?? '')}`; }
  if (text === 'queue') return renderQueue(dir);
  if (text === '' || text === 'report') { const saved = readHeartbeat(dir); return renderReport(saved.wakeLog, { ...context, wakes: saved.wakes }); }
  throw new Error('Usage: /heartbeat [report | queue | add <text>]');
}
