import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { atomicWrite } from './store.ts';
import { record } from './cache.ts';
import { textContent } from './transcript.ts';

/** `paused`: interrupted by the user with nothing queued, alive and waiting for its next message. `interrupted` is a finished run cut off by Pi closing or a connected window ending. */
export const runStates = ['running', 'waiting', 'stopping', 'completed', 'failed', 'stopped', 'interrupted', 'paused'] as const;
export type RunState = typeof runStates[number];
export type FinishReason = 'complete' | 'disconnected' | 'owner-stopped' | 'failed';
export const WORKTREES_KEPT = 4;
export interface RunInfo {
  id: string; task: string; cwd: string; model: string; thinking: string;
  parentSession: string; sessionFile?: string; started: number; ended?: number;
  parentId?: string; depth: number;
  state: RunState; report?: string;
  connected?: boolean;
  /** A contract worker's kind and project (manager mode); absent for a plain subagent. */
  kind?: string; project?: string;
  /** A specialist patrol (see patrol.ts): a read-only worker whose report is recorded, not delivered, unless it fails. */
  patrol?: boolean;
  /** The other git checkouts of the project this run worked in (the worktree it made for its change), most recent first, at most `WORKTREES_KEPT`; its report and `crew accept` read the branch there, not in `cwd`. */
  worktrees?: string[];
  /** The other contract worker of an author-reviewer pair (set on both records) and the messages the pair has sent, both ways. */
  peer?: { id: string; sent: number };
  handoff?: { reason: FinishReason; text?: string; delivered?: boolean };
  /** Working when Pi closed or crashed: the next start resumes it (see `Children.resumeCutOff`). */
  cutOff?: boolean;
  /** Retargeted execution requires explicit continuation after a restart. */
  explicitRecovery?: boolean;
  /** Waiting for its model account's quota (state `interrupted`): resumed by itself at `until`. `queued`: it never started, so it starts fresh instead of resuming a conversation. */
  parked?: { until: number; reason: string; provider: string; attempts: number; queued?: boolean };
  /** Quota parks in a row since it last made progress; the run is reported as failed past `PARK_MAX`. */
  parks?: number;
  /** `from` is missing on runs saved before senders were recorded. */
  guidance: { text: string; date: number; state: 'queued' | 'delivered' | 'undelivered'; from?: 'user' | 'manager' }[];
  /** Set on rows projected from another runtime (currently pi-subagents); never persisted by RunHistory. */
  source?: 'pi-subagents';
  agent?: string;
  externalKind?: 'async' | 'foreground' | 'live-foreground';
  externalRunId?: string;
  /** The step of a multi-step run this row shows, counted by position like the runner counts them. */
  externalStepIndex?: number;
  /** The run directory of an async run, where its control inbox lives. */
  externalDir?: string;
  /** Foreground pi-subagents history has no start time; show a dash rather than a fabricated duration. */
  durationUnknown?: boolean;
}
const moves: Record<RunState, readonly RunState[]> = {
  running: ['waiting', 'paused', 'stopping', 'completed', 'failed', 'stopped', 'interrupted'],
  waiting: ['running', 'paused', 'stopping', 'completed', 'failed', 'stopped', 'interrupted'],
  paused: ['running', 'stopping', 'failed', 'stopped', 'interrupted'],
  stopping: ['stopped', 'failed', 'interrupted'],
  // A finished run only takes the outcome of a connected handoff.
  completed: ['interrupted'], failed: ['completed', 'interrupted'], stopped: ['completed', 'interrupted'], interrupted: ['completed', 'failed', 'stopped'],
};
/** Every run state change goes through here, so a late stop cannot rewrite a finished run. Returns whether the run is now in `to` (true for a repeat, so a second stop can still abort a child that ignored the first). */
export function transition(run: RunInfo, to: RunState) {
  if (run.state !== to && !moves[run.state].includes(to)) return false;
  run.state = to; return true;
}
const activeStates: readonly RunState[] = ['running', 'waiting', 'stopping', 'paused'];
export const isActiveRun = (run: RunInfo) => activeStates.includes(run.state);
/** Live and working: a paused run is neither running nor finished. */
export const isRunning = (run: RunInfo) => isActiveRun(run) && run.state !== 'paused';
/** A run that has ended: not live, not waiting for the user. */
export const isTerminalState = (state: RunState) => !activeStates.includes(state) && state !== 'paused';
function isRun(value: unknown): value is RunInfo {
  return record(value) && ['id', 'task', 'cwd', 'model', 'thinking', 'parentSession'].every(k => typeof value[k] === 'string')
    && typeof value.id === 'string' && /^[a-zA-Z0-9-]+$/.test(value.id)
    && runStates.includes(value.state as RunState) && typeof value.started === 'number' && Number.isFinite(value.started)
    && (value.ended === undefined || typeof value.ended === 'number')
    && (value.sessionFile === undefined || typeof value.sessionFile === 'string')
    && (value.report === undefined || typeof value.report === 'string')
    && (value.connected === undefined || typeof value.connected === 'boolean')
    && (value.cutOff === undefined || typeof value.cutOff === 'boolean')
    && (value.explicitRecovery === undefined || typeof value.explicitRecovery === 'boolean')
    && (value.worktrees === undefined || Array.isArray(value.worktrees) && value.worktrees.every(dir => typeof dir === 'string'))
    && (value.parks === undefined || typeof value.parks === 'number' && Number.isInteger(value.parks) && value.parks >= 0)
    && (value.parked === undefined || record(value.parked) && typeof value.parked.until === 'number' && Number.isFinite(value.parked.until) && typeof value.parked.reason === 'string'
      && typeof value.parked.provider === 'string' && typeof value.parked.attempts === 'number' && (value.parked.queued === undefined || typeof value.parked.queued === 'boolean'))
    && (value.peer === undefined || record(value.peer) && typeof value.peer.id === 'string' && typeof value.peer.sent === 'number' && Number.isInteger(value.peer.sent) && value.peer.sent >= 0)
    && (value.handoff === undefined || record(value.handoff) && ['complete', 'disconnected', 'owner-stopped', 'failed'].includes(String(value.handoff.reason))
      && (value.handoff.text === undefined || typeof value.handoff.text === 'string')
      && (value.handoff.delivered === undefined || typeof value.handoff.delivered === 'boolean'))
    && typeof value.depth === 'number' && Number.isInteger(value.depth) && value.depth >= 1
    && (value.parentId === undefined || typeof value.parentId === 'string')
    && Array.isArray(value.guidance) && value.guidance.every(g => record(g) && typeof g.text === 'string' && typeof g.date === 'number' && ['queued', 'delivered', 'undelivered'].includes(String(g.state)) && (g.from === undefined || g.from === 'user' || g.from === 'manager'));
}
export const CUT_OFF = 'Pi closed before this agent finished. Its partial transcript is retained.';
export function sessionMessages(file: string): AgentMessage[] {
  return SessionManager.open(file).getEntries().flatMap(e => e.type === 'message' ? [e.message] : []);
}

