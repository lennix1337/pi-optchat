import { branchEvidenceMessages, evidenceText, unbackedClaims } from './claim-check.ts';

type Hooks = { on(event: string, handler: (event: any, ctx: any) => unknown): unknown };
type Branch = Parameters<typeof branchEvidenceMessages>[0];

const SENDS = new Set(['slack_send', 'whatsapp_send']);
const HISTORY = 400;

/** Refuses once a message to the operator whose claims ("no ar", "#12 mesclado", counts, SHAs) no tool output of the session shows. */
export function sendClaimGuard() {
  const refused = new Set<string>();
  return {
    check(toolName: string, input: Record<string, unknown>, branch: () => Branch): string | undefined {
      if (!SENDS.has(toolName)) return undefined;
      const text = String(input?.text ?? '');
      if (!text || refused.has(text)) return undefined;
      const claims = unbackedClaims(text, evidenceText(branchEvidenceMessages(branch().slice(-HISTORY))));
      if (!claims.length) return undefined;
      refused.add(text);
      return `Não enviado: a mensagem afirma ${claims.map(c => `"${c}"`).join(', ')} sem saída de ferramenta que mostre isso nesta sessão. Leia a evidência (log, gh, curl) antes, ou escreva "não verificado"; repetir o mesmo texto envia.`;
    },
  };
}

export function registerSendClaimGuard(pi: Hooks) {
  if (process.env.OPTCHAT_SEND_CLAIM === 'off') return;
  const guard = sendClaimGuard();
  pi.on('tool_call', (event: { toolName: string; input: Record<string, unknown> }, ctx: { sessionManager: { getBranch(): Branch } }) => {
    const reason = guard.check(event.toolName, event.input, () => ctx.sessionManager.getBranch());
    return reason ? { block: true, reason } : undefined;
  });
}
