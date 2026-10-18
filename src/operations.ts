import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './store.ts';
import { isReadOnlyDiagnostic } from './operation-diagnostics.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

interface Operation {
  id: string;
  tool: string;
  fingerprint: string;
  status: 'started' | 'response_recorded' | 'reconciled';
  outcome: 'not_verified';
  error?: boolean;
  evidence?: string;
  recoveryIncidentId?: string;
  startedAt?: number;
  responseAt?: number;
  /** Pi dispatch event precedes validation/tool_call; it does not prove the tool body ran. */
  dispatchObserved?: boolean;
}
const READ_ONLY = new Set(['read', 'grep', 'find', 'ls', 'zoom', 'date', 'search', 'operation_state', 'operational_state']);
const LIMIT = 1000;
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
function valid(value: unknown): value is Operation {
  if (!value || typeof value !== 'object') return false;
  const o = value as Record<string, unknown>;
  return Object.keys(o).every(k => ['id', 'tool', 'fingerprint', 'status', 'outcome', 'error', 'evidence', 'recoveryIncidentId', 'startedAt', 'responseAt', 'dispatchObserved'].includes(k))
    && bounded(o.id, 1024) && bounded(o.tool, 256) && typeof o.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(o.fingerprint)
    && ['started', 'response_recorded', 'reconciled'].includes(String(o.status)) && o.outcome === 'not_verified'
    && (o.recoveryIncidentId === undefined || typeof o.recoveryIncidentId === 'string' && /^[a-f0-9-]{36}$/i.test(o.recoveryIncidentId))
    && (o.startedAt === undefined || typeof o.startedAt === 'number' && Number.isFinite(o.startedAt) && o.startedAt >= 0)
    && (o.responseAt === undefined || typeof o.responseAt === 'number' && Number.isFinite(o.responseAt) && o.responseAt >= 0)
    && (o.dispatchObserved === undefined || typeof o.dispatchObserved === 'boolean')
    && (o.error === undefined || typeof o.error === 'boolean')
    && (o.evidence === undefined || bounded(o.evidence, 1000)) && (o.status !== 'reconciled' || bounded(o.evidence, 1000));
}
/** Durable intent is not proof of execution. A missing response requires independent reconciliation, never blind replay.
 * Arguments/results are deliberately not persisted here; original transcripts remain their source of truth. */
