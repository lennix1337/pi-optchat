import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import {
  parseOutcomeInput, parseSignal, type SignalAttention, type SignalKind, type SignalSeverity, type SignalSource,
  type VerificationState,
} from '../assistant/src/contracts/signals.ts';

/**
 * Pi-side producers append to the profile's spool; the always-on assistant service drains it with fixed rules and no
 * model. A producer must never break the agent, so every failure (missing directory, full spool, invalid field) only
 * means the observation was not recorded. The spool is bounded: past `MAX_SPOOL_BYTES` new lines are dropped until the
 * service drains it, instead of growing without limit while the service is off.
 */
export const MAX_SPOOL_BYTES = 1024 * 1024;

export type SignalPublish = {
  source: SignalSource; kind: SignalKind; subject: string; summary: string; dedupeKey: string;
  severity?: SignalSeverity; attention?: SignalAttention; correlationId?: string | null;
  evidence?: string; observedAt?: number;
};
export type OutcomePublish = {
  outcomeId: string; capability: string; expectation: string; result: string; verification: VerificationState;
  evidence: string; costUsd?: number; latencyMs?: number; modelCalls?: number;
  taskId?: string | null; signalId?: string | null; observedAt?: number;
};

const clip = (value: unknown, max: number) => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ').trim().slice(0, max);
const profileId = (directory: string) => {
  const id = basename(resolve(directory));
  if (!id || id === '.' || id === '..') throw new TypeError('Invalid profile directory');
  return id;
};
const iso = (value: number | undefined) => new Date(value ?? Date.now()).toISOString();
const count = (value: number | undefined, max = Number.MAX_SAFE_INTEGER) =>
  Math.max(0, Math.min(max, Math.round(Number.isFinite(value) ? value as number : 0)));
const money = (value: number | undefined) =>
  Math.round(Math.max(0, Math.min(1_000_000, Number.isFinite(value) ? value as number : 0)) * 1e6) / 1e6;

/** Appends one validated line; false means it was not recorded, never that the caller should retry differently. */
function append(directory: string, file: 'inbox.jsonl' | 'outcomes.jsonl', value: unknown): boolean {
  try {
    const path = join(resolve(directory), 'signals', file);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > MAX_SPOOL_BYTES) return false;
    appendFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return true;
  } catch { return false; }
}

export function appendSignal(directory: string, input: SignalPublish): boolean {
  try {
    const signalId = randomUUID();
    const signal = {
      version: 1, signalId, profileId: profileId(directory), source: input.source, kind: input.kind,
      severity: input.severity ?? 'warning', observedAt: iso(input.observedAt), dedupeKey: clip(input.dedupeKey, 200),
      subject: clip(input.subject, 200), summary: clip(input.summary, 500),
      correlationId: input.correlationId === undefined || input.correlationId === null ? null : clip(input.correlationId, 200),
      attention: input.attention ?? 'notify',
      evidence: { kind: 'observed', reference: clip(input.evidence ?? `signal:${signalId}`, 300) },
    };
    parseSignal(signal);
    return append(directory, 'inbox.jsonl', signal);
  } catch { return false; }
}
export function appendSignals(directory: string, inputs: readonly SignalPublish[]): number {
  return inputs.reduce((written, input) => written + (appendSignal(directory, input) ? 1 : 0), 0);
}

export function appendOutcome(directory: string, input: OutcomePublish): boolean {
  try {
    const outcome = {
      version: 1, outcomeId: clip(input.outcomeId, 120), profileId: profileId(directory), capability: input.capability,
      expectation: clip(input.expectation, 500), result: clip(input.result, 1000), verification: input.verification,
      evidence: clip(input.evidence, 300), costUsd: money(input.costUsd), latencyMs: count(input.latencyMs),
      modelCalls: count(input.modelCalls), taskId: input.taskId ?? null, signalId: input.signalId ?? null,
      observedAt: iso(input.observedAt),
    };
    parseOutcomeInput(outcome);
    return append(directory, 'outcomes.jsonl', outcome);
  } catch { return false; }
}

/** A background shell's observed end: cost and model calls are zero, and the exit code is the whole expectation. */
export type ShellResult = {
  id: string; command: string; state: string; started: number; ended?: number; exitCode?: number; log?: string;
};
export function recordShellOutcome(directory: string, sessionId: string, job: ShellResult): boolean {
  const verified = job.state === 'completed' && job.exitCode === 0;
  return appendOutcome(directory, {
    outcomeId: `shell:${sessionId}:${job.id}`,
    capability: 'shell',
    expectation: `O comando em segundo plano termina com sucesso: ${clip(job.command, 160)}`,
    result: `${job.state}${job.exitCode === undefined ? '' : ` (exit ${job.exitCode})`}`,
    verification: verified ? 'verified' : 'not_verified',
    evidence: job.log ? clip(`log:${job.log}`, 300) : `shell:${job.id}:${job.state}`,
    latencyMs: Math.max(0, (job.ended ?? Date.now()) - job.started),
    modelCalls: 0,
    observedAt: job.ended,
  });
}

/**
 * A top-level subagent's end, as data for the journal. It is recorded, not notified: the main agent already receives
 * the report, so the deterministic path has nothing to substitute here. Cost stays out until the usage ledger exposes it.
 */
export type SubagentResult = { id: string; task: string; state: string; started: number; ended?: number };
export function recordSubagentSignal(directory: string, run: SubagentResult): boolean {
  if (run.state !== 'completed' && run.state !== 'failed') return false;
  const seconds = Math.max(0, Math.round(((run.ended ?? Date.now()) - run.started) / 100) / 10);
  return appendSignal(directory, {
    source: 'subagent', kind: run.state === 'completed' ? 'subagent.completed' : 'subagent.failed',
    severity: run.state === 'completed' ? 'info' : 'warning',
    subject: `subagent:${run.id}`, summary: `${run.state} em ${seconds}s: ${clip(run.task, 160)}`,
    dedupeKey: `subagent:${run.id}`, evidence: `run:${run.id}`, observedAt: run.ended,
  });
}
