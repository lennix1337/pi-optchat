import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { shortModel } from './agent-rows.ts';
import { quotaWindows, type QuotaWindowRow } from './quota-history.ts';
import { resetText } from './quota-format.ts';

/**
 * The one-line footer under the editor, in Portuguese: the model and its thinking level, the cache hit of the last call, today's spend,
 * the context used of its limit, the account's quota windows with their reset time (Brasília) and the goal extension's state. It replaces
 * Pi's built-in footer (git branch, token totals, model name).
 */
export interface FooterQuota { label: string; w5h?: QuotaWindowRow; w7d?: QuotaWindowRow }
export interface FooterInput {
  now: number;
  /** The session's model id and thinking level. */
  model?: { id: string; thinking?: string };
  /** Share of the last call's prompt read from the provider cache, 0..1. */
  cacheHit?: number;
  /** Dollars spent today, from the usage ledger. */
  spend?: number;
  /** Context tokens in use (unknown right after a compaction) and the model's window. */
  context?: { tokens: number | null; window: number };
  quota?: FooterQuota;
  /** What the goal extension published with `setStatus('goal', …)`. */
  goalStatus?: string;
}
type Tone = 'dim' | 'warning' | 'error';
interface Segment { text: string; tone?: Tone; drop: number }

/** `$44,9`, `$3,25`: one decimal from ten dollars up, two below. */
export const dollars = (value: number) => `$${value.toFixed(value >= 10 ? 1 : 2).replace('.', ',')}`;
/** `197k`, `1M`, `1,5M`. */
export function tokens(n: number) {
  if (n >= 1e6) return `${(Math.round(n / 1e5) / 10).toString().replace('.', ',')}M`;
  return n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n));
}
/**
 * The goal extension's status as the footer's meta slot. The extension words it already (`meta: 1 aberta · /goal-focus`), so it is shown as it
 * came; only the older English form (`goal: unfocused [2 open] - /goal-focus`) is translated. Nothing when it is empty.
 */
export function metaText(status: string | undefined) {
  const text = status?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (/^meta:/i.test(text)) return text;
  const open = /^goal:\s*unfocused\s*\[(\d+) open\]\s*-\s*(\S+)/i.exec(text);
  return open ? `meta: ${open[1]} ${open[1] === '1' ? 'aberta' : 'abertas'} · ${open[2]}` : `meta: ${text.replace(/^goal:\s*/i, '')}`;
}
/** The text of a goal status event; undefined when the payload is not one. An empty text is an answer: the goal has nothing to show. */
export function goalEventText(data: unknown) {
  const text = record(data).text;
  return typeof text === 'string' ? text : undefined;
}
/** `Claude`, `GPT`, else the provider id: what the operator calls the account's family. */
export function familyLabel(model: string | undefined, provider: string | undefined) {
  const name = shortModel(model ?? '');
  return /claude|opus|sonnet|haiku/i.test(model ?? '') ? 'Claude' : /gpt|codex|^o\d/i.test(name) ? 'GPT' : provider ?? name;
}
/** `opus-5-5 high`, `gpt-6.1-sol xhigh`: the model id without its provider or `claude-` prefix, then the thinking level. */
export function modelText(id: string, thinking?: string) {
  const name = id.slice(id.indexOf('/') + 1).replace(/^claude-/, '').replace(/[\x00-\x20\x7f-\x9f]/g, '') || 'modelo?';
  return thinking ? `${name} ${thinking}` : name;
}
/** Cache hit of the last assistant reply on the branch: tokens read from cache over the whole prompt; undefined when none is found. */
export function lastCacheHit(sessionManager: Pick<ExtensionContext['sessionManager'], 'getLeafEntry' | 'getEntry'>, maxSteps = 400): number | undefined {
  let entry = sessionManager.getLeafEntry() as { type?: string; parentId?: string | null; message?: { role?: string; usage?: { input?: number; cacheRead?: number; cacheWrite?: number } } } | undefined;
  for (let step = 0; entry && step < maxSteps; step++) {
    const usage = entry.type === 'message' && entry.message?.role === 'assistant' ? entry.message.usage : undefined;
    if (usage) {
      const read = usage.cacheRead ?? 0, prompt = (usage.input ?? 0) + read + (usage.cacheWrite ?? 0);
      if (prompt > 0) return read / prompt;
    }
    entry = entry.parentId ? sessionManager.getEntry(entry.parentId) as typeof entry : undefined;
  }
  return undefined;
}
const quotaTone = (used: number): Tone | undefined => used >= 95 ? 'error' : used >= 80 ? 'warning' : undefined;
/** A window that already renewed is an old reading: it shows `?` rather than a use that no longer holds. */
const windowPart = (name: string, w: QuotaWindowRow, now: number, reset: boolean): Pick<Segment, 'text' | 'tone'> =>
  w.resetAt <= now ? { text: `${name} ?` } : { text: `${name} ${Math.round(w.used)}%${reset ? ` (${resetText(w.resetAt, now)})` : ''}`, tone: quotaTone(w.used) };

