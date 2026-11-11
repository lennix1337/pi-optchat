import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './store.ts';

/** Operator 03/11: at the end of every day a retro runs over the day's work and applies what improves speed and quality. */
export const RETRO_FILE = 'retro-daily.json';
export const DEFAULT_RETRO_AT = '22:00';

const localDate = (at: number) => new Date(at).toLocaleDateString('sv-SE');

/** Whether today's retro is due at `now`: after `at` local time and not yet started today. */
export function retroDue(dir: string, now: number, at = DEFAULT_RETRO_AT): boolean {
  const [hh, mm] = at.split(':').map(Number);
  const local = new Date(now);
  if (local.getHours() * 60 + local.getMinutes() < hh! * 60 + (mm ?? 0)) return false;
  try { return (JSON.parse(readFileSync(join(dir, RETRO_FILE), 'utf8')) as { date?: string }).date !== localDate(now); }
  catch { return true; }
}

/** Records that today's retro started, before the turn is sent: a crash mid-turn must not start it twice. */
export function markRetro(dir: string, now: number) {
  atomicWrite(join(dir, RETRO_FILE), JSON.stringify({ date: localDate(now), startedAt: now }));
}

export function retroPrompt(date: string, machine: string[] = []) {
  return [
    `Daily retro (operator 03/11, standing order), ${date}. Run the \`retro\` skill (~/.agents/skills/retro/SKILL.md) over today's work in this chat:`,
    'what slowed delivery, what lowered quality, replies he had to correct, Slack/Home UX friction, and what wakes did or failed to do.',
    'Then apply every relevant fix now, without asking: harness code (PR + auto-merge), the swlucas05 profile AGENTS.md, skills, and autonomy.json',
    '(edit/write of the file; rules for deploy, production writes, paid runs, messages, consent, publish, force-push, installs, `*` and the default stay his and need his tap).',
    'Each fix gets a regression test or a measurement where one applies; mirror profile changes in dotfiles payload/pi.',
    ...machine.length ? ['Measured cost centres of the last 24 h on this PC (machine ledger; the `machine` tool has the detail). Treat each as a candidate optimisation, and say which you changed:', ...machine.map(line => `- ${line}`)] : [],
    'Finish with one short Slack DM: what changed, what it should improve, and anything that needs his decision.',
  ].join('\n');
}