/** Metadata sits beside the SDK's canonical child transcripts, inside this profile. */
export class RunHistory {
  readonly records = new Map<string, RunInfo>();
  readonly warnings: string[] = [];
  private readonly directory: string;
  constructor(profileDirectory: string) {
    this.directory = join(profileDirectory, 'runs');
    const files = existsSync(this.directory) ? readdirSync(this.directory) : [];
    for (const file of files.filter(f => f.endsWith('.optchat.json'))) {
      try {
        const run: unknown = JSON.parse(readFileSync(join(this.directory, file), 'utf8'));
        if (record(run) && run.depth === undefined) run.depth = 1;
        if (!isRun(run) || file !== `${run.id}.optchat.json`) throw new Error('Invalid metadata');
        // Never follow a stored transcript pointer outside this profile's run directory.
        if (run.sessionFile) run.sessionFile = join(this.directory, basename(run.sessionFile));
        this.records.set(run.id, run);
        if (isActiveRun(run)) {
          if (run.connected) run.handoff ??= { reason: 'owner-stopped' };
          // Paused runs wait for the user and stopping ones were stopped on purpose: neither is picked up again by itself.
          else if ((run.state === 'running' || run.state === 'waiting') && !run.explicitRecovery) run.cutOff = true;
          if (run.explicitRecovery) delete run.cutOff;
          transition(run, 'interrupted'); run.ended = Date.now();
          run.report = run.explicitRecovery ? 'Retargeted worker interrupted at restart; inspect and continue explicitly.' : CUT_OFF;
          for (const g of run.guidance) if (g.state === 'queued') g.state = 'undelivered';
          this.save(run);
        } else if (run.explicitRecovery && run.parked && run.state === 'interrupted') {
          run.report = 'Retargeted worker parked at restart; inspect and continue explicitly. No automatic quota retry is armed.';
          this.save(run);
        }
      } catch { this.warnings.push(`Could not read run metadata: ${file}`); }
    }
    const known = new Set([...this.records.values()].map(r => r.sessionFile));
    // Make pre-inspector child sessions browsable without pretending to know their parent session.
    for (const file of files.filter(f => f.endsWith('.jsonl') && !known.has(join(this.directory, f)))) {
      try {
        const manager = SessionManager.open(join(this.directory, file));
        const messages = manager.getEntries().flatMap(e => e.type === 'message' ? [e.message] : []);
        const first = messages.find(m => m.role === 'user'), last = messages.findLast(m => m.role === 'assistant');
        const content = first?.role === 'user' ? textContent(first.content) : 'Historical child session';
        const task = content.includes('\n\nYour task:\n') ? content.split('\n\nYour task:\n').slice(1).join('\n\nYour task:\n') : content;
        const run: RunInfo = { id: manager.getSessionId(), task, cwd: manager.getCwd(), model: last?.role === 'assistant' ? last.model : 'unknown',
          thinking: 'unknown', parentSession: '', depth: 1, sessionFile: join(this.directory, file), started: first?.timestamp ?? 0,
          ended: last?.timestamp, state: last?.role === 'assistant' && last.stopReason === 'stop' ? 'completed' : 'interrupted', guidance: [] };
        this.records.set(run.id, run); this.save(run);
      } catch { this.warnings.push(`Could not read historical child: ${file}`); }
    }
  }
  matchesStored(run: RunInfo) {
    try { return readFileSync(join(this.directory, `${run.id}.optchat.json`), 'utf8') === JSON.stringify(run); } catch { return undefined; }
  }
  save(run: RunInfo) {
    if (run.source) throw new Error(`${run.id} belongs to ${run.source}, not this profile; OptChat never writes its metadata.`);
    atomicWrite(join(this.directory, `${run.id}.optchat.json`), JSON.stringify(run));
    this.records.set(run.id, run);
  }
  /** The transcript goes first: left behind, it would come back at the next start as a historical child. */
  remove(id: string) {
    if (this.records.get(id)?.source) throw new Error(`${id} belongs to another runtime and cannot be deleted here.`);
    const file = this.records.get(id)?.sessionFile;
    if (file) rmSync(file, { force: true });
    rmSync(join(this.directory, `${id}.optchat.json`), { force: true });
    this.records.delete(id);
  }
  descendants(id: string) {
    const result: RunInfo[] = [], visited = new Set([id]);
    const visit = (parent: string) => {
      for (const run of this.records.values()) {
        if (run.parentId !== parent || visited.has(run.id)) continue;
        visited.add(run.id); result.push(run); visit(run.id);
      }
    };
    visit(id);
    return result;
  }
  list() {
    return orderRuns(this.records.values());
  }
}

/**
 * The order the panel shows runs in: live first, newest first, and every parent
 * right before its children. The first record of an id wins, so a native run is
 * never replaced by a row projected from another runtime.
 */
export function orderRuns(records: Iterable<RunInfo>): RunInfo[] {
  const unique = new Map<string, RunInfo>();
  for (const run of records) if (!unique.has(run.id)) unique.set(run.id, run);
  const sorted = [...unique.values()].sort((a, b) => Number(isActiveRun(b)) - Number(isActiveRun(a)) || b.started - a.started || a.id.localeCompare(b.id));
  const descendants = new Map<string, RunInfo[]>();
  for (const run of sorted) if (run.parentId) {
    const siblings = descendants.get(run.parentId) ?? []; siblings.push(run); descendants.set(run.parentId, siblings);
  }
  const result: RunInfo[] = [], visited = new Set<string>();
  const visit = (run: RunInfo) => {
    if (visited.has(run.id)) return;
    visited.add(run.id); result.push(run);
    for (const child of descendants.get(run.id) ?? []) visit(child);
  };
  for (const run of sorted) if (!run.parentId || !unique.has(run.parentId)) visit(run);
  for (const run of sorted) visit(run); // Keep even malformed/orphaned old trees visible.
  return result;
}
