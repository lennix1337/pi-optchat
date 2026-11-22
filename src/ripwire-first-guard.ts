export type ToolUse = { name?: string; arguments?: Record<string, unknown> };

export function usesRipwire(call: ToolUse): boolean {
  return call.name === 'ripwire' || (call.name === 'bash' && /(?:^|[;&|\n(]\s*)(?:\S*[\\/])?ripwire(?:\.exe)?\s/u.test(String(call.arguments?.command ?? '')));
}

export function writesSource(call: ToolUse): boolean {
  if (call.name === 'edit' || call.name === 'write') return !/^(?:\/tmp\/|.*[\\/]\.optchat[\\/])|\.(?:md|txt)$/u.test(String(call.arguments?.path ?? ''));
  if (call.name !== 'bash') return false;
  const command = String(call.arguments?.command ?? '');
  return /(?:>>?\s*(?!\/tmp\/)[^\s&|;<>]+\.(?:ts|tsx|js|mjs|json|md|py|cs|ps1|ya?ml)\b|\bgit\s+(?:apply|commit)\b|\bship\.mjs\b[^\n]*\s-m\s|open\([^)]*,\s*['"]w)/u.test(command) || sedInPlaceOutsideTmp(command);
}

function sedInPlaceOutsideTmp(command: string): boolean {
  return [...command.matchAll(/\bsed\s+-i\b([^\n;&|]*)/gu)].some(([, rest]) => {
    const files = rest.replace(/'[^']*'|"[^"]*"/gu, ' ').trim().split(/\s+/u).filter(arg => arg && !arg.startsWith('-') && /[\\/.]/u.test(arg));
    return !files.length || files.some(file => !file.startsWith('/tmp/'));
  });
}

const REFUSAL = 'Não executado: rode o ripwire (ferramenta `ripwire` ou CLI) para localizar o código e avaliar o impacto antes da primeira escrita de código desta rodada; depois repita a chamada.';

/** One refusal per run: the first source write with no ripwire call before it. Calls after the refusal pass. */
export function ripwireFirstGuard() {
  let seen = false;
  return {
    reset() { seen = false; },
    check(call: ToolUse): string | undefined {
      if (seen) return undefined;
      if (usesRipwire(call)) { seen = true; return undefined; }
      if (!writesSource(call)) return undefined;
      seen = true;
      return REFUSAL;
    },
  };
}

type Hooks = { on(event: string, handler: (event: any, ctx: any) => unknown): unknown };

export function registerRipwireFirst(pi: Hooks, opts: { perInput?: boolean } = {}) {
  if (process.env.OPTCHAT_RIPWIRE_FIRST === 'off') return;
  const guard = ripwireFirstGuard();
  if (opts.perInput) pi.on('input', () => { guard.reset(); });
  pi.on('session_start', () => { guard.reset(); });
  pi.on('tool_call', (event: { toolName: string; input: Record<string, unknown> }) => {
    const reason = guard.check({ name: event.toolName, arguments: event.input });
    return reason ? { block: true, reason } : undefined;
  });
}
