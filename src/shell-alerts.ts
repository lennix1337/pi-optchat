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
/** Each piece also scans the last bytes of the piece before it, so a match shorter than this is found across a boundary. */
export const OVERLAP_BYTES = 4 * 1024;
const SHOWN = 5, CONTEXT = 2, CLIP_CHARS = 200, NEWLINE = 0x0a, CR = 0x0d;
const FLAGS = 'imsu';
/** `/pattern/flags`: the pattern runs to the last slash, so it may contain slashes. */
const LITERAL = /^\/(.+)\/([^/]*)$/s;

/**
 * The alert text as a regular expression. Plain text is a case-sensitive pattern; `/pattern/flags` takes the flags
 * i, m, s and u, each at most once. Throws for other flags or an invalid pattern, so a bad alert starts nothing.
 */
export function alertPattern(text: string): RegExp {
  const literal = LITERAL.exec(text);
  const source = literal ? literal[1] : text, flags = literal ? literal[2] : '';
  if ([...flags].some(flag => !FLAGS.includes(flag)) || new Set(flags).size !== flags.length)
    throw new Error(`alert flags must be from i, m, s and u, each once; got "${flags}". A pattern that starts with / is read as /pattern/flags; to match a leading slash, escape it as \\/`);
  try { return new RegExp(source, flags); } catch (error) { throw new Error(`alert is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`); }
}
/** How an alert is named in its messages: a literal as written, a plain pattern in slashes. */
export const alertLabel = (text: string) => LITERAL.test(text) ? text : `/${text}/`;

/** The first excerpt of a line: at most CLIP_CHARS characters around `at` (a UTF-16 index), with an ellipsis where it was cut. */
export function excerpt(text: string, at = 0) {
  const chars = [...text];
  if (chars.length <= CLIP_CHARS) return text;
  const centre = [...text.slice(0, at)].length;
  const start = Math.min(Math.max(0, centre - 100), chars.length - CLIP_CHARS);
  return `${start > 0 ? '…' : ''}${chars.slice(start, start + CLIP_CHARS).join('')}${start + CLIP_CHARS < chars.length ? '…' : ''}`;
}

/** The UTF-16 length of the first character of `text` (2 for a surrogate pair), 0 if empty: where a search may start to skip the overlap's first character. */
function firstCharUnits(text: string) {
  const code = text.codePointAt(0);
  return code === undefined ? 0 : code > 0xffff ? 2 : 1;
}

/** The last OVERLAP_BYTES of a window, starting on a character boundary. */
function overlapOf(window: Buffer) {
  let at = Math.max(0, window.length - OVERLAP_BYTES);
  while (at < window.length && (window[at] & 0xc0) === 0x80) at++;
  return Buffer.from(window.subarray(at));
}

/**
 * Watches a shell's raw output bytes for a pattern, without losing or repeating a line.
 *
 * Every line is counted at most once. Bytes are kept until their line ends and decoded only then, so a UTF-8
 * character or a match cut by a chunk is still whole. A line up to MAX_LINE_BYTES is matched whole, so it is exact.
 * A longer line is scanned in windows: each piece of MAX_LINE_BYTES is scanned after the last OVERLAP_BYTES of the
 * piece before it. A search starts after the window's first character, so a `^` at a boundary is not taken for the
 * line start. A match that runs to a window's end waits for the next window, which holds it in full, so `$` matches
 * only at the line's end. Known limits, for a line longer than MAX_LINE_BYTES only: a match longer than OVERLAP_BYTES
 * that crosses a boundary is missed, and a lookahead that reads past a boundary may decide differently from the
 * whole line.
 *
 * Alerts come at most once per interval, the first one at once. Matches in a window wait for it to end, then go out
 * together, showing the latest few and counting the rest. `end()` sends what is still waiting.
 */
export class OutputAlerts {
  private readonly scan: RegExp;
  private readonly intervalMs: number;
  private readonly onAlert: (alert: ShellAlert) => void;
  private readonly now: () => number;
  private readonly setTimer: (run: () => void, ms: number) => () => void;
  private partial: Buffer[] = [];
  private partialBytes = 0;
  /** The last bytes of the line's earlier pieces: the overlap the next window scans again. */
  private tail = Buffer.alloc(0);
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
    // Global, so that exec can start at any index; the caller's global and sticky flags are not needed.
    this.scan = new RegExp(options.pattern.source, options.pattern.flags.replace(/[gy]/g, '') + 'g');
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

  /** Scans the first MAX_LINE_BYTES of the pending line after the overlap of the piece before, never ending a piece inside a UTF-8 character. */
  private cut() {
    const bytes = Buffer.concat(this.partial, this.partialBytes);
    let at = MAX_LINE_BYTES;
    while (at > 0 && (bytes[at] & 0xc0) === 0x80) at--;
    if (at === 0) at = MAX_LINE_BYTES;
    const window = Buffer.concat([this.tail, bytes.subarray(0, at)]), text = window.toString('utf8');
    this.head ??= text;
    this.test(text, this.tail.length ? firstCharUnits(text) : 0, false);
    this.tail = overlapOf(window);
    const rest = Buffer.from(bytes.subarray(at));
    this.partial = [rest];
    this.partialBytes = rest.length;
  }

  private finishLine() {
    const bytes = Buffer.concat(this.partial, this.partialBytes);
    this.partial = []; this.partialBytes = 0;
    let window = Buffer.concat([this.tail, bytes]);
    if (window.length && window[window.length - 1] === CR) window = window.subarray(0, -1);
    const text = window.toString('utf8');
    this.test(text, this.tail.length ? firstCharUnits(text) : 0, true);
    this.context.push({ line: this.line, text: excerpt(this.head ?? text) });
    if (this.context.length > CONTEXT) this.context.shift();
    this.line++; this.lineMatched = false; this.head = undefined; this.tail = Buffer.alloc(0);
  }

  /**
   * Records the line's first match that starts at `from` or later. Unless the window ends the line, a match that runs to
   * the window's end is left for the next window, which holds it in full.
   */
  private test(text: string, from: number, last: boolean) {
    if (this.lineMatched) return;
    this.scan.lastIndex = from;
    for (let found = this.scan.exec(text); found; found = this.scan.exec(text)) {
      if (last || found.index + found[0].length < text.length) {
        this.lineMatched = true;
        this.record(text, found.index);
        return;
      }
      this.scan.lastIndex = found.index + 1;
    }
  }

  private record(text: string, at: number) {
    this.total++;
    const batch = this.batch ??= { matches: 0, firstLine: this.line, lastLine: this.line, shown: [] };
    batch.matches++;
    batch.lastLine = this.line;
    batch.shown.push({ line: this.line, text: excerpt(text, at), before: this.context.map(line => ({ ...line })) });
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