export class OperationJournal {
  private readonly file: string;
  private operations: Operation[];
  private readonly inFlight = new Set<string>();
  constructor(directory: string) {
    this.file = join(directory, 'operations.json');
    if (existsSync(this.file) && statSync(this.file).size > 4 * 1024 * 1024) throw new Error('Invalid operation journal; file exceeds safety limit');
    let saved: unknown = { version: 1, operations: [] };
    try { if (existsSync(this.file)) saved = JSON.parse(readFileSync(this.file, 'utf8')); }
    catch { throw new Error('Invalid operation journal; unreadable JSON requires inspection before recovery'); }
    const s = saved as { version?: unknown; operations?: unknown } | null;
    if (!s || Object.keys(s).some(k => k !== 'version' && k !== 'operations') || s.version !== 1 || !Array.isArray(s.operations) || s.operations.length > LIMIT || !s.operations.every(valid)
      || new Set(s.operations.map(o => o.id)).size !== s.operations.length) throw new Error('Invalid operation journal; refusing unsafe recovery');
    this.operations = s.operations;
  }
  snapshot(): readonly Readonly<Operation>[] { return this.operations.map(o => ({ ...o })); }
  pending() { return this.snapshot().filter(o => o.status === 'started' || o.status === 'response_recorded' && o.error); }
  private save(next: Operation[]) {
    atomicWrite(this.file, JSON.stringify({ version: 1, operations: next }));
    this.operations = next;
  }
  blockReason(tool: string, trustedReadOnly = false) {
    if (trustedReadOnly || READ_ONLY.has(tool)) return;
    const uncertain = this.pending().filter(o => !this.inFlight.has(o.id));
    if (uncertain.length) return `Not executed: external outcome uncertain for ${uncertain.map(o => o.id).join(', ')} (an earlier call was interrupted or timed out). Do not repeat effects. Use read-only observation, then operation_state with an evidence reference to reconcile.`;
  }
  start(session: string, call: string, tool: string, args: unknown, trustedReadOnly = false, recoveryIncidentId?: string, dispatchObserved = false) {
    if (trustedReadOnly || READ_ONLY.has(tool) || isReadOnlyDiagnostic(tool, args)) return;
    const blocked = this.blockReason(tool);
    if (blocked) throw new Error(blocked);
    const id = `${session}:${call}`;
    if (!bounded(id, 1024) || !bounded(tool, 256)) throw new Error('Invalid operation identity');
    if (this.operations.some(o => o.id === id)) throw new Error('Duplicate operation intent; refusing replay');
    // Keep unresolved intents; compact only records whose response or reconciliation is durable.
    const next = this.operations.length < LIMIT ? [...this.operations] : this.operations.filter(o => o.status === 'started' || o.status === 'response_recorded' && o.error);
    if (next.length >= LIMIT) throw new Error('Operation journal full of uncertain outcomes; reconcile before continuing');
    const fingerprint = createHash('sha256').update(JSON.stringify(args) ?? 'null').digest('hex');
    if (recoveryIncidentId !== undefined && !/^[a-f0-9-]{36}$/i.test(recoveryIncidentId)) throw new Error('Invalid recovery incident ID');
    next.push({ id, tool, fingerprint, status: 'started', outcome: 'not_verified', startedAt: Date.now(), dispatchObserved, ...(recoveryIncidentId ? { recoveryIncidentId } : {}) });
    this.save(next);
    this.inFlight.add(id);
  }
  /** `error` marks a response that did not establish the outcome; such operations stay pending. */
  finish(session: string, call: string, error: boolean, dispatchObserved = false) {
    const id = `${session}:${call}`;
    if (!this.operations.some(o => o.id === id && o.status === 'started')) return;
    try { this.save(this.operations.map(o => o.id === id ? { ...o, status: 'response_recorded', error, responseAt: Date.now(), dispatchObserved: o.dispatchObserved || dispatchObserved } : o)); }
    finally { this.inFlight.delete(id); }
  }
  resolve(id: string, evidence: string) {
    if (this.inFlight.has(id)) throw new Error('Operation is still executing; wait for its response before reconciliation');
    if (!bounded(evidence.trim(), 1000)) throw new Error('Independent observation evidence reference is required');
    if (!this.pending().some(o => o.id === id)) throw new Error('Unknown uncertain operation');
    this.save(this.operations.map(o => o.id === id ? { ...o, status: 'reconciled', evidence: evidence.trim() } : o));
  }
  settled(session: string) {
    for (const id of this.inFlight) if (id.startsWith(`${session}:`)) this.inFlight.delete(id);
  }
  context() {
    const pending = this.pending().filter(o => !this.inFlight.has(o.id));
    return pending.length ? `\nOperational recovery (not an authorization): ${pending.length} tool outcomes uncertain. Do not repeat effects. Inspect operation_state; verify actual external state using read-only observations and record evidence before proceeding.\n` : '';
  }
}

const INTERRUPTED = /timed? ?out|timeout|abort|interrupt|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|connection (?:reset|closed)|\b50[234]\b|SIG(?:KILL|TERM|INT|HUP)|terminated|outcome uncertain/i;

/** An ordinary failure (non-zero exit, validation error, HTTP 4xx) is an observed outcome the model can read.
 * Only an empty, interrupted, timed-out or gateway-failed response leaves external state unknown. */
export function outcomeUnknown(content: readonly unknown[] | undefined): boolean {
  const text = (content ?? []).map(part => (part as { type?: string; text?: string }).type === 'text' ? (part as { text: string }).text : '').join('\n');
  // Pi's bash tool ends a completed command with its exit code: the process ran to the end, so a word
  // like "timeout" in its output (a grep hit, a config key) says nothing about this call. Codes 124,
  // 137 and 143 are `timeout`/SIGKILL/SIGTERM inside the command, which can still cut an effect short.
  const exit = /Command exited with code (\d+)\s*$/.exec(text);
  if (exit) return ['124', '137', '143'].includes(exit[1]);
  // Shells append their timeout/abort status last; scanning only the tail keeps test names like
  // "handles timeout" inside an ordinary failing log from reopening the barrier.
  return !text.trim() || INTERRUPTED.test(text.slice(-400));
}
const failedUnobserved = (event: { isError: boolean; content?: readonly unknown[] }) => event.isError && outcomeUnknown(event.content);