/** The footer's parts, the least important first to go when the terminal is narrow (`drop` high goes first). */
export function footerSegments(input: FooterInput): Segment[] {
  const { now, quota, context } = input, out: Segment[] = [];
  if (input.model) out.push({ text: modelText(input.model.id, input.model.thinking), drop: 0 });
  if (input.cacheHit !== undefined) out.push({ text: `cache ${Math.round(input.cacheHit * 100)}%`, tone: input.cacheHit < 0.5 ? 'warning' : undefined, drop: 2.5 });
  if (input.spend !== undefined) out.push({ text: `${dollars(input.spend)} hoje`, drop: 1 });
  if (context?.window) {
    const used = context.tokens === null ? undefined : context.tokens / context.window * 100;
    out.push({ text: `contexto ${context.tokens === null ? '?' : tokens(context.tokens)}/${tokens(context.window)}`, tone: used !== undefined && used >= 80 ? used >= 95 ? 'error' : 'warning' : undefined, drop: 3 });
  }
  if (quota?.w5h) out.push({ ...windowPart(`${quota.label} 5h`, quota.w5h, now, true), drop: 2 });
  if (quota?.w7d) out.push({ ...windowPart(quota.w5h ? '7d' : `${quota.label} 7d`, quota.w7d, now, !quota.w5h), drop: 4 });
  const meta = metaText(input.goalStatus);
  if (meta) out.push({ text: meta, tone: 'dim', drop: 5 });
  return out;
}

/** The footer line for `width`, dropping the least important parts until it fits; `hint` goes to the right edge when there is room. */
export function footerLine(input: FooterInput, width: number, color: (tone: string, text: string) => string, hint = '') {
  let segments = footerSegments(input);
  const SEP = ' · ', plain = (list: Segment[]) => list.map(s => s.text).join(SEP);
  while (segments.length > 1 && visibleWidth(plain(segments)) > width) {
    const worst = Math.max(...segments.map(s => s.drop));
    segments = segments.filter(s => s.drop !== worst);
  }
  const body = segments.map(s => s.tone ? color(s.tone, s.text) : s.text).join(color('dim', SEP));
  const gap = width - visibleWidth(plain(segments)) - visibleWidth(hint);
  return truncateToWidth(hint && gap >= 3 ? `${body}${' '.repeat(gap)}${color('dim', hint)}` : body, width);
}

/** The footer's two rows: a rule and the line. */
export function footerRows(input: FooterInput, width: number, color: (tone: string, text: string) => string, hint = '') {
  return [color('dim', '─'.repeat(Math.max(0, width))), footerLine(input, width, color, hint)];
}

const TTL_MS = 10_000;
/** Where the footer's numbers come from; every one may be missing, and a failing source only hides its part. */
export interface FooterSources {
  /** Dollars spent today. */
  spend: () => number | undefined;
  /** The quota cache (`QUOTA_FILE`) as read. */
  quotaState: () => unknown;
  hint?: string;
  now?: () => number;
  /** The session's thinking level (`pi.getThinkingLevel`). */
  thinking?: () => string | undefined;
  /** Pi's event bus: the goal extension announces its status there (`GOAL_STATUS_EVENT`), already worded in Portuguese. */
  events?: { on(channel: string, handler: (data: unknown) => void): () => void };
}
/** The goal extension's channel (pi-goal-x `GOAL_STATUS_EVENT`); its payload is `{ text, focused, open }`. */
export const GOAL_STATUS_EVENT = 'goal-x:status:v1';
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const attempt = <T>(read: () => T): T | undefined => { try { return read(); } catch { return undefined; } };

/** The input from the session and the sources. Spend and quota are read at most once per `TTL_MS`. */
export class FooterState {
  private at = -Infinity;
  private spend: number | undefined;
  private state: unknown;
  constructor(private readonly ctx: Pick<ExtensionContext, 'getContextUsage' | 'model'> & Partial<Pick<ExtensionContext, 'sessionManager'>>, private readonly sources: FooterSources) {}
  input(goalStatus: string | undefined): FooterInput {
    const now = this.sources.now?.() ?? Date.now();
    if (now - this.at > TTL_MS || now < this.at) { this.at = now; this.spend = attempt(this.sources.spend); this.state = attempt(this.sources.quotaState); }
    const usage = attempt(() => this.ctx.getContextUsage()), model = attempt(() => this.ctx.model);
    const window = usage?.contextWindow ?? model?.contextWindow;
    const windows = model ? quotaWindows(record(record(this.state).usageByProvider)[model.provider]) : {};
    const thinking = attempt(() => this.sources.thinking?.()), cacheHit = this.ctx.sessionManager ? attempt(() => lastCacheHit(this.ctx.sessionManager!)) : undefined;
    return { now, spend: this.spend, ...model ? { model: { id: model.id, thinking } } : {}, ...cacheHit !== undefined ? { cacheHit } : {}, ...window ? { context: { tokens: usage?.tokens ?? null, window } } : {},
      ...model && (windows.w5h || windows.w7d) ? { quota: { label: familyLabel(model.id, model.provider), ...windows } } : {}, goalStatus };
  }
}

/** Replaces Pi's footer with ours; the returned function puts it back. Only with a UI to draw on. */
export function mountFooter(ctx: ExtensionContext, sources: FooterSources) {
  if (!ctx.hasUI) return () => {};
  const state = new FooterState(ctx, sources);
  let announced: string | undefined;
  const stopGoal = sources.events?.on(GOAL_STATUS_EVENT, data => { announced = goalEventText(data) ?? announced; });
  ctx.ui.setFooter((tui, theme, data) => {
    const timer = setInterval(() => tui.requestRender(), 5000); timer.unref();
    const stopBranch = data.onBranchChange(() => tui.requestRender());
    return {
      invalidate() {},
      dispose() { clearInterval(timer); stopBranch(); },
      render: (width: number) => footerRows(state.input(announced ?? data.getExtensionStatuses().get('goal')), width, (tone, text) => theme.fg(tone as 'dim', text), sources.hint),
    };
  });
  return () => { stopGoal?.(); ctx.ui.setFooter(undefined); };
}
