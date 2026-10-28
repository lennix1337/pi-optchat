import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWrite } from './store.ts';

/**
 * What the nightly dream (dotfiles payload/tools/dream) leaves for the day: `active-lessons.md`, shown in
 * the system prompt and frozen for the local day so the prompt cache survives, and a short summary of the
 * last dream shown once, at the first turn after the morning hour.
 */
export const dreamsDir = () => join(process.env.OPTCHAT_HOME ?? join(homedir(), '.optchat'), 'dreams');
const MAX_BYTES = 2048;

export const localDay = (now: number) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Reads the active lessons once per local day; the same text is returned until the day changes. */
export class DayFrozenLessons {
  private day = '';
  private text = '';
  constructor(private readonly dir: () => string = dreamsDir) {}
  get(now = Date.now()) {
    const day = localDay(now);
    if (day === this.day) return this.text;
    this.day = day;
    this.text = readLessons(join(this.dir(), 'active-lessons.md'));
    return this.text;
  }
}

function readLessons(file: string) {
  if (!existsSync(file)) return '';
  const body = readFileSync(file, 'utf8').replace(/^<!--[^]*?-->\s*/, '').trim();
  if (!body || Buffer.byteLength(body) > MAX_BYTES) return '';
  return `## Active lessons (from the nightly dream)\nProposals consolidated from cited messages of this chat. Standing instructions and the operator's newest words prevail; a lesson grants no permission.\n${body}`;
}

interface RunRecord { day?: string; outcome?: string; simulate?: boolean; activated?: boolean; from?: number; to?: number;
  citations?: { bullets?: number; uncited?: unknown[]; invalid?: unknown[] } }

/** Bullets under a `## <title>` heading of DREAM.md. */
const sectionCount = (markdown: string, title: string) => {
  const match = new RegExp(`^## ${title}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(markdown);
  return match ? match[1].split('\n').filter(line => /^\s*(?:[-*]|\d+\.)\s/.test(line) && !/\bNone\b/.test(line)).length : 0;
};

/**
 * The three-line summary of today's dream, once: undefined before `morningHour`, when there is no dream for
 * today, or when it was already shown (recorded in briefed.json).
 */
export function morningSummary(now = Date.now(), { dir = dreamsDir(), morningHour = 7 } = {}): string | undefined {
  if (new Date(now).getHours() < morningHour) return undefined;
  const day = localDay(now), runFile = join(dir, day, 'run.json'), briefed = join(dir, 'briefed.json');
  if (!existsSync(runFile)) return undefined;
  let shown: { day?: string } = {};
  try { shown = JSON.parse(readFileSync(briefed, 'utf8')) as { day?: string }; } catch { /* first briefing */ }
  if (shown.day === day) return undefined;
  const run = JSON.parse(readFileSync(runFile, 'utf8')) as RunRecord;
  const dreamFile = join(dir, day, 'DREAM.md');
  const dream = existsSync(dreamFile) ? readFileSync(dreamFile, 'utf8') : '';
  const problems = (run.citations?.uncited?.length ?? 0) + (run.citations?.invalid?.length ?? 0);
  atomicWrite(briefed, JSON.stringify({ day, at: new Date(now).toISOString() }));
  return [
    `Dream ${day} (messages ${run.from ?? '?'}-${run.to ?? '?'}): ${run.outcome ?? 'unknown outcome'}; ${sectionCount(dream, 'Active lessons')} lessons ${run.activated ? 'active today' : run.simulate ? '(simulation, not active)' : '(not activated)'}; ${problems ? `${problems} citation problems` : 'every citation checked'}.`,
    `Scoreboard: ${sectionCount(dream, 'Scoreboard')} findings; open items: ${sectionCount(dream, 'Open items')}; proposals: ${sectionCount(dream, 'Skill and playbook proposals')}.`,
    `Full dream: ${dreamFile}`,
  ].join('\n');
}