/** Installed on each session, including child sessions; intent persistence failure blocks execution. */
export function registerOperationSafety(pi: ExtensionAPI, journal: () => OperationJournal | undefined, incident: (sessionId: string) => string | undefined = () => undefined) {
  // Providers may reuse call IDs in later turns. Session entry IDs distinguish fresh calls; the map survives intervening tool-result entries.
  const executions = new Map<string, string>();
  const observed = new Set<string>();
  pi.on('tool_call', (event, ctx) => {
    const current = journal();
    if (!current) return;
    try {
      // Trust installed read-only metadata or a fully recognized diagnostic command,
      // never a model-supplied flag claiming that an arbitrary command is safe.
      const readOnly = pi.getAllTools().find(tool => tool.name === event.toolName)?.annotations?.readOnlyHint === true
        || isReadOnlyDiagnostic(event.toolName, event.input);
      const reason = current.blockReason(event.toolName, readOnly);
      if (reason) return { block: true, reason };
      const session = ctx.sessionManager.getSessionId();
      const call = `${ctx.sessionManager.getLeafId() ?? 'unbound'}:${event.toolCallId}`;
      current.start(session, call, event.toolName, event.input, readOnly, incident(session), observed.has(`${session}:${event.toolCallId}`));
      executions.set(`${session}:${event.toolCallId}`, call);
    } catch {
      // A rejected duplicate ID must not let its synthetic error result acknowledge an earlier running call.
      executions.delete(`${ctx.sessionManager.getSessionId()}:${event.toolCallId}`);
      return { block: true, reason: 'Could not persist tool intent. Execution blocked; inspect the operation journal before retrying.' };
    }
  });
  pi.on('tool_execution_start', (event, ctx) => {
    const key = `${ctx.sessionManager.getSessionId()}:${event.toolCallId}`;
    observed.add(key);
  });
  pi.on('tool_result', (event, ctx) => {
    const session = ctx.sessionManager.getSessionId(), key = `${session}:${event.toolCallId}`, call = executions.get(key);
    if (!call) { observed.delete(key); return; }
    try { journal()?.finish(session, call, failedUnobserved(event), observed.has(key)); executions.delete(key); observed.delete(key); }
    catch { ctx.abort(); ctx.ui.notify('Could not persist tool response. Outcome remains uncertain; reconcile before repeating effects.', 'error'); }
  });
  pi.on('agent_settled', (_event, ctx) => {
    const session = ctx.sessionManager.getSessionId();
    journal()?.settled(session);
    for (const key of executions.keys()) if (key.startsWith(`${session}:`)) executions.delete(key);
    for (const key of observed) if (key.startsWith(`${session}:`)) observed.delete(key);
  });
  pi.registerTool({ name: 'operation_state', label: 'Operation recovery',
    description: 'Inspect uncertain tool outcomes after interruption. Resolve only after independent read-only observation; supply an evidence reference, never assume success or repeat the operation to check. This records an observation, not authorization or verified success.',
    parameters: Type.Object({ id: Type.Optional(Type.String()), evidence: Type.Optional(Type.String({ maxLength: 1000 })) }),
    async execute(_id, args) {
      const current = journal();
      if (!current) throw new Error('No active operation journal');
      if (args.id !== undefined) current.resolve(args.id, args.evidence ?? '');
      else if (args.evidence !== undefined) throw new Error('Evidence requires an operation ID');
      return { content: [{ type: 'text', text: JSON.stringify({ uncertain: current.pending(), guidance: 'Response recorded does not mean external outcome verified. Resolve only with independent observation evidence.' }) }], details: {} };
    },
  });
}
