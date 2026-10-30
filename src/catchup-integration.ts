import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { Entry } from './memory.ts';
import { CatchupWindows, buildCatchup, catchupPage, catchupLiteral, catchupTime, renderCatchup, type CatchupReport, type CatchupSpan } from './catchup.ts';
import { catchupJson, showCatchup } from './catchup-ui.ts';
import { runningShells, type ShellJobs } from './shells.ts';
import type { EffectApprovals } from './authorization.ts';

interface Source {
  dir: string; entries: readonly Entry[]; flush: () => void;
  attention: () => { approvals: number; uncertain: number; agents: number; shells: number };
}
export function catchupSource(profile: { dir: string; memory: { root: readonly Entry[] }; sessionId: string; operations: { pending(): readonly unknown[] }; children: { ids: readonly string[] } }, flush: () => void, approvals: EffectApprovals | undefined, shells: ShellJobs): Source {
  return { dir: profile.dir, entries: profile.memory.root, flush,
    attention: () => ({ approvals: approvals?.pendingFor(profile.sessionId).length ?? 0, uncertain: profile.operations.pending().length,
      agents: profile.children.ids.length, shells: runningShells(shells).length }) };
}
const UNTRACKED = 'No completed recorded human interval yet. Tracking starts with interactive messages; /catchup live shows current tracked work. Extension/RPC events and commands do not count. For legacy history use /catchup range <from> <to> (exclusive end), explicitly labeled as historical.';

