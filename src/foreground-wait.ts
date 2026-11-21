





/** A command sleeping at least this long in total waits on something; shorter is a readiness pause. */
export const MAX_SLEEP_SECONDS = 15;
/** A loop sleeping at least this long per pass polls; shorter is a readiness retry (`docker info`) or a pause between items. */
export const MAX_LOOP_SLEEP_SECONDS = 10;

const UNIT: Record<string, number> = { '': 1, s: 1, m: 60, h: 3600 };
const SLEEP = /(?:^|[\s;&|(])sleep\s+(\d+(?:\.\d+)?)([smh]?)(?=[\s;&|)'"]|$)|Start-Sleep\s+(?:-s(?:econds)?\s+)?(\d+(?:\.\d+)?)(?=[\s;'")]|$)/gi;
const LOOP_BODY = /\bdo\b([\s\S]*?)\bdone\b/g;
const WATCH = /\bgh\s+run\s+watch\b|\bgh\s+pr\s+checks\b[^;&|\n]*\s--watch\b/;

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
