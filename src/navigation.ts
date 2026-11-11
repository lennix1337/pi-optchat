import { CustomEditor, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type KeyId } from '@earendil-works/pi-tui';
import type { Children } from './agents.ts';
import type { Memory } from './memory.ts';
import { inspectorShowing, nextPage, type InspectorPage } from './inspector.ts';
import { isRunning } from './runs.ts';
import type { ShellJobs } from './shells.ts';
import { cut, overflowText, type BoardLine, type BoardView, type WaitingBoard } from './waiting-board.ts';

/** Configured before extension registration; this also works in legacy terminals with F6. */
export function inspectorShortcut(value = process.env.OPTCHAT_INSPECT_KEY ?? 'f6'): KeyId {
  const parts = value.split('+'), base = parts.pop() ?? '';
  const special = ['escape', 'enter', 'return', 'tab', 'space', 'backspace', 'delete', 'insert', 'home', 'end', 'pageUp', 'pageDown', 'up', 'down', 'left', 'right'];
  if ((!/^[a-z0-9]$/.test(base) && !/^f([1-9]|1[0-2])$/.test(base) && !special.includes(base))
    || new Set(parts).size !== parts.length || parts.some(p => !['ctrl', 'alt', 'shift', 'super'].includes(p))) throw new Error('Invalid OPTCHAT_INSPECT_KEY. Example: f6 or ctrl+shift+a.');
  return value as KeyId;
}

export class BarNavigation {
  selected: InspectorPage | undefined;
  handle(data: string, empty: boolean, autocomplete: boolean, open: (page: InspectorPage) => void): boolean {
    if (!this.selected) {
      if (empty && !autocomplete && matchesKey(data, 'down')) { this.selected = 'agents'; return true; }
      return false;
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'up')) { this.selected = undefined; return true; }
    if (matchesKey(data, 'left') || matchesKey(data, 'right') || matchesKey(data, 'tab')) {
      this.selected = nextPage(this.selected, matchesKey(data, 'left') ? -1 : 1); return true;
    }
    if (matchesKey(data, 'return')) { const page = this.selected; this.selected = undefined; open(page); return true; }
    if (matchesKey(data, 'down')) return true;
    this.selected = undefined; return false; // Typing naturally resumes editing.
  }
}

/**
 * Keyboard focus on the waiting board above the editor, the way `BarNavigation` focuses the bar below it: Up on an empty editor
 * enters the board, which then shows every item in full with a cursor. Up/Down move it; Esc, Down past the last item or typing leave.
 */
export class BoardNavigation {
  focused = false;
  cursor = 0;
  constructor(private readonly board: Pick<WaitingBoard, 'expanded'>) {}
  /** The board's items while it has focus; focus ends by itself when nothing is left to show. */
  items(): BoardLine[] {
    if (!this.focused) return [];
    const lines = this.board.expanded().lines;
    if (!lines.length) { this.focused = false; this.cursor = 0; return []; }
    this.cursor = Math.min(this.cursor, lines.length - 1);
    return lines;
  }
  /** True when the key was consumed. */
  handle(data: string, empty: boolean, autocomplete: boolean): boolean {
    if (!this.focused) {
      if (!empty || autocomplete || inspectorShowing() || !matchesKey(data, 'up') || !this.board.expanded().lines.length) return false;
      this.focused = true; this.cursor = 0; return true;
    }
    const count = this.items().length;
    if (!count) return false;
    if (matchesKey(data, 'up')) { this.cursor = Math.max(0, this.cursor - 1); return true; }
    if (matchesKey(data, 'down')) { if (this.cursor >= count - 1) this.focused = false; else this.cursor++; return true; }
    this.focused = false; this.cursor = 0;
    return matchesKey(data, 'escape'); // Typing naturally resumes editing.
  }
}

