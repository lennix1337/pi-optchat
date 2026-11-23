import { acceptedPr } from './accepted-pr.ts';
import { ladderProposalLines } from './autonomy-ladder.ts';
import { readHeartbeat, type WakeRecord, type WakeSummary } from './heartbeat.ts';
import { addQueueItem, renderQueue } from './heartbeat-queue.ts';
import { memoryShapedReply } from './wake-noise.ts';

export { memoryShapedReply };


interface TurnMessage { role: string; content?: unknown; toolCallId?: string; isError?: boolean; stopReason?: string; errorMessage?: string }
interface Block { type?: string; text?: string; id?: string; name?: string; arguments?: { command?: unknown; action?: unknown } }

const blocks = (content: unknown): Block[] => Array.isArray(content) ? content.filter((b): b is Block => !!b && typeof b === 'object') : [];
const textOf = (content: unknown) => typeof content === 'string' ? content : blocks(content).filter(b => b.type === 'text').map(b => b.text ?? '').join('\n');
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();




const gitEffect = /\bgit\s+(?:-[cC]\s+\S+\s+)*(?:commit|push)\b|\bship\.mjs\b|\bgh\s+pr\s+merge\b/;
const MAX_COMMITS = 20;


function gitLines(output: string): string[] {
  const found: string[] = [];
  for (const m of output.matchAll(/^\[(.+?) ([0-9a-f]{7,40})\]/gm)) found.push(`commit ${m[2]} ${m[1].replace(/ \(root-commit\)$/, '')}`);
  for (const m of output.matchAll(/^[ +]\s*([0-9a-f]{7,40}\.{2,3}[0-9a-f]{7,40})\s+(\S+)\s+->/gm)) found.push(`push ${m[1]} ${m[2]}`);
  for (const m of output.matchAll(/^ \* \[new (?:branch|tag)\]\s+(\S+)\s+->/gm)) found.push(`push new ${m[1]}`);
  for (const m of output.matchAll(/^url: "(https:\/\/github\.com\/[^"\s]+\/pull\/\d+)"/gm)) found.push(`pr ${m[1]}`);
  return found;
}

/** The last reply, the number of tool calls and what one turn delivered: the commits and pushes of its successful bash/powershell git commands, and the PR each `crew` accept opened. */
export function summarizeTurn(messages: TurnMessage[]): WakeSummary {
  let tools = 0;
  const gitCalls = new Map<string, string>(), accepts = new Set<string>(), commits: string[] = [];
  const log = (line: string) => { if (!commits.includes(line) && commits.length < MAX_COMMITS) commits.push(line); };
  for (const message of messages) {
    if (message.role === 'assistant') for (const block of blocks(message.content)) {
      if (block.type !== 'toolCall') continue;
      tools++;
      const command = block.arguments?.command;
      if (block.id && ['bash', 'powershell'].includes(block.name ?? '') && typeof command === 'string' && gitEffect.test(command)) gitCalls.set(block.id, command.slice(command.search(gitEffect)));

      if (block.id && block.name === 'crew' && block.arguments?.action === 'accept') accepts.add(block.id);
    } else if (message.role === 'toolResult' && message.toolCallId && gitCalls.has(message.toolCallId) && !message.isError) {

      const lines = gitLines(textOf(message.content)), command = gitCalls.get(message.toolCallId) ?? '';
      for (const line of lines.length ? lines : [`ran ${oneLine(command).slice(0, 80)}`]) log(line);
    } else if (message.role === 'toolResult' && message.toolCallId && accepts.has(message.toolCallId) && !message.isError) {

      const pr = acceptedPr(textOf(message.content));
      if (pr) log(`pr ${pr.url}`);
    }
  }
  const last = messages.findLast(m => m.role === 'assistant');
  return { reply: last ? oneLine(textOf(last.content)) || oneLine(last.errorMessage ?? '') : '', tools, commits, ...last?.stopReason ? { stopReason: last.stopReason } : {} };
}

/** Sent once into the same wake when its reply was a memory line, whatever ran before it. */
export const MEMORY_REPLY_RETRY = '[OptChat heartbeat] Your wake reply was a memory summary line, and the operator reads that text as a broken answer. Reply again: if the wake still has work, do it with your tools; then end with a short report in Portuguese (pt-BR) in plain sentences, never in memory-line format (no `id+n|`, no `user:`/`talk:`/`echo:` tags).';

/** Sent once into the same wake when it settled having committed, pushed, opened or merged nothing (operator 08/11: "não quero que um wake não faça nada"). */
export const EMPTY_WAKE_RETRY = '[OptChat heartbeat] This wake is about to end without delivering a change: no commit, push, PR or merge. Measuring, re-reading state and reporting "nothing new" is not a wake (operator, 08/11: "não quero que um wake não faça nada"; explore new horizons). Keep going in this same wake: pick a new capability toward the end goal, a living assistant that helps the operator through his day on its own (notices what he needs, decides and acts without being asked), in the harness or a new package. Name its user-visible result and evidence, write the red test, build it, ship it as a PR with auto-merge, then report in Portuguese (pt-BR) what it does and how it was validated.';

