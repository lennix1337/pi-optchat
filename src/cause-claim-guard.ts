import type { ToolUse } from './ripwire-first-guard.ts';

type Hooks = { on(event: string, handler: (event: any, ctx: any) => unknown): unknown };

const SEND_CLAIM = /\b(?:achei\s+(?:o\s+buraco|a\s+causa)|causa\s+(?:achada|encontrada|raiz)|found\s+the\s+(?:cause|bug))\b/iu;
const GH_CLAIM = /\b(?:causa\s+(?:achada|encontrada|raiz)|root\s+cause\s+(?:found|is))\b/iu;
const HEDGE = /\b(?:hip[óo]tese|n[ãa]o\s+verificad\w*|unverified|hypothesis)\b/iu;

/** A WhatsApp/Slack report or a gh issue/PR comment that says the cause was found, with no hedge: a hypothesis stated as fact. */
export function claimsCause(call: ToolUse): boolean {
  const command = String(call.arguments?.command ?? '');
  const message = String(call.arguments?.text ?? '');
  if (call.name === 'whatsapp_send' || call.name === 'slack_send') return SEND_CLAIM.test(message) && !HEDGE.test(message);
  return call.name === 'bash' && /\bgh\s+(?:issue|pr)\s+(?:comment|close)\b/u.test(command) && GH_CLAIM.test(command) && !HEDGE.test(command);
}

const REFUSAL = 'Não executado: o texto diz que a causa foi achada, sem prova e sem ressalva. Reproduza a falha e mostre que a correção a elimina; faça isso agora, neste run; "hipótese" só se a reprodução depender de algo que só o operador tem. Repita a mesma chamada só se a causa foi de fato provada neste run.';

/** Refuses an unhedged cause claim once per identical call. */
export function causeClaimGuard() {
  const refused = new Set<string>();
  return {
    check(call: ToolUse): string | undefined {
      if (!claimsCause(call)) return undefined;
      const key = JSON.stringify(call.arguments);
      if (refused.has(key)) return undefined;
      refused.add(key);
      return REFUSAL;
    },
  };
}

export function registerCauseClaimGuard(pi: Hooks) {
  if (process.env.OPTCHAT_CAUSE_CLAIM === 'off') return;
  const guard = causeClaimGuard();
  pi.on('tool_call', (event: { toolName: string; input: Record<string, unknown> }) => {
    const reason = guard.check({ name: event.toolName, arguments: event.input });
    return reason ? { block: true, reason } : undefined;
  });
}
