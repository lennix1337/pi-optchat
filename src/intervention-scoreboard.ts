import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operatorWords } from './operator-words.ts';

type Kind = 'corrections' | 'approvals' | 'questions' | 'other';
type Event = { type?: string; customType?: string; data?: { name?: string }; timestamp?: string; message?: { role?: string; content?: string | { type?: string; text?: string }[] } };
type Day = { date: string; interventions: number; mergedPRs: number; perPR: number | null };
export type InterventionScoreboard = { days: Day[]; week: { interventions: number; mergedPRs: number; perPR: number | null; kinds: Record<Kind, number> }; coverage: { earliestSession: string | null; note: string } };
const date = (at: number) => new Date(at).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
const ratio = (interventions: number, merged: number) => merged ? Math.round(interventions / merged * 100) / 100 : null;

/** Approximate, mutually exclusive categories; corrections take precedence over approvals and questions. */
export function classifyIntervention(text: string): Kind {
  if (/\b(não|nao|errad[oa]|corrig[aeir]|já falei|ja falei|pare de|não era|nao era)\b/iu.test(text)) return 'corrections';
  if (/\b(aprovo|aprovad[oa]|pode|autorizo|sim|aprovar)\b/iu.test(text)) return 'approvals';
  if (/\?|\b(por que|porque|como|quando|qual|quanto|onde|quem)\b/iu.test(text)) return 'questions';
  return 'other';
}

export function tallyScoreboard(sessions: readonly (readonly Event[])[], prs: readonly { mergedAt?: string }[], now: number): InterventionScoreboard {
  const days: Day[] = Array.from({ length: 7 }, (_, i) => ({ date: date(now - (6 - i) * 86_400_000), interventions: 0, mergedPRs: 0, perPR: null }));
  const byDate = new Map(days.map(d => [d.date, d]));
  const kinds: Record<Kind, number> = { corrections: 0, approvals: 0, questions: 0, other: 0 };
  let earliest = Infinity;
  for (const session of sessions) {
    if (!session.some(e => e.type === 'custom' && e.customType === 'optchat.profile' && e.data?.name === 'swlucas05')) continue;
    for (const e of session) {
      if (e.type === 'session') { const at = Date.parse(e.timestamp ?? ''); if (Number.isFinite(at)) earliest = Math.min(earliest, at); }
      if (e.type !== 'message' || e.message?.role !== 'user') continue;
      const at = Date.parse(e.timestamp ?? '');
      if (!Number.isFinite(at) || at > now) continue;
      const d = byDate.get(date(at)); if (!d) continue;
      const content = e.message.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text ?? '').join('') : '';
      if (/^\[Slack #[^\]]+\]/.test(text)) continue;
      const words = operatorWords(text); if (!words) continue;
      d.interventions++; kinds[classifyIntervention(words)]++;
    }
  }
  for (const pr of prs) {
    const at = Date.parse(pr.mergedAt ?? '');
    if (!Number.isFinite(at) || at > now) continue;
    const d = byDate.get(date(at)); if (d) d.mergedPRs++;
  }
  for (const d of days) d.perPR = ratio(d.interventions, d.mergedPRs);
  const interventions = days.reduce((n, d) => n + d.interventions, 0), mergedPRs = days.reduce((n, d) => n + d.mergedPRs, 0);
  return { days, week: { interventions, mergedPRs, perPR: ratio(interventions, mergedPRs), kinds }, coverage: { earliestSession: Number.isFinite(earliest) ? date(earliest) : null, note: 'Somente sessões locais disponíveis; histórico pode estar incompleto.' } };
}

/** Malformed or unreadable logs fail the scan: partial data must never masquerade as a complete baseline. */
export function readSessions(root: string): Event[][] {
  const sessions: Event[][] = [];
  const visit = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) visit(path);
      else if (e.isFile() && e.name.endsWith('.jsonl')) sessions.push(readFileSync(path, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as Event).filter(event => event.type === 'session' || event.type === 'custom' && event.customType === 'optchat.profile' || event.type === 'message' && event.message?.role === 'user'));
    }
  };
  visit(root); return sessions;
}
export function scoreboardLine(result: InterventionScoreboard): string {
  const today = result.days.at(-1)!;
  const fmt = (d: { interventions: number; mergedPRs: number; perPR: number | null }) => `${d.interventions} intervenções / ${d.mergedPRs} PRs (${d.perPR === null ? 'sem PR' : `${d.perPR.toLocaleString('pt-BR')} por PR`})`;
  const k = result.week.kinds;
  return `Intervenções: hoje ${fmt(today)}; 7 dias ${fmt(result.week)} · tipos aproximados: ${k.corrections} correções, ${k.approvals} aprovações, ${k.questions} perguntas, ${k.other} outras. Sessões locais${result.coverage.earliestSession ? ` desde ${result.coverage.earliestSession}` : ''}; histórico possivelmente incompleto.`;
}
