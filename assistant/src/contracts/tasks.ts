import { object, oneOf, positive, text, version } from './validation.ts';
export type TaskStatus = 'suggested' | 'queued' | 'working' | 'needs_input' | 'ready_for_review' | 'succeeded' | 'failed' | 'cancelled' | 'resolved';
export type Verification = 'verified' | 'not_verified' | 'blocked';
export type Task = { version: 1; profileId: string; taskId: string; status: TaskStatus; verification: Verification; revision: number; inputRevision: number; sourceEventId: string };
export type TaskResponse = { version: 1; profileId: string; taskId: string; revision: number; inputRevision: number; text: string };
export type Attempt = { version: 1; profileId: string; taskId: string; runId: string; status: 'planned' | 'claimed' | 'running' | 'effect_uncertain' | 'reconciled' | 'finished' };
const statuses = oneOf('suggested', 'queued', 'working', 'needs_input', 'ready_for_review', 'succeeded', 'failed', 'cancelled', 'resolved');
export function parseTask(value: unknown): Task {
  object(value, { version, profileId: text, taskId: text, status: statuses, verification: oneOf('verified', 'not_verified', 'blocked'), revision: positive, inputRevision: positive, sourceEventId: text });
  return value as Task;
}
export function parseAttempt(value: unknown): Attempt {
  object(value, { version, profileId: text, taskId: text, runId: text, status: oneOf('planned', 'claimed', 'running', 'effect_uncertain', 'reconciled', 'finished') });
  return value as Attempt;
}
const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  suggested: ['queued', 'cancelled', 'resolved'], queued: ['working', 'cancelled'], working: ['needs_input', 'ready_for_review', 'succeeded', 'failed', 'cancelled'], needs_input: ['working', 'cancelled'], ready_for_review: ['working', 'succeeded', 'failed', 'cancelled', 'resolved'], succeeded: ['resolved'], failed: ['queued', 'resolved'], cancelled: ['resolved'], resolved: []
};
export function assertTaskTransition(value: unknown, next: unknown, profileId: string, expectedRevision: number): void {
  const task = parseTask(value);
  if (task.profileId !== profileId || task.revision !== expectedRevision || !statuses(next) || !transitions[task.status].includes(next as TaskStatus)) throw new TypeError('Invalid task transition, profile or revision');
}
export function parseTaskResponse(value: unknown, current: unknown): TaskResponse {
  object(value, { version, profileId: text, taskId: text, revision: positive, inputRevision: positive, text });
  const response = value as TaskResponse;
  const task = parseTask(current);
  if (task.status !== 'needs_input' || response.profileId !== task.profileId || response.taskId !== task.taskId || response.revision !== task.revision || response.inputRevision !== task.inputRevision) throw new TypeError('Stale or mismatched task response');
  return response;
}
