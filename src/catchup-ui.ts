import { matchesKey, Text, type Component, type Focusable } from '@earendil-works/pi-tui';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

/** A read-only page, not a confirmation dialog. Reflow first, then scroll by rendered terminal rows. */
export class CatchupView implements Component, Focusable {
  focused = true;
  private top = 0;
  private pageHeight = 1;
  constructor(private readonly body: string, private readonly rows: () => number, private readonly close: () => void, private readonly redraw: () => void) {}
  invalidate() {}
  render(width: number) {
    const safeWidth = Math.max(1, width);
    const lines = new Text(this.body, 0, 0).render(safeWidth);
    const head = new Text('Activity receipt · read-only', 0, 0).render(safeWidth);
    const foot = new Text('j/k scroll · PgUp/PgDn · g/G top/end · Esc close', 0, 0).render(safeWidth);
    const height = this.pageHeight = Math.max(1, this.rows() - head.length - foot.length - 2);
    this.top = Math.max(0, Math.min(this.top, Math.max(0, lines.length - height)));
    return [...head, '', ...lines.slice(this.top, this.top + height), '', ...foot];
  }
  handleInput(data: string) {
    if (matchesKey(data, 'escape') || data === 'q') { this.close(); return; }
    const page = this.pageHeight;
    if (matchesKey(data, 'down') || data === 'j') this.top++;
    else if (matchesKey(data, 'up') || data === 'k') this.top--;
    else if (matchesKey(data, 'pageDown') || data === ' ') this.top += page;
    else if (matchesKey(data, 'pageUp')) this.top -= page;
    else if (matchesKey(data, 'home') || data === 'g') this.top = 0;
    else if (matchesKey(data, 'end') || data === 'G') this.top = Number.MAX_SAFE_INTEGER;
    this.redraw();
  }
}

export async function showCatchup(ctx: ExtensionContext, text: string) {
  if (ctx.mode !== 'tui') { ctx.ui.notify(text, 'info'); return; }
  await ctx.ui.custom<void>((tui, _theme, _keys, done) => new CatchupView(text, () => tui.terminal.rows, () => done(), () => tui.requestRender()));
}
