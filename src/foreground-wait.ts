// The prompt already says "never wait (no sleep, no polling)", yet session 01a1704e spent 38 minutes in 56 foreground
// waits: `sleep 30; gh run list`, `for i in $(seq 1 40); do gh run view …; sleep 10; done`, `gh run watch`. While one
// runs, no message reaches the model. A guard used to refuse them and point to shell_start; over 14 days 37 refusals
// were followed by 29 retries doing just that. The bash mover (shells.ts) now runs such a wait as a background shell
// itself: back inline if it ends within the grace, otherwise its end arrives as a "[shell ID]" message.

/** A command sleeping at least this long in total waits on something; shorter is a readiness pause. */
export const MAX_SLEEP_SECONDS = 15;
/** A loop sleeping at least this long per pass polls; shorter is a readiness retry (`docker info`) or a pause between items. */
export const MAX_LOOP_SLEEP_SECONDS = 10;

const UNIT: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600 };
const SLEEP = /(?:^|[\s;&|(])sleep\s+(\d+(?:\.\d+)?)([smh]?)(?=[\s;&|)'"]|$)|Start-Sleep\s+(?:-s(?:econds)?\s+)?(\d+(?:\.\d+)?)(?=[\s;'")]|$)/gi;
const LOOP_BODY = /\bdo\b([\s\S]*?)\bdone\b/g;
const WATCH = /\bgh\s+run\s+watch\b|\bgh\s+pr\s+checks\b[^;&|\n]*\s--watch\b/;
// A heredoc's body is file content being written, not commands this call runs.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\s|$)/g;

const sleeps = (text: string) => [...text.matchAll(SLEEP)].map(m => m[3] !== undefined ? Number(m[3]) : Number(m[1]) * UNIT[m[2].toLowerCase()]);

/** Why `command` would block the turn waiting on something, or undefined. Pure so the patterns are testable. */
export function foregroundWait(command: string): string | undefined {
  const text = command.replace(HEREDOC, '');
  if (WATCH.test(text)) return 'it watches a run until it ends';
  const polling = Math.max(0, ...[...text.matchAll(LOOP_BODY)].flatMap(m => sleeps(m[1])));
  if (polling >= MAX_LOOP_SLEEP_SECONDS) return `it polls in a loop, sleeping ${polling} s per pass`;
  const total = sleeps(text).reduce((sum, seconds) => sum + seconds, 0);
  if (total >= MAX_SLEEP_SECONDS) return `it sleeps ${total} s`;
  return undefined;
}
