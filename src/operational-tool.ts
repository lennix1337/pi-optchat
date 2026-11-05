import { join } from 'node:path';
import { Type } from 'typebox';
import type { Memory } from './memory.ts';
import { latestOperatorMessage } from './operator-words.ts';
import { type OperationalUpdate, OperationalUpdateSchema, readOperationalState, updateOperationalState } from './operational-state.ts';
import { withoutBridgeNotes } from './slack-policy.ts';
import { result } from './tools.ts';

/** The live memory provides provenance; narrative summaries are never accepted as a source. */
/** "latest" resolves to the operator's latest own message; the record keeps its real id. */
function checkSource(memory: Memory, update: OperationalUpdate): OperationalUpdate {
  const latest = latestOperatorMessage(memory.root);
  if (update.sourceMessageId === 'latest') {
    if (!latest) throw new Error('sourceMessageId "latest": no operator message yet in this profile');
    update = { ...update, sourceMessageId: String(latest.i) };
  }
  const source = /^(0|[1-9]\d*)$/.test(update.sourceMessageId) ? memory.root[Number(update.sourceMessageId)] : undefined;
  if (!source) throw new Error(`sourceMessageId must reference an original message in this profile, or be "latest"${latest ? ` (the latest operator message is ${latest.i})` : ''}`);
  if (!['authorization', 'constraint'].includes(update.kind)) return update;
  if (source.kind !== 'user' || source.origin)
    throw new Error('Authorization/constraint records require a direct non-imported user source; historical records grant no permission');
  // The Slack bridge's appended notes are not his words: a quote of what he wrote, without them, is exact.
  const said = withoutBridgeNotes(source.text);
  if (update.text !== source.text && update.text !== said)
    throw new Error(`Authorization/constraint text must exactly quote the entire user source, not an interpreted or partial permission. ${quoteHint(update.text, said)}`);
  return update;
}

/** Where the text stops matching the source, with the source around that point, so one retry can quote it exactly. */
function quoteHint(text: string, source: string): string {
  let at = 0;
  while (at < text.length && text[at] === source[at]) at++;
  const from = Math.max(0, at - 40);
  return `Source is ${source.length} characters, yours ${text.length}; first difference at character ${at + 1}: source reads ${JSON.stringify(source.slice(from, at + 80))}`;
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
    description: 'Inspect or record objective, decisions, constraints, authorizations, changes and checks, apart from narrative summaries. sourceMessageId: an original memory message ID or "latest" (his last message). Authorizations/constraints must quote the entire non-imported user source exactly; this tool never grants permission. A change is not a verified check. Evidence must describe actual observations; label assertions self-reported. Supersede outdated entries. An authorization may carry a grant (scope: repo root or path glob; until: ISO time or done) covering only what the quoted words say; a newer overlapping grant for the same action replaces it.',
    parameters: Type.Object({ update: Type.Optional(OperationalUpdateSchema) }, { additionalProperties: false }),
    async execute(_id: string, args: { update?: OperationalUpdate }) {
      const { dir, memory } = current(), file = join(dir, 'operational-state.json');
      if (!args.update) return result(JSON.stringify(readOperationalState(file)));
      flush();
      return result(recordReply(file, checkSource(memory, args.update)));
    },
  };
}