/** Which nudges this wake already got; each goes at most once. */
export interface WakeRetried { memory?: boolean; empty?: boolean }

/** The nudge a settled wake gets: a memory-line reply, or no delivered change. Aborts and errors are not idleness. */
export function wakeRetry(summary: WakeSummary, retried: WakeRetried = {}): string | undefined {
  if (summary.stopReason === 'aborted' || summary.stopReason === 'error') return undefined;
  if (memoryShapedReply(summary.reply)) return retried.memory ? undefined : MEMORY_REPLY_RETRY;
  return summary.commits.length || retried.empty ? undefined : EMPTY_WAKE_RETRY;
}

/**
 * A settled wake is silent unless it delivered a change and its report reads as one: a wake either works and delivers, or says nothing
 * (operator, 15/11: "nao quero ser avisado de nada, só quero q vc trabalhe"). The text stays in the wake log; it is not posted.
 * An abort or an error is a failure the operator should see, not idleness.
 */
export function silentWake(summary: WakeSummary): boolean {
  if (summary.stopReason === 'aborted' || summary.stopReason === 'error') return false;
  return !summary.commits.length || memoryShapedReply(summary.reply);
}

export interface ReportContext { now: number; cap: number; minutes: number; wakes?: number[]; proposals?: string[] }

const DAY = 24 * 60 * 60_000, SHOWN_REPLY = 100;
const clock = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const cut = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

function wakeLine(wake: WakeRecord) {
  const trigger = wake.trigger === 'pre-triage' ? `pre-triage: ${cut(wake.reason, 80)}`
    : wake.trigger === 'check' ? `check: ${cut(wake.reason, 80)}`
    : wake.trigger === 'signal' ? cut(wake.reason, 80)
    : wake.trigger === 'build' ? 'build' : 'fixed schedule';
  if (wake.outcome === 'dropped') return [`  ${clock(wake.at)} ${trigger} → dropped`];
  const took = wake.endedAt === undefined ? '' : ` after ${Math.round((wake.endedAt - wake.at) / 60_000)} min, ${plural(wake.tools ?? 0, 'tool')}`;
  const outcome = wake.outcome === 'running' ? 'still running' : wake.outcome === 'unsettled' ? 'never settled' : wake.outcome === 'error' ? `ended on an error${took}` : `${wake.outcome}${took}`;
  const reply = wake.reply ? `: ${cut(wake.reply, SHOWN_REPLY)}` : '';
  return [`  ${clock(wake.at)} ${trigger} → ${outcome}${reply}`, ...wake.commits?.length ? [`    commits: ${wake.commits.join('; ')}`] : []];
}

/** Today's wakes (local calendar day), oldest first, and what is left of the rolling 24-hour wake budget. */
export function renderReport(log: WakeRecord[], { now, cap, minutes, wakes, proposals }: ReportContext) {
  const today = log.filter(wake => new Date(wake.at).toDateString() === new Date(now).toDateString());
  const todayWakes = today.filter(wake => wake.outcome !== 'dropped');
  const used = (wakes ?? log.filter(wake => wake.outcome !== 'dropped').map(wake => wake.at)).filter(at => now - at < DAY).length;
  const head = `${minutes > 0 ? `Heartbeat every ${minutes} min` : 'Heartbeat is off (see Heartbeat in /optchat settings)'}: ${todayWakes.length ? `${plural(todayWakes.length, 'wake')} today` : 'no wakes today'} · ${Math.max(0, cap - used)} of ${cap} wakes left in 24 h`;
  return [head, ...today.flatMap(wakeLine), ...proposals?.length ? ['', ...proposals] : []].join('\n');
}

/** `/heartbeat [report | queue | add <text>]`: the text to show. */
export function heartbeatCommand(args: string, { dir, ...context }: ReportContext & { dir: string }) {
  const text = args.trim(), add = /^add(?:\s+([^]*))?$/.exec(text);
  if (add) { addQueueItem(dir, add[1] ?? ''); return `Added to the heartbeat work queue: ${oneLine(add[1] ?? '')}`; }
  if (text === 'queue') return renderQueue(dir);
  if (text === '' || text === 'report') { const saved = readHeartbeat(dir); return renderReport(saved.wakeLog, { ...context, wakes: saved.wakes, proposals: context.proposals ?? ladderProposalLines(dir, context.now) }); }
  throw new Error('Usage: /heartbeat [report | queue | add <text>]');
}
