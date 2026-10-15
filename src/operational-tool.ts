import { join } from 'node:path';
import { Type } from 'typebox';
import type { Memory } from './memory.ts';
import { OperationalUpdateSchema, readOperationalState, updateOperationalState } from './operational-state.ts';
import { result } from './tools.ts';

/** The live memory provides provenance; narrative summaries are never accepted as a source. */
export function operationalStateTool(current: () => { dir: string; memory: Memory }, flush: () => void) {
  return {
    name: 'operational_state', label: 'Operational state',
    description: 'Inspect or explicitly record objective, decisions, constraints, authorizations, changes and checks separately from narrative summaries. Use an exact original memory message ID as sourceMessageId. Authorizations/constraints must quote the entire non-imported user source exactly; this tool never grants permission. A change is not a verified check. Evidence references must describe actual observations; label assertions self-reported. Supersede outdated entries explicitly.',
    parameters: Type.Object({ update: Type.Optional(OperationalUpdateSchema) }),
    async execute(_id: string, args: { update?: import('./operational-state.ts').OperationalUpdate }) {
      const { dir, memory } = current(), file = join(dir, 'operational-state.json');
      if (args.update) {
        flush();
        const source = /^(0|[1-9]\d*)$/.test(args.update.sourceMessageId) ? memory.root[Number(args.update.sourceMessageId)] : undefined;
        if (!source) throw new Error('sourceMessageId must reference an original message in this profile');
        if (['authorization', 'constraint'].includes(args.update.kind)) {
          if (source.kind !== 'user' || source.origin)
            throw new Error('Authorization/constraint records require a direct non-imported user source; historical records grant no permission');
          if (args.update.text !== source.text)
            throw new Error('Authorization/constraint text must exactly quote the entire user source, not an interpreted or partial permission');
        }
      }
      return result(JSON.stringify(args.update ? updateOperationalState(file, args.update) : readOperationalState(file)));
    },
  };
}
