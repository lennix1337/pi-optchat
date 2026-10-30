import { join } from 'node:path';
import { Type } from 'typebox';
import type { Memory } from './memory.ts';
import { type OperationalUpdate, OperationalUpdateSchema, readOperationalState, updateOperationalState } from './operational-state.ts';
import { result } from './tools.ts';

/** The live memory provides provenance; narrative summaries are never accepted as a source. */
function checkSource(memory: Memory, update: OperationalUpdate) {
  const source = /^(0|[1-9]\d*)$/.test(update.sourceMessageId) ? memory.root[Number(update.sourceMessageId)] : undefined;
  if (!source) throw new Error('sourceMessageId must reference an original message in this profile');
  if (!['authorization', 'constraint'].includes(update.kind)) return;
  if (source.kind !== 'user' || source.origin)
    throw new Error('Authorization/constraint records require a direct non-imported user source; historical records grant no permission');
  if (update.text !== source.text)
    throw new Error('Authorization/constraint text must exactly quote the entire user source, not an interpreted or partial permission');
}

/** The new record and the count, not the whole document: echoing every record on each update cost tens of KB per call. */
function recordReply(file: string, update: OperationalUpdate) {
  const before = readOperationalState(file).entries.length, next = updateOperationalState(file, update);
  const recorded = next.entries.length > before ? next.entries.at(-1) : undefined;
  return JSON.stringify({ recorded: recorded ?? 'already recorded (identical entry exists)', entries: next.entries.length });
}

export function operationalStateTool(current: () => { dir: string; memory: Memory }, flush: () => void) {
  return {
    name: 'operational_state', label: 'Operational state',
    description: 'Inspect or explicitly record objective, decisions, constraints, authorizations, changes and checks, separately from narrative summaries. sourceMessageId is an exact original memory message ID. Authorizations/constraints must quote the entire non-imported user source exactly; this tool never grants permission. A change is not a verified check. Evidence must describe actual observations; label assertions self-reported. Supersede outdated entries explicitly. An authorization may carry a grant (scope: repo root or path glob; until: ISO time or done) covering only what the quoted words say; a newer overlapping grant for the same action replaces it.',
    parameters: Type.Object({ update: Type.Optional(OperationalUpdateSchema) }, { additionalProperties: false }),
    async execute(_id: string, args: { update?: OperationalUpdate }) {
      const { dir, memory } = current(), file = join(dir, 'operational-state.json');
      if (!args.update) return result(JSON.stringify(readOperationalState(file)));
      flush();
      checkSource(memory, args.update);
      return result(recordReply(file, args.update));
    },
  };
}
