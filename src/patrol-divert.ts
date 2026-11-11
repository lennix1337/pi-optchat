/**
 * Which deadline findings a specialist patrol takes from the manager's wake signals, with no dependencies beyond the deadline rules so the heartbeat and the config read it.
 */
import { GLOBAL_PROJECT, OVERDUE_MS, type DueFinding, type DueState } from './commitment-due.ts';

export type PatrolKind = 'mechanical' | 'code';
/** Config `specialistPatrol`: the worker kind a patrol runs as, and the least hours between two patrols of one specialist. Absent: no patrol. */
export interface PatrolPlan { kind: PatrolKind; minHours: number }
const HOUR_MS = 3_600_000;

export function invalidPatrol(value: unknown) {
  if (value === undefined) return undefined;
  const plan = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  return plan && (plan.kind === 'mechanical' || plan.kind === 'code') && typeof plan.minHours === 'number' && Number.isFinite(plan.minHours) && plan.minHours > 0 ? undefined
    : 'specialistPatrol must be { "kind": "mechanical" | "code", "minHours": hours }, hours a positive number.';
}

/** What the heartbeat asks of the patrol: whether a project has one, whether a worker of it is running, and to start one for these findings (false: could not). */
export interface Patrol {
  plan: PatrolPlan;
  handles(project: string): boolean;
  running(project: string): boolean;
  start(project: string, findings: readonly DueFinding[]): boolean;
}
/** The patrol bookkeeping the heartbeat keeps: when each project was last patrolled, when each item was given to a patrol, and the escalations not yet signalled. */
export interface PatrolState { patrolAt: Record<string, number>; patrolled: Record<string, number>; escalations: { project: string; line: string }[] }

/** Splits the findings of the specialists a patrol handles away from the manager's signals, when a patrol takes them.
 * - A project whose worker is running is held: its findings are neither signalled nor recorded, and come back next tick.
 * - Otherwise, once per `minHours`, the patrol starts and takes the project's findings. A due time is consumed; an overdue item is not recorded as escalated,
 *   so unless the patrol settled it, it is the same plain signal next tick (and goes to the manager then: an item is patrolled once per day).
 * - A project the patrol cannot start for (too soon, or it failed to start) keeps its findings: they go to the manager as before. */
export function divert(found: { findings: DueFinding[]; state: DueState }, previous: DueState, patrol: Patrol, held: PatrolState, now: number):
  { findings: DueFinding[]; state: DueState; patrolAt: Record<string, number>; patrolled: Record<string, number> } {
  const state: DueState = { dueSeen: [...found.state.dueSeen], escalated: { ...found.state.escalated } };
  const patrolAt = { ...held.patrolAt }, patrolled = Object.fromEntries(Object.entries(held.patrolled).filter(([, at]) => now - at < 2 * OVERDUE_MS));
  const undo = (finding: DueFinding) => {
    if (finding.key) state.dueSeen = state.dueSeen.filter(key => key !== finding.key);
    if (finding.kind === 'overdue') { if (previous.escalated[finding.id] === undefined) delete state.escalated[finding.id]; else state.escalated[finding.id] = previous.escalated[finding.id]; }
  };
  const gone = new Set<DueFinding>();
  for (const project of new Set(found.findings.map(finding => finding.project))) {
    if (project === GLOBAL_PROJECT || !patrol.handles(project)) continue;
    const group = found.findings.filter(finding => finding.project === project);
    if (patrol.running(project)) { for (const finding of group) { undo(finding); gone.add(finding); } continue; }
    const fresh = group.filter(finding => finding.kind !== 'overdue' || patrolled[finding.id] === undefined);
    if (!fresh.length || now - (patrolAt[project] ?? -Infinity) < patrol.plan.minHours * HOUR_MS || !patrol.start(project, fresh)) continue;
    patrolAt[project] = now;
    for (const finding of fresh) { gone.add(finding); if (finding.kind === 'overdue') { undo(finding); patrolled[finding.id] = now; } }
  }
  return { findings: found.findings.filter(finding => !gone.has(finding)), state, patrolAt, patrolled };
}

