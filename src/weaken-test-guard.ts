import type { ToolUse } from './ripwire-first-guard.ts';

type Hooks = { on(event: string, handler: (event: any, ctx: any) => unknown): unknown };

const TEST_PATH = /(?:^|[\\/])(?:test|tests|__tests__)(?:[\\/])|\.(?:test|spec)\.[cm]?[jt]sx?$/iu;
const NAMED_LIMIT = /\b(?:timeout|budget)[\w]*\s*[:=]\s*(\d+)/iu;

/** An edit of a test file that adds a skip or a retry, or raises a named timeout or budget: the test is loosened, not fixed. */
export function weakensTest(call: ToolUse): boolean {
  if (call.name !== 'edit' || !TEST_PATH.test(String(call.arguments?.path ?? ''))) return false;
  const edits = Array.isArray(call.arguments?.edits) ? call.arguments.edits : [call.arguments];
  return edits.some((e: { oldText?: string; newText?: string }) => {
    const old = e.oldText ?? '', next = e.newText ?? '';
    if (/\.skip\b|\bretry\b/iu.test(next) && !/\.skip\b|\bretry\b/iu.test(old)) return true;
    const before = old.match(NAMED_LIMIT), after = next.match(NAMED_LIMIT);
    return !!before && !!after && Number(after[1]) > Number(before[1]);
  });
}

const REFUSAL = 'Não executado: a edição afrouxa um teste (skip, retry ou timeout/budget maior). Teste de tempo ou instável não se afrouxa: ache o que ficou mais lento ou corrija a causa. Só repita a mesma chamada se o operador mandou afrouxar este teste.';

/** Refuses a loosening edit once per identical call; the operator's own order is the only reason to repeat it. */
export function weakenTestGuard() {
  const refused = new Set<string>();
  return {
    check(call: ToolUse): string | undefined {
      if (!weakensTest(call)) return undefined;
      const key = JSON.stringify(call.arguments);
      if (refused.has(key)) return undefined;
      refused.add(key);
      return REFUSAL;
    },
  };
}

export function registerWeakenTestGuard(pi: Hooks) {
  if (process.env.OPTCHAT_WEAKEN_TEST === 'off') return;
  const guard = weakenTestGuard();
  pi.on('tool_call', (event: { toolName: string; input: Record<string, unknown> }) => {
    const reason = guard.check({ name: event.toolName, arguments: event.input });
    return reason ? { block: true, reason } : undefined;
  });
}
