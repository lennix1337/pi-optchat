// A wake's council: before it picks the delivery, the wake posts its candidates to Slack and the least used
// Codex account answers in the same thread, under its own name, with a pick, an objection and a gap. One round;
// the wake decides. Claude (the wake itself) never advises itself, and an exhausted account never advises.
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

export function advisorPrompt(candidates: string): string {
  return `Você é o conselheiro de um wake: um turno autônomo de um assistente (Jarvis) que trabalha sozinho para o operador, um dev brasileiro dono da DentAI (SaaS odontológico), do Genexus18MCP e de uma harness de agentes (Pi/OptChat).
O que ele valoriza: YAGNI e KISS, resultado entregue (PR mergeado) em vez de relatório, velocidade, autonomia, inovar em vez de só manter.
O wake listou estes candidatos para a entrega de agora, com notas:

${candidates}

Responda em português, em até 90 palavras, direto, sem cumprimentos:
1. Qual você escolheria e por quê, em uma frase.
2. A objeção mais forte à escolha de maior nota (risco, custo, ou por que não é o que mais importa agora).
3. O que ficou de fora e merecia estar na lista, se houver.`;
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
