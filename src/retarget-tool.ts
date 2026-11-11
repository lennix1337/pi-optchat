import type { Children } from './agents.ts';
import { childToolSchemas } from './child-resources.ts';
import type { ModelChoice } from './compactor.ts';
import { result } from './tools.ts';

/** Registerable without a UI; dispatch failures are returned by Pi to the calling agent. */
export function retargetTool(children: () => Children, launched: (toolId: string, workerId: string) => void) {
  return {
    name: 'retarget', label: 'Retarget worker', description: 'Resume a settled OptChat worker with its saved conversation on an explicitly chosen model or thinking level. Never switches automatically; active and unstarted workers are refused.',
    parameters: childToolSchemas.retarget,
    async execute(id: string, args: { id: string; message: string; model?: string; thinking?: ModelChoice['thinking'] }) {
      if (args.model === undefined && args.thinking === undefined) throw new Error('Specify model or thinking; use tell without overrides.');
      const text = await children().tell(args.id, args.message, 'manager', undefined, false, { model: args.model, thinking: args.thinking });
      launched(id, args.id);
      return { ...result(text), details: { runIds: [args.id] } };
    },
  };
}
