import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Children } from './agents.ts';
import type { ShellJobs } from './shells.ts';
import type { Memory } from './memory.ts';
import { isActiveRun, isRunning, type RunInfo } from './runs.ts';
import { externalAction } from './external-runs.ts';
import { agentModel } from './agent-model.ts';
import type { Usage } from '@earendil-works/pi-ai';
import { ranges, summarizeUsage, type UsageLedger, type UsageRange, type UsageRole } from './usage.ts';

export const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '  ');
export const oneLine = (text: string) => clean(text).replace(/\n/g, ' ');
export const count = (n: number) => n.toLocaleString('en-US');
const units = ['', 'k', 'M', 'B'];
/** 950, 12.3k, 164k, 2.4M: enough precision to compare rows at a glance. A value that rounds to 1000 moves up a unit. */
export const short = (n: number) => {
  let unit = 0, value = n;
  const round = (v: number) => v >= 100 || !unit ? Math.round(v) : Number(v.toFixed(1));
  while (unit < units.length - 1 && round(value) >= 1000) { value /= 1000; unit++; }
  return `${round(value)}${units[unit]}`;
};
const dollars = (n: number) => n > 0 && n < 0.0001 ? '<$0.0001' : `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
const cached = (u: Usage) => { const input = u.input + u.cacheRead + u.cacheWrite; return `${input ? Math.round(100 * u.cacheRead / input) : 0}%`; };
const roleNames: Record<UsageRole, string> = { main: 'main', subagent: 'subagents', compactor: 'compactor', import: 'import', advisor: 'approvals', heartbeat: 'heartbeat' };
const seconds = (ms?: number) => ms === undefined ? '-' : `${(ms / 1000).toFixed(1)}s`;
function usageRows(groups: ReturnType<typeof summarizeUsage>['groups'], total: Usage) {
  const order = ['main', 'subagent', 'compactor', 'advisor', 'heartbeat', 'import'] as const;
  return groups.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || b.usage.cost.total - a.usage.cost.total).map((group, index) => [
    index && groups[index - 1].role === group.role ? '' : roleNames[group.role],
    oneLine(`${group.provider ?? 'unknown'}/${group.model}${group.failures ? ` · ${group.failures} failed` : ''}`), dollars(group.usage.cost.total),
    `${total.cost.total ? Math.round(100 * group.usage.cost.total / total.cost.total) : 0}%`, count(group.calls), dollars(group.usage.cost.total / group.calls),
    short(group.usage.output), cached(group.usage),
    seconds(group.latency?.firstMs), seconds(group.latency?.responseMs),
  ]);
}
export const elapsed = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.floor(ms / 1000) % 60}s`;
/** Shortens plain text with an ellipsis, preferring a word boundary. */
export function fit(text: string, width: number) {
  if (visibleWidth(text) <= width) return text;
  if (width < 2) return sliceByColumn(text, 0, width, true);
  const cut = sliceByColumn(text, 0, width - 1, true), space = cut.lastIndexOf(' '); // Unlike truncateToWidth, adds no style reset.
  return `${(space > cut.length * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
/** Left text and right text on one line, the right side flush with the edge when both fit. */
const spread = (left: string, right: string, width: number) => {
  const gap = width - visibleWidth(left) - visibleWidth(right);
  return gap >= 2 ? `${left}${' '.repeat(gap)}${right}` : left;
};
const pages = ['agents', 'usage', 'activity', 'shells'] as const;
export type InspectorPage = typeof pages[number];
const pageNames: Record<InspectorPage, string> = { agents: 'Agents', usage: 'Usage', activity: 'Activity', shells: 'Shells' };
/** Tab order, wrapping around: Agents, Usage, Activity, Shells. */
export const nextPage = (page: InspectorPage, delta = 1) => pages[(pages.indexOf(page) + delta + pages.length) % pages.length];
/** Closing the panel either picks the subagent model or opens one agent's conversation. */
export type InspectorAction = 'model' | { open: string };
type Tone = 'accent' | 'muted' | 'dim' | 'error' | 'warning' | 'border';
interface Options {
  profile: string; session: string; children: Children; usage: UsageLedger; memory: Pick<Memory, 'root' | 'size' | 'budget' | 'lastError' | 'progress' | 'onChange'>; page: InspectorPage;
  shells?: ShellJobs;
  rows: () => number; redraw: () => void; done: (action?: InspectorAction) => void;
  color: (tone: Tone, text: string) => string;
  context: () => number | null | undefined;
  refreshUsage?: () => void;
  signal?: AbortSignal;
}

/** UI projection only: inspecting never injects child transcripts into parent memory. */
/** One panel row: the task, the status, the model and the duration of a run. */
function panelRow(run: RunInfo, children: Children) {
  const external = run.source === 'pi-subagents';
  const live = children.live(run.id), tools = live ? [...live.tools.values()].map(t => t.name).join(', ') : '';
  const queued = run.guidance.filter(g => g.state === 'queued').length, undelivered = run.guidance.filter(g => g.state === 'undelivered').length;
  const guidance = [queued && `${queued} message${queued === 1 ? '' : 's'} queued`, undelivered && `${undelivered} message${undelivered === 1 ? '' : 's'} not delivered`].filter(Boolean).join(' · ');
  const activity = external ? (run.state === 'running' ? 'running via pi-subagents' : run.state)
    : run.state === 'stopping' ? 'stopping' : run.state === 'waiting' ? 'waiting for children' : run.state === 'paused' ? 'interrupted · waiting for you' : tools || (live?.streaming ? 'responding' : 'working');
  const status = live ? `${guidance ? `${guidance} · ` : ''}${activity} · updated ${elapsed(Date.now() - live.updated)} ago`
    : external ? `π ${activity}${guidance ? ` · ${guidance}` : ''}` : `${run.state}${guidance ? ` · ${guidance}` : ''}`;
  return {
    run,
    task: `${'  '.repeat(run.depth - 1)}${external ? 'π ' : run.parentId ? '↳ ' : ''}${oneLine(run.task)}`,
    status,
    model: agentModel(run),
    time: run.durationUnknown ? '—' : elapsed((run.ended ?? Date.now()) - run.started),
  };
}

export class Inspector implements Component, Focusable {
  focused = true;
  private page: InspectorPage;
  private selected?: string;
  private selectedShell?: string;
  private shellOutput = false;
  private confirmStop?: string;
  private top = 0;
  private scroll = 0;
  private lineCount = 0;
  private hintLines = 1;
  private range: UsageRange = 'This session';
  private confirmDelete?: string;
  private notice = '';
  private ended = false;
  private readonly unsubscribe: (() => void)[];
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: Options) {
    this.page = options.page;
    this.selected = options.children.runs()[0]?.id;
    this.unsubscribe = [options.children.subscribe(() => options.redraw()), options.memory.onChange(() => options.redraw()), ...(options.shells ? [options.shells.subscribe(() => options.redraw())] : [])];
    this.timer = setInterval(() => { options.refreshUsage?.(); options.redraw(); }, 1000); this.timer.unref();
    options.signal?.addEventListener('abort', this.abort, { once: true });
    if (options.signal?.aborted) queueMicrotask(this.abort);
  }
  private readonly abort = () => this.finish();
  private finish(action?: InspectorAction) { if (!this.ended) { this.dispose(); this.options.done(action); } }
  dispose() {
    this.ended = true; clearInterval(this.timer); this.unsubscribe.forEach(stop => stop()); this.options.signal?.removeEventListener('abort', this.abort);
  }
  invalidate() {}
  /** Body rows left after the rules, title, hint and spacing; the rest of the screen keeps the footer visible. */
  private get height() { return Math.max(1, Math.floor(this.options.rows() * 0.8) - 6 - (this.hintLines - 1)); }
  private select(delta: number) {
    const list = this.options.children.runs();
    const index = Math.max(0, list.findIndex(r => r.id === this.selected));
    this.selected = list[Math.max(0, Math.min(list.length - 1, index + delta))]?.id;
  }
  handleInput(data: string) {
    if (this.ended) return;
    if (matchesKey(data, 'escape') && this.page === 'shells' && (this.shellOutput || this.confirmStop)) {
      if (this.confirmStop) this.confirmStop = undefined;
      else { this.shellOutput = false; this.scroll = 0; }
      this.options.redraw(); return;
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) return this.finish();
    const deleting = this.confirmDelete; this.confirmDelete = undefined; this.notice = '';
    if (matchesKey(data, 'tab')) {
      this.page = nextPage(this.page); this.scroll = 0; this.shellOutput = false; this.confirmStop = undefined;
    } else if (this.page === 'shells') this.shellInput(data);
    else if (this.page === 'activity') this.scrollInput(data);
    else if (this.page === 'usage') {
      if (matchesKey(data, 'left') || matchesKey(data, 'right')) {
        const delta = matchesKey(data, 'left') ? -1 : 1;
        this.range = ranges[(ranges.indexOf(this.range) + delta + ranges.length) % ranges.length]; this.scroll = 0;
      } else this.scrollInput(data);
    } else {
      if (matchesKey(data, 'up')) this.select(-1);
      else if (matchesKey(data, 'down')) this.select(1);
      else if (matchesKey(data, 'pageUp')) this.select(-this.height);
      else if (matchesKey(data, 'pageDown')) this.select(this.height);
      else if (matchesKey(data, 'home')) this.select(-Infinity);
      else if (matchesKey(data, 'end')) this.select(Infinity);
      else if (data === 'm') return this.finish('model');
      else if ((data === 'd' || matchesKey(data, 'delete')) && this.selected) {
        if (deleting === this.selected) this.remove(this.selected);
        else this.confirmDelete = this.selected;
      }
      else if (matchesKey(data, 'return') && this.selected) return this.finish({ open: this.selected });
    }
    this.options.redraw();
  }
  /** What the panel's destructive key does to a pi-subagents row. */
  private externalAction(run: RunInfo) {
    return externalAction(run, this.options.children.ownsRun(run));
  }
  /** Once the run is gone, the cursor moves to the next row that is not, else the one above. */
  private remove(id: string) {
    const { children } = this.options, list = children.runs(), run = children.info(id);
    const doomed = new Set([id, ...(run?.source === 'pi-subagents' ? [] : children.descendants(id).map(r => r.id))]);
    const index = list.findIndex(r => r.id === id), next = list.slice(index).find(r => !doomed.has(r.id)) ?? list.slice(0, index).findLast(r => !doomed.has(r.id));
    if (run?.source === 'pi-subagents') { this.removeExternal(id, run, next); return; }
    children.remove(id).then(() => { if (!children.info(this.selected ?? '')) this.selected = next?.id; },
      (error: unknown) => { this.notice = `Not deleted: ${error instanceof Error ? error.message : String(error)}`; })
      .finally(() => { if (!this.ended) this.options.redraw(); });
  }
  /** A pi-subagents row: stop it, pause it, or hide it, never delete what pi-subagents owns. */
  private removeExternal(id: string, run: RunInfo, next?: RunInfo) {
    const { children } = this.options, action = this.externalAction(run);
    if (action === 'stop') {
      children.stopExternal(id).then(() => { this.notice = 'Stop requested for this pi-subagents run; it stays visible until pi-subagents reports the outcome.'; },
        (error: unknown) => { this.notice = `Not stopped: ${error instanceof Error ? error.message : String(error)}`; })
        .finally(() => { if (!this.ended) this.options.redraw(); });
      return;
    }
    try {
      if (action === 'pause') {
        children.interruptExternal(id).then(() => {
          this.notice = 'Paused and hidden; the run waits for a message in the Pi session that started it.';
          children.hideExternal(id);
          if (!children.info(this.selected ?? '')) this.selected = next?.id;
        }, (error: unknown) => { this.notice = `Not paused: ${error instanceof Error ? error.message : String(error)}`; })
          .finally(() => { if (!this.ended) this.options.redraw(); });
        return;
      }
      children.hideExternal(id);
      this.notice = run.externalKind === 'live-foreground'
        ? 'Hidden; this run keeps working in the Pi session that started it.'
        : 'Hidden from this panel; pi-subagents keeps the run and its artifacts.';
      if (!children.info(this.selected ?? '')) this.selected = next?.id;
    } catch (error) { this.notice = `Not hidden: ${error instanceof Error ? error.message : String(error)}`; }
    this.options.redraw();
  }
  private scrollInput(data: string) {
    const delta = matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : matchesKey(data, 'pageUp') ? -this.height : matchesKey(data, 'pageDown') ? this.height : 0;
    if (delta || matchesKey(data, 'home') || matchesKey(data, 'end')) {
      this.scroll = matchesKey(data, 'home') ? 0 : matchesKey(data, 'end') ? this.lineCount : this.scroll + delta;
      this.scroll = Math.max(0, Math.min(this.scroll, this.lineCount - this.height));
    }
  }
  private shellInput(data: string) {
    const jobs = this.options.shells?.list() ?? [];
    const job = jobs.find(j => j.id === this.selectedShell) ?? jobs[0];
    if (!job) return;
    this.selectedShell = job.id;
    if (this.confirmStop) {
      if (matchesKey(data, 'return')) { this.options.shells?.stop(this.confirmStop); this.confirmStop = undefined; }
      return;
    }
    if (data === 'k' && job.mode === 'background' && job.state === 'running') { this.confirmStop = job.id; return; }
    if (this.shellOutput) { this.scrollInput(data); return; }
    if (matchesKey(data, 'return')) { this.shellOutput = true; this.scroll = 0; return; }
    const delta = matchesKey(data, 'up') ? -1 : matchesKey(data, 'down') ? 1 : matchesKey(data, 'pageUp') ? -this.height : matchesKey(data, 'pageDown') ? this.height : 0;
    const index = jobs.findIndex(j => j.id === job.id);
    this.selectedShell = jobs[matchesKey(data, 'home') ? 0 : matchesKey(data, 'end') ? jobs.length - 1 : Math.max(0, Math.min(jobs.length - 1, index + delta))]?.id;
  }
  private shellLines(width: number) {
    const { color } = this.options;
    const jobs = this.options.shells?.list() ?? [];
    const job = jobs.find(j => j.id === this.selectedShell) ?? jobs[0];
    this.selectedShell = job?.id;
    const running = jobs.filter(j => j.state === 'running' || j.state === 'stopping').length;
    let body: string[], info = `${running} active · ${jobs.length - running} finished`;
    let hint = '↑↓ select · Enter output · Tab agents · Esc close';
    if (this.shellOutput && job) {
      const lines = [color('accent', oneLine(job.command)), color('muted', `${job.state} · ${job.mode} · ${job.owner ?? 'main'} · ${elapsed((job.ended ?? Date.now()) - job.started)}`), color('dim', oneLine(job.cwd)), '',
        ...(job.output ? clean(job.output).split('\n') : [color('dim', 'No output yet.')])].flatMap(line => wrapTextWithAnsi(line, width));
      this.lineCount = lines.length;
      this.scroll = Math.max(0, Math.min(this.scroll, lines.length - this.height));
      body = lines.slice(this.scroll, this.scroll + this.height);
      info = `${job.state} · ${this.scroll + 1}–${Math.min(lines.length, this.scroll + this.height)} / ${lines.length}`;
      hint = '↑↓ scroll · End latest · Esc list';
    } else {
      const index = Math.max(0, jobs.findIndex(j => j.id === this.selectedShell));
      this.top = Math.max(0, Math.min(this.top, jobs.length - this.height));
      if (index < this.top) this.top = index;
      if (index >= this.top + this.height) this.top = index - this.height + 1;
      body = jobs.slice(this.top, this.top + this.height).map(j => {
        const duration = elapsed((j.ended ?? Date.now()) - j.started);
        const fullMeta = `${j.state} · ${j.mode} · ${duration}`;
        const meta = visibleWidth(fullMeta) + 16 <= width ? fullMeta : `${j.state} · ${duration}`;
        const command = fit(oneLine(j.command), Math.max(1, width - visibleWidth(meta) - 4));
        const row = spread(`${j.id === this.selectedShell ? '→' : ' '} ${command}`, meta, width);
        return color(j.id === this.selectedShell ? 'accent' : j.state === 'failed' ? 'error' : 'muted', row);
      });
      if (!body.length) body = [color('muted', 'No shells this session.'), '', color('dim', 'Shell commands appear here while running.'), color('dim', 'Use shell_start for managed background execution.')];
    }
    if (job?.mode === 'background' && job.state === 'running') hint += ' · k stop';
    else if (job?.mode === 'foreground' && job.state === 'running') hint += job.owner === 'main' ? ' · interrupt: close panel, then Pi Esc' : ' · interrupt via agent controls';
    if (this.confirmStop) hint = 'Stop selected background shell? Enter stop · Esc cancel';
    return { body, info, hint };
  }
  /** Period tabs, one headline, then an aligned table with a row per role and model. */
  private usageLines(width: number) {
    const { usage, session, context, color } = this.options;
    const { total, failures, groups, latency, calls } = usage.summary(this.range, session);
    // No-break spaces keep a label like "Last 7 days" on one line when the tabs wrap.
    const tabs = ranges.map(r => r.replaceAll(' ', '\u00a0')).map((r, i) => ranges[i] === this.range ? color('accent', `[${r}]`) : color('dim', r)).join('  ');
    const lines = [...wrapTextWithAnsi(tabs, width), ''];
    if (!calls) lines.push(color('muted', 'No usage in this period.'));
    else {
      lines.push(`${color('accent', dollars(total.cost.total))} estimated API cost · ${short(total.totalTokens)} tokens · ${cached(total)} cached${failures ? ` · ${failures} failed` : ''}`);
      if (latency) lines.push(color('muted', `median of ${count(latency.calls)} measured calls: first content ${seconds(latency.firstMs)} · response ${seconds(latency.responseMs)}`));
      lines.push('');
      const rows = usageRows(groups, total);
      const header = ['', 'model', 'cost', 'share', 'calls', '$/call', 'out', 'cached', 'first', 'reply'];
      const widths = header.map((h, c) => Math.max(h.length, ...rows.map(r => r[c].length)));
      // The model column goes first when the screen is too narrow for every column.
      const all = header.map((_, c) => c);
      const columns = widths.reduce((sum, w) => sum + w + 2, 0) - 2 <= width ? all : all.filter(c => c !== 1);
      const line = (cells: string[]) => columns.map(c => c < 2 ? cells[c].padEnd(widths[c]) : cells[c].padStart(widths[c])).join('  ').trimEnd();
      lines.push(color('dim', line(header)), ...rows.map(r => {
        const text = line(r); return color('muted', text.slice(0, widths[0])) + text.slice(widths[0]);
      }));
    }
    const current = context();
    if (current != null) lines.push('', `${color('muted', 'Context now')} ${short(current)} tokens`);
    lines.push('', color('dim', 'API-rate estimate, not a provider bill; $0.00 may mean unknown or zero model pricing. No provider quota inference.'), ...usage.warnings.map(w => color('warning', w)));
    return lines.flatMap(l => l ? wrapTextWithAnsi(l, width) : ['']);
  }
  /** Memory as a gauge: how full the view is, whether summaries are catching up, and how many agents run (their list is one Tab away). */
  private activityLines(width: number) {
    const { memory, children, color } = this.options;
    const { done, total, retryIn } = memory.progress();
    const list = children.runs(), agents = list.filter(isRunning).length, paused = list.filter(r => r.state === 'paused').length;
    const filled = total ? Math.floor(10 * done / total) : 0;
    const lines = [`${color('muted', 'Memory')} · ${count(memory.root.length)} messages · view ${Math.round(memory.size / 1000)} KB / ${Math.round(memory.budget / 1000)} KB`,
      total ? `Catching up · ${count(done)} of ${count(total)} summaries  ${color('accent', '█'.repeat(filled))}${color('dim', '░'.repeat(10 - filled))}` : color('dim', 'Settled')];
    if (memory.lastError) lines.push(color('dim', `${oneLine(memory.lastError)}${retryIn === undefined ? '' : ` · retry in ${elapsed(retryIn)}`}`));
    lines.push('', `${color('muted', 'Agents')} · ${agents} running${paused ? ` · ${paused} interrupted` : ''}`);
    return lines.flatMap(l => l ? wrapTextWithAnsi(l, width) : ['']);
  }
  render(width: number): string[] {
    const { color, children, profile } = this.options;
    const inner = Math.max(1, width - 2);
    let title = `OptChat · ${profile} · ${pageNames[this.page]}`;
    let info: string, body: string[], hint: string;
    if (this.page === 'shells') {
      const content = this.shellLines(inner);
      body = content.body; info = content.info; hint = content.hint;
    } else if (this.page !== 'agents') {
      const lines = this.page === 'usage' ? this.usageLines(inner) : this.activityLines(inner); this.lineCount = lines.length;
      this.scroll = Math.max(0, Math.min(this.scroll, lines.length - this.height));
      body = lines.slice(this.scroll, this.scroll + this.height);
      info = this.page === 'usage' || lines.length > this.height ? `${this.scroll + 1}–${Math.min(this.scroll + this.height, lines.length)} / ${lines.length}` : '';
      hint = this.page === 'usage' ? '←→ period · ↑↓ scroll · Tab activity · Esc close' : '↑↓ scroll · Tab shells · Esc close';
    } else {
      const list = children.runs();
      if (!this.selected) this.selected = list[0]?.id;
      const cursor = Math.max(0, list.findIndex(r => r.id === this.selected));
      this.top = Math.max(0, Math.min(this.top, list.length - this.height));
      if (cursor < this.top) this.top = cursor;
      if (cursor >= this.top + this.height) this.top = cursor - this.height + 1;
      const rows = list.slice(this.top, this.top + this.height).map(run => panelRow(run, children));
      // Task · actual model(thinking) · status · duration. Hide metadata before losing the task on narrow screens.
      const timeWidth = Math.max(0, ...rows.map(r => r.time.length));
      const modelWidth = inner >= 64 ? Math.min(36, Math.floor(inner * 0.3), Math.max(0, ...rows.map(r => visibleWidth(r.model)))) : 0;
      let statusWidth = Math.min(Math.max(0, ...rows.map(r => visibleWidth(r.status))), Math.floor(inner * 0.4));
      if (inner - 2 - statusWidth - modelWidth - timeWidth - 6 < 12) statusWidth = 0;
      const taskWidth = Math.max(1, inner - 2 - timeWidth - 2 - (statusWidth ? statusWidth + 2 : 0) - (modelWidth ? modelWidth + 2 : 0));
      body = rows.map(({ run, task, model, status, time }) => {
        const selected = run.id === this.selected;
        const name = truncateToWidth(fit(task, taskWidth), taskWidth, '', true);
        const meta = `${modelWidth ? `${truncateToWidth(fit(model, modelWidth), modelWidth, '', true)}  ` : ''}${statusWidth ? `${truncateToWidth(fit(status, statusWidth), statusWidth, '', true)}  ` : ''}${time.padStart(timeWidth)}`;
        return selected ? color('accent', `→ ${name}  ${meta}`) : `  ${name}  ${color('muted', meta)}`;
      });
      if (!body.length) body.push(color('muted', 'No agents yet. Ask the main agent to delegate a task.'));
      const selectedRun = list.find(r => r.id === this.selected), piRuns = list.filter(r => r.source === 'pi-subagents').length;
      info = `${list.filter(isActiveRun).length} active · ${list.length} saved${piRuns ? ` · ${piRuns} π` : ''}${list.length ? ` · ${cursor + 1}/${list.length}` : ''}`;
      hint = this.confirmDelete ? (() => {
        const target = list.find(r => r.id === this.confirmDelete);
        if (target?.source !== 'pi-subagents') {
          return `Press d again to ${children.live(this.confirmDelete) ? 'stop and delete' : 'delete'} this agent and the agents it started`;
        }
        const action = this.externalAction(target);
        return action === 'stop' ? 'Press d again to stop this pi-subagents run'
          : action === 'pause' ? 'Press d again to pause and hide this pi-subagents foreground run'
          : 'Press d again to hide this π run from the panel; its artifacts stay';
      })()
        : this.notice || (selectedRun?.source === 'pi-subagents'
          ? '↑↓ select · Enter open · m model · d stop/hide · π = pi-subagents · Tab usage · Esc close'
          : '↑↓ select · Enter open · m model · d delete · Tab usage · Esc close');
    }
    title = fit(title, Math.max(1, inner - visibleWidth(info) - 2));
    const tone = this.page !== 'agents' ? 'dim' : this.confirmDelete ? 'warning' : this.notice ? 'error' : 'dim';
    const footer = wrapTextWithAnsi(hint, inner).map(line => color(tone, line));
    this.hintLines = footer.length;
    const rule = color('border', '─'.repeat(Math.max(1, width)));
    // Same layout as Pi's own selectors: rules above and below, content indented by one column.
    const content = [spread(color('accent', title), color('dim', info), inner), '', ...body, '', ...footer].map(line => ` ${truncateToWidth(line, inner, '…')}`);
    return [rule, ...content, rule].map(line => truncateToWidth(line, width));
  }
}

let showing = false;
/** True while the panel is on screen; cleared before Pi restores the editor so the agent bar returns in the same frame. */
export const inspectorShowing = () => showing;
/** Takes the editor's place, like Pi's own selectors; Pi restores the editor and its draft on close. */
export function showInspector(ctx: ExtensionContext, options: Omit<Options, 'rows' | 'redraw' | 'done' | 'color' | 'context'>) {
  return ctx.ui.custom<InspectorAction | undefined>((tui, theme, _keys, done) => {
    showing = true;
    return new Inspector({ ...options,
      rows: () => tui.terminal.rows, redraw: () => tui.requestRender(), done: action => { showing = false; done(action); },
      color: (tone, text) => theme.fg(tone, text), context: () => ctx.getContextUsage()?.tokens,
    });
  });
}
