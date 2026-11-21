import { writesSource, type ToolUse } from './ripwire-first-guard.ts';

const REFUSAL = 'Não executado: delegue a um worker com spawn (kind e model) ou ~/.pi/agent/bin/agy-pc.mjs; se for uma correção de poucas linhas, repita a chamada.';

type Hooks = { on(event: string, handler: (event: any, ctx: any) => unknown): unknown };

export function registerSelfBuildGuard(pi: Hooks, opts: { perInput?: boolean } = {}) {
  if (process.env.OPTCHAT_SELF_BUILD_GUARD === 'off') return;
  let wake = false;
  let writes = 0;
  let refused = false;
  const reset = (text = '') => { wake = text.startsWith('[OptChat heartbeat]'); writes = 0; refused = false; };
  if (opts.perInput) {
    pi.on('input', (event: { text?: string }) => { reset(event.text); });
    pi.on('before_agent_start', (event: { messageType: string; message?: { customType?: string; content?: unknown } }) => {
      if (event.messageType === 'custom' && event.message?.customType === 'optchat-report')
        reset(typeof event.message.content === 'string' ? event.message.content : '');
    });
  }
  pi.on('session_start', () => { reset(); });
  pi.on('tool_call', (event: { toolName: string; input: Record<string, unknown> }) => {
    if (!wake) return undefined;
    const call: ToolUse = { name: event.toolName, arguments: event.input };
    const delegated = call.name === 'spawn' || call.name === 'tell' || (call.name === 'bash' &&
      String(call.arguments?.command ?? '').split(/[;&|\n]/u).some(command =>
        /^\s*node(?:\.exe)?\s+["']?(?:[^\s"';&|]*[\\/])?agy-(?:worker|pc)\.mjs["']?(?:\s|$)/u.test(command) && !/\s--(?:quota|help|version)\b/u.test(command)));
    if (delegated) { writes = 0; return undefined; }
    if (writesSource(call) && ++writes === 3 && !refused) {
      refused = true;
      return { block: true, reason: REFUSAL };
    }
    return undefined;
  });
}