export function mountNavigation(ctx: ExtensionContext, children: Children, memory: Pick<Memory, 'progress' | 'onChange'>, shortcut: string, open: (page: InspectorPage) => void, shells?: ShellJobs, boardNav?: BoardNavigation, quiet = false) {
  const navigation = new BarNavigation();
  const previous = ctx.ui.getEditorComponent();
  let redraw = () => {};
  const factory: Parameters<typeof ctx.ui.setEditorComponent>[0] = (tui, theme, keys) => {
    class OptChatEditor extends CustomEditor {
      override handleInput(data: string) {
        const empty = this.getText().length === 0, autocomplete = this.isShowingAutocomplete();
        if (!navigation.selected && boardNav?.handle(data, empty, autocomplete)) { tui.requestRender(); return; }
        if (navigation.handle(data, empty, autocomplete, open)) { tui.requestRender(); return; }
        super.handleInput(data);
      }
    }
    return new OptChatEditor(tui, theme, keys);
  };
  // An existing custom editor owns its input rules; the shortcut remains available.
  if (!previous) ctx.ui.setEditorComponent(factory);
  ctx.ui.setWidget('optchat-agents', (tui, theme) => {
    redraw = () => tui.requestRender();
    return {
      invalidate() {},
      render(width: number) {
        // The open panel replaces the editor and this bar; with `quiet` the footer carries the status and the bar only appears while a page is selected.
        if (inspectorShowing() || quiet && !navigation.selected) return [];
        const list = children.runs(), running = list.filter(isRunning).length, paused = list.filter(r => r.state === 'paused').length;
        const label = (page: InspectorPage, text: string) => navigation.selected === page ? theme.fg('accent', `› ${text}`) : theme.fg('muted', text);
        const shellCount = shells?.list().filter(j => j.state === 'running' || j.state === 'stopping').length ?? 0;
        const shellLabel = shells ? `   ${shellCount ? theme.fg('accent', '● ') : ''}${label('shells', `Shells: ${shellCount} running`)}` : '';
        const left = `${label('agents', `Agents: ${running} running${paused ? ` · ${paused} interrupted` : ''} · ${list.length - running - paused} saved`)}   ${label('usage', 'Usage')}   ${memory.progress().total || running ? theme.fg('accent', '● ') : ''}${label('activity', 'Activity')}${shellLabel}`;
        const hint = theme.fg('dim', navigation.selected ? '←→ select · Enter open · Esc input' : `${previous ? '' : '↓ select · '}${shortcut} inspect`);
        const gap = width - visibleWidth(left) - visibleWidth(hint);
        if (shells && gap < 3) {
          const focus = navigation.selected ? label(navigation.selected, navigation.selected) : theme.fg('dim', `${shortcut} inspect`);
          const compact = `${label('agents', `Agents: ${running}`)}  ${label('shells', `Shells: ${shellCount}`)}  ${focus}`;
          return [truncateToWidth(compact, width)];
        }
        return [truncateToWidth(gap >= 3 ? `${left}${' '.repeat(gap)}${hint}` : `${left}   ${hint}`, width)];
      },
    };
  }, { placement: 'belowEditor' });
  const unsubscribe = [children.subscribe(() => redraw()), memory.onChange(() => redraw()), ...(shells ? [shells.subscribe(() => redraw())] : [])];
  // pi-subagents rows live in files, not in this session: a slow tick keeps their counts and states current.
  const timer = setInterval(() => redraw(), 2000); timer.unref();
  return () => {
    clearInterval(timer);
    unsubscribe.forEach(stop => stop()); ctx.ui.setWidget('optchat-agents', undefined);
    if (!previous && ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(undefined);
  };
}

const TONES = { active: 'accent', wait: 'warning', ok: 'success', bad: 'error', info: 'muted' } as const;
type Color = (tone: string, text: string) => string;
const HEADERS = { waiting: 'Esperando você', working: 'Trabalhando', done: 'Acabou agora' } as const;
const SECTIONS = ['waiting', 'working', 'done'] as const;
/** A header, with `right` (a hint) at the right edge when there is room. */
function headerRow(text: string, right: string, width: number, color: Color) {
  const gap = width - visibleWidth(text) - visibleWidth(right);
  return truncateToWidth(right && gap >= 3 ? `${color('muted', text)}${' '.repeat(gap)}${color('dim', right)}` : color('muted', text), width);
}
/** A line's text for `room` columns: a worker's goal gives way (down to a dozen characters) so the phase, time and model stay. */
function fitted(line: BoardLine, room: number) {
  const { parts } = line;
  if (!parts || visibleWidth(line.text) <= room) return line.text;
  const space = room - visibleWidth(parts.head) - visibleWidth(parts.tail);
  return space >= 12 ? `${parts.head}${cut(parts.goal, space)}${parts.tail}` : line.text;
}
/** The three sections the lines belong to, in order, each with its header and the count of what is waiting or working, shown or not; `index` is the line's place in `lines`. */
function sections(lines: readonly BoardLine[], waiting: number, working = lines.filter(line => line.section === 'working').length) {
  return SECTIONS.flatMap(section => {
    const rows = lines.map((line, index) => ({ line, index })).filter(row => row.line.section === section);
    return rows.length ? [{ header: section === 'waiting' ? `${HEADERS.waiting} (${waiting})` : section === 'working' ? `${HEADERS.working} (${working})` : HEADERS.done, rows }] : [];
  });
}
/**
 * The waiting board's rows for a terminal of `width`: three sections (waiting for the operator, working, just finished), each a header and
 * one row per item, then the overflow with the way to inspect it. The first header carries the key that opens the board. Empty when nothing is pending or recent.
 */
export function renderWaitingBoard(view: BoardView, width: number, color: Color, shortcut: string) {
  if (!view.lines.length) return [];
  const out: string[] = [];
  sections(view.lines, view.waiting, view.pending - view.waiting).forEach((section, i) => {
    out.push(headerRow(section.header, i === 0 ? '↑ abre' : '', width, color));
    for (const { line } of section.rows) out.push(truncateToWidth(` ${line.section === 'waiting' ? color('warning', '▸') : ' '} ${color(TONES[line.tone], fitted(line, width - 3))}`, width));
  });
  if (view.more) out.push(truncateToWidth(`   ${color('dim', overflowText(view.more, `${shortcut} inspecionar`))}`, width));
  return out;
}

/** The focused board: the same sections with every item in full, wrapped to `width`, the cursor's item marked, and the keys that move it. */
export function renderExpandedBoard(items: readonly BoardLine[], cursor: number, width: number, color: Color) {
  const room = Math.max(1, width - 4), out: string[] = [];
  sections(items, items.filter(item => item.section === 'waiting').length).forEach(section => {
    out.push(headerRow(section.header, '', width, color));
    for (const { line, index } of section.rows) {
      const here = index === cursor, tone = TONES[line.tone];
      line.text.split(/\n/).forEach((part, j) => wrapTextWithAnsi(part, room).forEach((row, k) => {
        const mark = j === 0 && k === 0 ? here ? color('accent', '›') : line.section === 'waiting' ? color('warning', '▸') : ' ' : ' ';
        out.push(truncateToWidth(` ${mark} ${color(here ? 'accent' : tone, row)}`, width));
      }));
    }
  });
  out.push(truncateToWidth(` ${color('dim', '↑↓ mover · Esc voltar')}`, width));
  return out;
}

/** The board above the editor: it redraws on every gitwatch event and on a tick that keeps the elapsed times moving. While `nav` has focus it shows every item. */
export function mountWaitingBoard(ctx: ExtensionContext, board: WaitingBoard, shortcut: string, nav?: BoardNavigation) {
  let redraw = () => {}, shown = false;
  ctx.ui.setWidget('optchat-waiting', (tui, theme) => {
    redraw = () => tui.requestRender();
    return { invalidate() {}, render: (width: number) => {
      const color = (tone: string, text: string) => theme.fg(tone as 'accent', text), items = inspectorShowing() ? [] : nav?.items() ?? [];
      const lines = inspectorShowing() ? [] : items.length && nav ? renderExpandedBoard(items, nav.cursor, width, color) : renderWaitingBoard(board.view(), width, color, shortcut);
      shown = lines.length > 0; return lines;
    } };
  });
  const unsubscribe = board.subscribe(() => redraw());
  // Idle sessions repaint nothing: the tick only runs the screen while the board has something to say.
  const timer = setInterval(() => { if (shown || board.view().lines.length) redraw(); }, 1000); timer.unref();
  return () => { clearInterval(timer); unsubscribe(); ctx.ui.setWidget('optchat-waiting', undefined); };
}
