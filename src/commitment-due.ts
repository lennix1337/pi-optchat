/**
 * What a commitment's deadline makes of it, with no dependencies so the heartbeat, the commitments tool and the patrol read the same rule:
 * a due time that passes is one signal, and an item overdue for a day is escalated once a day until it is closed, narrowed or made a question.
 */
export const OVERDUE_MS = 24 * 3_600_000;
/** The heartbeat timer fires this long after a due time, so the due has passed when it does. */
export const DUE_SLACK_MS = 30_000;
export const GLOBAL_PROJECT = 'global';
/** The three ways out of an overdue-24h item; the signal, the context block and the refusal all say them the same way. */
export const ESCALATION_RULE = 'close it with evidence, narrow it (new due + next), or make it a direct question to the operator (status waiting_operator with choices)';

/** The part of a commitment the deadline rules read. */
export interface DueItem {
  id: string; text: string; owner: string; status: string; due?: string; project?: string; choices?: readonly string[];
}
const isClosed = (status: string) => status === 'done' || status === 'dropped';
const dueMs = (item: DueItem) => item.due === undefined ? NaN : Date.parse(item.due);
/** The items the operator owes are his to settle: the deadline rules concern what OptChat promised. */
const ours = (item: DueItem) => item.owner === 'optchat' && !isClosed(item.status);

/** Open or blocked, or waiting on the operator without a question to tap, and overdue for a day or more. A waiting item with choices is the question already. */
export function overdueDay(item: DueItem, now: number) {
  if (!ours(item) || !(now - dueMs(item) >= OVERDUE_MS)) return false;
  return item.status !== 'waiting_operator' || !item.choices?.length;
}
export const escalationLine = (id: string) => `overdue 24h+: ${id} - ${ESCALATION_RULE}`;

/** What the heartbeat remembers between ticks: the due times already signalled (`id@due`) and when each item was last escalated. */
export interface DueState { dueSeen: string[]; escalated: Record<string, number> }
/** One thing a tick found about an item; `kind` says which rule. */
export interface DueFinding { id: string; project: string; kind: 'due' | 'overdue'; line: string; key?: string }

/** The signals of this tick and the state to keep once the tick settles. A due time signals once (its key stays recorded while the item is open); an item overdue
 * for a day signals instead of its due line, at most once per day; closed items and items no longer there leave the state. */
export function dueFindings(items: readonly DueItem[], state: DueState, now: number): { findings: DueFinding[]; state: DueState } {
  const findings: DueFinding[] = [], dueSeen: string[] = [], escalated: Record<string, number> = {};
  for (const item of items) {
    if (!ours(item)) continue;
    const project = item.project ?? GLOBAL_PROJECT, at = dueMs(item);
    if (Number.isFinite(at) && at <= now) {
      const key = `${item.id}@${item.due}`;
      dueSeen.push(key);
      if (!state.dueSeen.includes(key) && !overdueDay(item, now)) findings.push({ id: item.id, project, kind: 'due', line: `commitment due: ${item.id} ${item.text}`, key });
    }
    const last = state.escalated[item.id];
    if (last !== undefined) escalated[item.id] = last;
    if (overdueDay(item, now) && (last === undefined || now - last >= OVERDUE_MS)) {
      escalated[item.id] = now;
      findings.push({ id: item.id, project, kind: 'overdue', line: escalationLine(item.id) });
    }
  }
  return { findings, state: { dueSeen, escalated } };
}

/** The soonest due time of an open item after `now`, or undefined: the heartbeat arms its timer for it. */
export function nextDue(items: readonly DueItem[], now: number): number | undefined {
  const times = items.filter(ours).map(dueMs).filter(at => at > now);
  return times.length ? Math.min(...times) : undefined;
}
