import { boundedText, object, oneOf, text, timestamp, version } from './validation.ts';

/**
 * One observation from a sensor (gitwatch/CI, shell, subagent, quota, health, PC, Google, routine or the service
 * itself). A signal is data, never authority: it can open an issue or a notification, and never dispatches work.
 *
 * `dedupeKey` identifies the external event, not the polling round: the same CI failure or shell end is stored once.
 * `attention: 'wake'` says the producer refrained from waking the model and expects the deterministic path to decide;
 * `attention: 'notify'` says the old path did not wake either. The metric only counts real substitutions.
 */
export const signalSources = ['ci', 'gitwatch', 'google', 'health', 'pc', 'quota', 'routine', 'service', 'shell', 'slack', 'subagent'] as const;
export const signalKinds = [
  'ci.failed', 'ci.passed', 'pr.conflict', 'pr.merged',
  'shell.failed', 'shell.succeeded', 'subagent.failed', 'subagent.completed',
  'quota.exhausted', 'quota.near', 'quota.recovered',
  'health.down', 'health.recovered',
  'pc.disk_low', 'pc.memory_low', 'pc.maintenance_stale', 'pc.recovered',
  'google.unavailable', 'google.recovered',
  'routine.failed', 'routine.succeeded',
  'slack.unanswered',
  'service.started', 'service.stopped',
] as const;
export const signalSeverities = ['info', 'warning', 'critical'] as const;
export const signalAttention = ['notify', 'wake'] as const;
export type SignalSource = typeof signalSources[number];
export type SignalKind = typeof signalKinds[number];
export type SignalSeverity = typeof signalSeverities[number];
export type SignalAttention = typeof signalAttention[number];
export type Signal = {
  version: 1;
  signalId: string;
  profileId: string;
  source: SignalSource;
  kind: SignalKind;
  severity: SignalSeverity;
  observedAt: string;
  dedupeKey: string;
  subject: string;
  summary: string;
  correlationId: string | null;
  attention: SignalAttention;
  evidence: { kind: 'observed'; reference: string };
};

const nullableText = (value: unknown) => value === null || boundedText(200)(value);
const source = oneOf(...signalSources);
const kind = oneOf(...signalKinds);
const severity = oneOf(...signalSeverities);
const attention = oneOf(...signalAttention);

export function parseSignal(value: unknown): Signal {
  object(value, {
    version,
    signalId: boundedText(120),
    profileId: text,
    source,
    kind,
    severity,
    observedAt: timestamp,
    dedupeKey: boundedText(200),
    subject: boundedText(200),
    summary: boundedText(500),
    correlationId: nullableText,
    attention,
    evidence: { kind: oneOf('observed'), reference: boundedText(300) },
  });
  return value as Signal;
}

/**
 * The expected effect of one piece of work, the observed result, the verification state and its cost. `verified`
 * requires an observed evidence reference; the store never upgrades a result on its own.
 */
export const verificationStates = ['verified', 'not_verified', 'blocked', 'uncertain'] as const;
export type VerificationState = typeof verificationStates[number];
export type OutcomeInput = {
  version: 1;
  outcomeId: string;
  profileId: string;
  capability: string;
  expectation: string;
  result: string;
  verification: VerificationState;
  evidence: string;
  costUsd: number;
  latencyMs: number;
  modelCalls: number;
  taskId: string | null;
  signalId: string | null;
  observedAt: string;
};
export type Outcome = OutcomeInput & { sequence: number; recordedAt: string };

const capability = (value: unknown) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
const money = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const nullableId = (value: unknown) => value === null || boundedText(200)(value);

export function parseOutcomeInput(value: unknown): OutcomeInput {
  object(value, {
    version,
    outcomeId: boundedText(120),
    profileId: text,
    capability,
    expectation: boundedText(500),
    result: boundedText(1000),
    verification: oneOf(...verificationStates),
    evidence: boundedText(300),
    costUsd: money,
    latencyMs: count,
    modelCalls: count,
    taskId: nullableId,
    signalId: nullableId,
    observedAt: timestamp,
  });
  return value as OutcomeInput;
}
