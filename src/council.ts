// A wake's council: before it picks the delivery, the wake posts its candidates to Slack and the least used
// Codex account and agy debate it in the same thread, each under its own name (critique, disagreement, rebuttal);
// the wake decides and says whether the debate changed its leaning. Claude (the wake itself) never advises itself, and an exhausted account never advises.
import { execFile } from 'node:child_process';
import { accounts } from './quota-health.ts';

export const ADVISOR_MODEL = 'gpt-6.2-sol';
export interface Advisor { account: string; model: string; used: number }

/** The second advisor: agy (Gemini, its own quota) on the PC, through agy-pc.mjs --ask (plan mode, no repo). */
export const AGY_ADVISOR: Advisor = { account: 'agy', model: 'agy/gemini-4-neon-high', used: 0 };

/** What agy-worker answered, from agy-pc's output: the lines after agy-worker's conversation line and before its
 *  "(agy model: ...)" footer; undefined when the footer is missing (a refused or failed run). */
export function agyAnswer(output: string): string | undefined {
  const end = output.indexOf('\n(agy model:');
  if (end < 0) return undefined;
  const lines = output.slice(0, end).split('\n');
  const start = lines.findLastIndex(l => l.startsWith('agy-worker: conversation'));
  return lines.slice(start + 1).filter(l => !/^(started PiTask|Fetching available models)/.test(l)).join('\n').trim() || undefined;
}

/** The Codex account that offers the advisor model with the most room now (lowest used % of its fullest window);
 *  undefined when none can answer. */
export function pickAdvisor(state: unknown, now: number, offers: (account: string) => boolean = () => true): Advisor | undefined {
  const usable = accounts(state, now)
    .filter(a => a.id.startsWith('openai-codex') && offers(a.id) && a.blockedUntil === undefined && a.used !== undefined && a.used < 100)
    .sort((a, b) => a.used! - b.used! || a.id.localeCompare(b.id));
  const best = usable[0];
  return best && { account: best.id, model: `${best.id}/${ADVISOR_MODEL}`, used: best.used! };
}

export type DebateRole = 'critic' | 'second' | 'rebuttal';
export interface DebateTurn { advisor: Advisor; role: DebateRole }

/** Who speaks, in order. With two advisors: the first criticizes, the second disagrees with what was said, the
 *  first answers it; with one, a single critique. The proposal and the wake's decision make it 5 messages at most. */
export function debateTurns(advisors: Advisor[]): DebateTurn[] {
  const [a, b] = advisors;
  if (!a) return [];
  if (!b) return [{ advisor: a, role: 'critic' }];
  return [{ advisor: a, role: 'critic' }, { advisor: b, role: 'second' }, { advisor: a, role: 'rebuttal' }];
}

const ROLE_ASK: Record<DebateRole, string> = {
  critic: `Você abre o debate. Não concorde por padrão: concordar só vale se você procurou a falha e não achou, e então diga qual verificação sustenta a escolha. Ataque a inclinação do wake: a objeção mais forte (risco, custo, evidência que falta, ou por que não é o que mais importa agora). Proponha uma alternativa fora da lista ou um jeito diferente de fazer, e diga por que ela ganharia.`,
  second: `Discorde de pelo menos um ponto do que já foi dito (do wake ou do outro conselheiro) e diga por quê. Não repita argumentos já postos: traga um ângulo novo (o operador, o negócio, o que pode dar errado, o que é mais simples). Termine com a sua escolha.`,
  rebuttal: `Responda ao segundo conselheiro: diga o que você concede e o que mantém, com o motivo. Não mude de lado só para agradar, nem fique só por teimosia. Termine com a recomendação final em uma frase.`,
};

/** One turn's prompt: the operator's context, the wake's candidates and leaning, what was said so far, and the turn's
 *  job. The council exists to bring disagreement and other ideas, not approval (operator, 19/11). */
export function debatePrompt(candidates: string, transcript: string[], role: DebateRole): string {
  const said = transcript.length ? `\n\nO debate até agora:\n${transcript.join('\n')}` : '';
  return `Você é um conselheiro crítico num debate de no máximo 5 mensagens sobre o que um wake vai fazer agora: um turno autônomo de um assistente (Jarvis) que trabalha sozinho para o operador, um dev brasileiro dono da DentAI (SaaS odontológico), do Genexus18MCP e de uma harness de agentes (Pi/OptChat).
O que ele valoriza: YAGNI e KISS, resultado entregue (PR mergeado) em vez de relatório, velocidade, autonomia, inovar em vez de só manter. Ele quer debate e ideias diferentes, não uma lista de concordâncias.
O wake propôs estes candidatos, com notas e a inclinação dele:

${candidates}${said}

${ROLE_ASK[role]}
Responda em português, em até 90 palavras, em prosa direta, sem cumprimentos e sem lista numerada.`;
}

/** Whether the wake's decision says the debate changed its leaning ("Mudou: sim|não"); undefined when unsaid. */
export function decisionChanged(decision: string): boolean | undefined {
  const m = /mudou\s*:\s*(sim|não|nao)/i.exec(decision);
  return m ? m[1].toLowerCase() === 'sim' : undefined;
}

/** Whether a provider in Pi's models.json lists the advisor model; a missing or unreadable file offers none. */
export function offersModel(modelsJson: string | undefined, model = ADVISOR_MODEL): (account: string) => boolean {
  let providers: Record<string, { models?: { id?: string }[] }> = {};
  try { providers = JSON.parse(modelsJson ?? '{}').providers ?? {}; } catch { /* none */ }
  return account => !!providers[account]?.models?.some(m => m.id === model);
}

/** Runs the advisor (`pi -p ...` by default) and returns its answer or a short error. Stdin is closed at once:
 *  `pi -p` reads a piped stdin to its end, so an open pipe hangs it until the timeout. */
export function askAdvisor(args: string[], options: { command?: string; timeoutMs?: number } = {}): Promise<{ text?: string; error?: string }> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  return new Promise(resolve => {
    const child = execFile(options.command ?? 'pi', args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
      if (!error) return resolve({ text: stdout.trim() });
      if (error.killed) return resolve({ error: `sem resposta em ${timeoutMs / 1000} s` });
      resolve({ error: (stderr.trim() || `saiu com código ${error.code}`).slice(-300) });
    });
    child.stdin?.end();
  });
}

/** The thread line that shows who said it. */
export function advisorLine(advisor: Advisor, answer: string): string {
  return `🤖 *${advisor.model.slice(advisor.account.length + 1)} · ${advisor.account}* (conselheiro): ${answer.trim()}`;
}