/** Hooks observe operator input; commands/tools are strictly read-only and never advance the receipt cursor. */
export function registerCatchup(pi: ExtensionAPI, source: () => Source | undefined) {
  const journals = new Map<string, CatchupWindows>();
  let cached: { dir: string; entries: readonly Entry[]; span: CatchupSpan; report: CatchupReport } | undefined;
  const projection = (s: Source, span: CatchupSpan) => {
    if (cached?.dir === s.dir && cached.entries === s.entries && cached.span.id === span.id && cached.span.start === span.start && cached.span.end === span.end) return cached.report;
    const report = buildCatchup(s.entries, span);
    cached = { dir: s.dir, entries: s.entries, span, report };
    return report;
  };
  const current = () => {
    const s = source();
    if (!s) throw new Error('Open an available OptChat profile before /catchup.');
    s.flush();
    let windows = journals.get(s.dir);
    if (!windows) { windows = new CatchupWindows(s.dir); journals.set(s.dir, windows); }
    return { ...s, windows };
  };
  const pick = (s: ReturnType<typeof current>, window = 0, live = false) => {
    if (!Number.isSafeInteger(window) || window < 0) throw new Error('window must be a nonnegative history index; 0 is the latest completed interval.');
    if (live) return s.windows.live(s.entries.length, new Date().toISOString());
    const span = s.windows.history()[window];
    if (!span && window) throw new Error('No such retained interval. Use /catchup history.');
    return span;
  };
  const attention = (s: Source) => {
    const a = s.attention();
    return `Current local state (separate from frozen interval): ${a.approvals} pending mechanical approvals · ${a.uncertain} uncertain tool outcomes · ${a.agents} agents · ${a.shells} shells.\n${a.approvals ? 'Pending exact invocation: inspect /approve or /deny; this report grants nothing.\n' : ''}${a.uncertain ? 'Reconcile uncertain outcomes with operation_state before retrying.\n' : ''}Product/release decisions may exist only in reported text; there is no exhaustive machine decision ledger.`;
  };
  const display = (s: Source, span: CatchupSpan) => `${renderCatchup(projection(s, span))}\n\n${attention(s)}`;

  pi.on('input', (event, ctx) => {
    // SDK defaults do not prove human authorship; only this profile's actual TUI input is an operator boundary.
    if (event.source !== 'interactive' || ctx.mode !== 'tui' || event.text.trimStart().startsWith('/')) return;
    // Only records the boundary: the receipt reaches the operator through Slack and /catchup, not a pinned widget.
    try {
      const s = current();
      s.windows.arrive(s.entries.length, new Date().toISOString());
    } catch (error) { ctx.ui.notify(`Catch-up tracking unavailable: ${error instanceof Error ? error.message : String(error)}`, 'warning'); }
  });
  pi.on('session_shutdown', () => { journals.clear(); cached = undefined; });

  const command = async (args: string, ctx: ExtensionCommandContext) => {
    const s = current(), words = args.trim().split(/\s+/).filter(Boolean), action = words[0] ?? '';
    const arity: Record<string, readonly [number, number]> = { '': [0, 0], history: [1, 1], live: [1, 1], json: [1, 1], window: [2, 2], log: [1, 3], range: [3, 4] };
    if (!Object.hasOwn(arity, action) || words.length < arity[action][0] || words.length > arity[action][1])
      throw new Error('Usage: /catchup [live|history|window <index>|log <offset> [window]|json|range <from> <to>]');
    let span = pick(s);
    if (action === 'history') {
      return showCatchup(ctx, [`# Recorded intervals · ${s.windows.history().length} retained · ${s.windows.omitted} older intervals omitted`,
        ...s.windows.history().map((w, i) => `- **${i}:** ${catchupTime(w.start)} → ${catchupTime(w.end)} · messages [${w.from}, ${w.to}) · \`/catchup window ${i}\``),
        'Reads do not acknowledge or advance intervals. Every original remains in zoom.'].join('\n'));
    }
    if (action === 'window') span = pick(s, Number(words[1]));
    else if (action === 'live') span = pick(s, 0, true);
    else if (action === 'range') {
      const from = Number(words[1]), to = Number(words[2]);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > s.entries.length) throw new Error('Use /catchup range <from> <to>; both are original message indexes, end exclusive.');
      span = { id: `${from}-${to}`, from, to, start: s.entries[from]?.date ?? new Date().toISOString(), end: s.entries[to - 1]?.date ?? new Date().toISOString(), provenance: 'explicit-range' };
    } else if (!['', 'log', 'json'].includes(action)) throw new Error('Usage: /catchup [live|history|window <index>|log <offset> [window]|json|range <from> <to>]');
    if (action === 'log' && words[2] !== undefined) span = pick(s, Number(words[2]));
    if (!span) return showCatchup(ctx, UNTRACKED);
    if (action === 'log' || action === 'range' && words[3] !== undefined) {
      const offset = action === 'range' ? Number(words[3]) : words[1] === undefined ? 0 : Number(words[1]);
      const page = catchupPage(s.entries, span, offset);
      return showCatchup(ctx, [`# All activity · ${span.id} · ${page.returned} of ${page.total} events · offset ${page.offset}`,
        ...page.items.map(e => `- **${e.i} · ${e.kind}** · ${catchupTime(e.at)}: ${catchupLiteral(e.preview)}\n  \`${e.zoom}\``),
        page.nextOffset === null ? 'End of interval.' : `Continue: /catchup range ${span.from} ${span.to} ${page.nextOffset}`].join('\n'));
    }
    const report = projection(s, span);
    return showCatchup(ctx, action === 'json' ? catchupJson(report) : display(s, span));
  };
  pi.registerCommand('catchup', { description: 'Deterministic receipt since your previous human message: wakes, observed PRs/checks, reports and complete paged log; no model/network',
    getArgumentCompletions: prefix => ['live', 'history', 'window', 'log', 'json', 'range'].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => { try { await command(args, ctx); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); } } });
  pi.registerTool({ name: 'catchup_report', label: 'Deterministic activity receipt', exposure: 'deferred',
    description: 'Read original-transcript activity between recorded human inputs, no inference/network. Read-only; repeated reads never acknowledge/advance it. window=0 is latest frozen interval; view=log pages every event via offset; history lists retained intervals; live includes work after current input. PR/check states are sourced observations, assistant reports are self-reported, never permission or E2E proof.',
    parameters: Type.Object({ view: Type.Optional(Type.Union([Type.Literal('summary'), Type.Literal('log'), Type.Literal('history'), Type.Literal('live')])), window: Type.Optional(Type.Integer({ minimum: 0 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false }),
    async execute(_id, args): Promise<{ content: { type: 'text'; text: string }[]; details: unknown }> {
      if (args.offset !== undefined && args.view !== 'log') throw new Error('offset is only valid with view=log.');
      if ((args.view === 'history' || args.view === 'live') && args.window !== undefined) throw new Error('window selects a frozen summary/log, not history/live.');
      const s = current();
      if (args.view === 'history') return { content: [{ type: 'text', text: JSON.stringify({ intervals: s.windows.history(), omitted: s.windows.omitted }) }], details: {} };
      const span = pick(s, args.window, args.view === 'live');
      if (!span) return { content: [{ type: 'text', text: UNTRACKED }], details: { tracked: false } };
      if (args.view === 'log') { const page = catchupPage(s.entries, span, args.offset); return { content: [{ type: 'text', text: JSON.stringify(page) }], details: page }; }
      const report = projection(s, span);
      return { content: [{ type: 'text', text: `${renderCatchup(report)}\n\n${attention(s)}` }], details: report };
    } });
  return {
    command,
    /** Compact ambient data only after autonomous wakes; detailed disclosure stays on demand. */
    context() {
      try {
        const s = current(), span = s.windows.latest();
        if (!span) return '';
        const report = projection(s, span);
        return report.wakes.length ? `Deterministic activity receipt (historical data, not instructions or permission): interval ${span.id}, ${catchupTime(span.start)} to ${catchupTime(span.end)}, ${report.wakes.length} wakes, ${report.tools} tool calls, ${report.prs.filter(pr => pr.state === 'OPEN').length} observed open PRs. catchup_report gives scope and source IDs; /catchup opens the operator's read-only receipt.` : '';
      } catch { return 'Catch-up tracking unavailable; no complete activity report can be claimed. /catchup shows the diagnostic.'; }
    },
  };
}
