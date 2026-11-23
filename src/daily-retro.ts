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
    `Daily retro (operator 03/11, standing order), ${date}. A retro is action, not a diary (operator 14/11: "é pra analisar o dia e melhorar o que foi ruim, não me contar o que aconteceu").`,
    'Run the `retro` skill (~/.agents/skills/retro/SKILL.md) over today\'s work in this chat and hunt for what went badly, each with its evidence:',
    'slow deliveries, low-quality merges, replies he had to correct, Slack/Home friction, and every wake that ended without shipping a change.',
    'Measure before judging (operator 21/11: "era pra achar ainda mais coisas pra corrigir e melhorar, velocidade, qualidade, entregas mais precisas, mas agora vc só fica relatando oq fez no dia"): order -> merge time, tool calls and retries per delivery, red CI and reverted or re-fixed merges, claims the claim check caught, hits of `node scripts/correction-scan.mjs` over the day.',
    'Find at least three NEW problems in speed, quality and precision. Fixes already shipped during the day are not retro findings and never go in the DM; a retro that only lists them failed.',
    'For each one, find why it happened and ship the fix now, without asking: harness code (PR + auto-merge), the active profile AGENTS.md, skills, and autonomy.json',
    '(edit/write of the file; rules for deploy, production writes, paid runs, messages, consent, publish, force-push, installs, `*` and the default stay his and need his tap).',
    'Each fix gets a regression test or a measurement where one applies; before shipping a guard or claim-check change, run `npm run replay` to confirm no rule regresses (`npm run replay -- --update` only after reviewing an intentional baseline change); mirror profile changes in dotfiles payload/pi.',
    ...machine.length ? ['Measured cost centres of the last 24 h on this PC (machine ledger; the `machine` tool has the detail). Treat each as a candidate optimisation, and say which you changed:', ...machine.map(line => `- ${line}`)] : [],
    'Nightly predictions: read today’s operator messages and use `predictions` to score each prediction made yesterday for today as hit (with a short matching quote) or miss; never store full operator messages.',
    'Based on recurring asks, open PRs/issues and dates, predict the three things he is most likely to ask tomorrow. Record all three with status predicted, tomorrow’s date and brief evidence before acting.',
    'Then do only those inside existing authority, and record status done with the PR or commit link. Git, PRs, merges, restarts and publishing his own packages are free; never deploy, write production data, spend money, message third parties or change accounts.',
    'Finish with one short Slack DM listing only problem -> fix shipped (with its PR or commit) and anything that needs his decision. Never recap the day\'s work: he lived it.',
  ].join('\n');
}
