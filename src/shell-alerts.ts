/** One matching line: its number, its text clipped around the match, and the two lines before it. */
export interface ShellAlertMatch { line: number; text: string; before: { line: number; text: string }[] }
/** One alert: the matches it covers (new since the last one), the running total, and the latest few of them shown. */
export interface ShellAlert { matches: number; firstLine: number; lastLine: number; total: number; hidden: number; shown: ShellAlertMatch[] }
export interface OutputAlertsOptions {
  pattern: RegExp;
  /** The least time between two alerts. Matches that arrive inside it wait and go out together when it ends. */
  intervalMs: number;
  onAlert: (alert: ShellAlert) => void;
  now?: () => number;
  /** Runs `run` after `ms`; returns a function that cancels it. */
  setTimer?: (run: () => void, ms: number) => () => void;
}

/** A line longer than this is scanned in pieces of this size, so memory stays bounded. */
export const MAX_LINE_BYTES = 64 * 1024;
const SHOWN = 5, CONTEXT = 2, CLIP_CHARS = 200, NEWLINE = 0x0a, CR = 0x0d;

/** The text clipped to CLIP_CHARS characters around `at` (a UTF-16 index), with an ellipsis where it was cut. */
export function excerpt(text: string, at = 0) {
  const chars = [...text];
  if (chars.length <= CLIP_CHARS) return text;
  const centre = [...text.slice(0, at)].length;
  const start = Math.min(Math.max(0, centre - 100), chars.length - CLIP_CHARS);
  return `${start > 0 ? '…' : ''}${chars.slice(start, start + CLIP_CHARS).join('')}${start + CLIP_CHARS < chars.length ? '…' : ''}`;
}

/**
 * Watches a shell's raw output bytes for a pattern, without losing or repeating a line.
 *
 * Every line is counted at most once, whatever the chunk boundaries: bytes are kept until their line ends and
 * decoded only then, so a UTF-8 character or a match cut by a chunk is still whole. A line longer than
 * MAX_LINE_BYTES is cut into pieces at a character boundary; a match that spans two pieces of such a line is
 * not found (the only exception; lines up to 64 KiB are matched whole).
 *
 * Alerts come at most once per interval, the first one at once. Matches in a window wait for it to end, then
 * go out together, showing the latest few and counting the rest. `end()` sends what is still waiting.
 */
export class OutputAlerts {
  private readonly pattern: RegExp;
  private readonly intervalMs: number;
  private readonly onAlert: (alert: ShellAlert) => void;
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => () => void;
  private partial: Buffer[] = [];
  private partialBytes = 0;
  private line = 1;
  private lineMatched = false;
  private head?: string;
  private context: { line: number; text: string }[] = [];
  private total = 0;
  private batch?: { matches: number; firstLine: number; lastLine: number; shown: ShellAlertMatch[] };
  private lastSent?: number;
  private cancelTimer?: () => void;
  private ended = false;

  constructor(options: OutputAlertsOptions) {
    // A global or sticky flag makes test() stateful: keep the matching stateless.
    this.pattern = new RegExp(options.pattern.source, options.pattern.flags.replace(/[gy]/g, ''));
    this.intervalMs = options.intervalMs;
    this.onAlert = options.onAlert;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((run, ms) => { const timer = setTimeout(run, ms); timer.unref?.(); return () => clearTimeout(timer); });
  }

  /** Takes the next bytes of the shell's output, in order. */
  feed(chunk: Buffer) {
    if (this.ended) return;
    let start = 0, at = chunk.indexOf(NEWLINE);
    while (at !== -1) {
      this.piece(chunk.subarray(start, at));
      this.finishLine();
      start = at + 1;
      at = chunk.indexOf(NEWLINE, start);
    }
    this.piece(chunk.subarray(start));
    this.window();
  }

  /** The output has ended: the last line counts, and whatever is waiting is sent now. */
  end() {
    if (this.ended) return;
    if (this.partialBytes > 0) this.finishLine();
    this.ended = true;
    this.send();
  }

  private piece(bytes: Buffer) {
    if (!bytes.length) return;
    this.partial.push(Buffer.from(bytes));
    this.partialBytes += bytes.length;
    while (this.partialBytes > MAX_LINE_BYTES) this.cut();
  }

  /** Scans the first MAX_LINE_BYTES of the pending line, never ending a piece inside a UTF-8 character. */
  private cut() {
    const bytes = Buffer.concat(this.partial, this.partialBytes);
    let at = MAX_LINE_BYTES;
    while (at > 0 && (bytes[at] & 0xc0) === 0x80) at--;
    if (at === 0) at = MAX_LINE_BYTES;
    const piece = bytes.subarray(0, at).toString('utf8');
    this.head ??= piece;
    this.test(piece);
    const rest = Buffer.from(bytes.subarray(at));
    this.partial = [rest];
    this.partialBytes = rest.length;
  }

  private finishLine() {
    let bytes = Buffer.concat(this.partial, this.partialBytes);
    this.partial = []; this.partialBytes = 0;
    if (bytes.length && bytes[bytes.length - 1] === CR) bytes = bytes.subarray(0, -1);
    const text = bytes.toString('utf8');
    this.test(text);
    this.context.push({ line: this.line, text: excerpt(this.head ?? text) });
    if (this.context.length > CONTEXT) this.context.shift();
    this.line++; this.lineMatched = false; this.head = undefined;
  }

  /** Counts the line once, at its first matching piece. */
  private test(text: string) {
    if (this.lineMatched) return;
    const found = this.pattern.exec(text);
    if (!found) return;
    this.lineMatched = true;
    this.total++;
    const batch = this.batch ??= { matches: 0, firstLine: this.line, lastLine: this.line, shown: [] };
    batch.matches++;
    batch.lastLine = this.line;
    batch.shown.push({ line: this.line, text: excerpt(text, found.index), before: this.context.map(line => ({ ...line })) });
    if (batch.shown.length > SHOWN) batch.shown.shift();
  }

  /** After each chunk: send now if the window is open, otherwise at its end. */
  private window() {
    if (!this.batch || this.cancelTimer) return;
    const wait = this.lastSent === undefined ? 0 : this.lastSent + this.intervalMs - this.now();
    if (wait <= 0) this.send();
    else this.cancelTimer = this.setTimer(() => { this.cancelTimer = undefined; this.send(); }, wait);
  }

  private send() {
    this.cancelTimer?.(); this.cancelTimer = undefined;
    const batch = this.batch;
    if (!batch) return;
    this.batch = undefined;
    this.lastSent = this.now();
    this.onAlert({ matches: batch.matches, firstLine: batch.firstLine, lastLine: batch.lastLine, total: this.total,
      hidden: batch.matches - batch.shown.length, shown: batch.shown });
  }
}
