import type { ToolUse } from './ripwire-first-guard.ts';

export const FULL_SUITE = /(?:^|[;&|\n(])\s*(?:npm\s+(?:run\s+)?(?:test|verify)\b(?![:\w-])|node\b[^;&|\n]*\s--test\b[^;&|\n]*["']test\/\*)/u;

export const runsSuite = (call: ToolUse): boolean =>
  (call.name === 'bash' || call.name === 'shell_start') && FULL_SUITE.test(String(call.arguments?.command ?? ''));

const REFUSAL = 'Não executado: a suíte completa já rodou nesta rodada. Entre mudanças use só o teste focado, tsc e lint; se esta é a suíte final, repita a chamada.';

type Hooks = { on(event: string, handler: (event: any, ctx: any) => unknown): unknown };

/** The second full-suite command of a run is refused once; the retry passes. */
export function registerSuiteOnceGuard(pi: Hooks) {
  if (process.env.OPTCHAT_SUITE_ONCE === 'off') return;
  let suites = 0;
  let refused = false;
  const reset = () => { suites = 0; refused = false; };
  pi.on('input', reset);
  pi.on('before_agent_start', (event: { messageType: string; message?: { customType?: string } }) => {
    if (event.messageType === 'custom' && event.message?.customType === 'optchat-report') reset();
  });
  pi.on('session_start', reset);
  pi.on('tool_call', (event: { toolName: string; input: Record<string, unknown> }) => {
    if (!runsSuite({ name: event.toolName, arguments: event.input })) return undefined;
    if (suites >= 1 && !refused) {
      refused = true;
      return { block: true, reason: REFUSAL };
    }
    suites++;
    return undefined;
  });
}
