import { hash } from 'node:crypto';
import type { PendingApproval } from './authorization.ts';
import type { RunInfo } from './runs.ts';

export interface LocalInboxSources {
  profileId: string;
  sessionId: string;
  /** Already filtered by approvals.pendingFor(sessionId). */
  approvals: readonly Readonly<PendingApproval>[];
  operations: readonly { readonly id: string; readonly status: 'started' | 'response_recorded' | 'reconciled'; readonly error?: boolean; readonly evidence?: string }[];
  /** External runs must already be profile-scoped by the caller. */
  runs: readonly Readonly<RunInfo>[];
}
export type LocalInboxReference =
  | { type: 'approval'; tool: string; expires: number }
  | { type: 'operation'; id: string }
  | { type: 'agent'; id: string };
export interface LocalInboxRow {
  source: 'approval' | 'operation' | 'agent' | 'external-agent';
  id: string;
  status: string;
  verification: 'not_verified';
  reference: LocalInboxReference;
}
export interface LocalInboxPage { rows: LocalInboxRow[]; nextCursor: string | null }

const scopeKey = (profileId: string, sessionId: string) => hash('sha256', JSON.stringify([profileId, sessionId]));
const runStates = new Set(['running', 'waiting', 'stopping', 'completed', 'failed', 'stopped', 'interrupted', 'paused']);
const operationStates = new Set(['started', 'response_recorded', 'reconciled']);
const approvalTools = new Set(['bash', 'read', 'write', 'edit', 'grep', 'find', 'ls', 'spawn', 'tell']);
// JSON escaping preserves the exact ID while keeping terminal controls inert.
export const displayJson = (value: unknown) => JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** Pure metadata projection: approval tokens and source content never leave their owners. */
export function projectLocalInbox(sources: LocalInboxSources, cursor?: string, limit = 25): LocalInboxPage {
  if (!sources.profileId || !sources.sessionId) throw new TypeError('Local inbox requires profile and session');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid local inbox limit');
  const scope = scopeKey(sources.profileId, sources.sessionId);
  let after = '';
  if (cursor !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new TypeError('Invalid local inbox cursor');
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
    catch { throw new TypeError('Invalid local inbox cursor'); }
    if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== scope || typeof decoded[1] !== 'string' || !/^(approval|operation|agent|external-agent):[a-f0-9]{64}$/.test(decoded[1]) || Buffer.from(JSON.stringify(decoded)).toString('base64url') !== cursor) throw new TypeError('Invalid local inbox cursor');
    after = decoded[1];
  }
  const rows: LocalInboxRow[] = [];
  const add = (source: LocalInboxRow['source'], id: string, status: string, reference: LocalInboxReference) => {
    if (typeof id !== 'string' || !id || id.length > 1024) throw new TypeError('Invalid local inbox source ID');
    rows.push({ source, id: hash('sha256', id), status, verification: 'not_verified', reference });
  };
  for (const approval of sources.approvals) {
    if (!Number.isFinite(approval.expires)) throw new TypeError('Invalid approval expiry');
    add('approval', approval.token, 'pending', { type: 'approval', tool: approvalTools.has(approval.tool) ? approval.tool : 'other', expires: approval.expires });
  }
  for (const operation of sources.operations) {
    if (!operation.id.startsWith(`${sources.sessionId}:`)) continue;
    if (!operationStates.has(operation.status)) throw new TypeError('Invalid operation status');
    add('operation', operation.id, operation.status === 'response_recorded' && operation.error ? 'response_recorded_error' : operation.status, { type: 'operation', id: operation.id });
  }
  for (const run of sources.runs) {
    if (!run.source && run.parentSession !== sources.sessionId) continue;
    if (!runStates.has(run.state)) throw new TypeError('Invalid agent status');
    add(run.source ? 'external-agent' : 'agent', run.id, run.state, { type: 'agent', id: run.id });
  }
  const key = (row: LocalInboxRow) => `${row.source}:${row.id}`;
  rows.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  for (let i = 1; i < rows.length; i++) if (key(rows[i - 1]) === key(rows[i])) throw new TypeError('Duplicate local inbox source ID');
  const remaining = rows.filter(row => key(row) > after), page = remaining.slice(0, limit);
  return { rows: page, nextCursor: remaining.length > limit ? Buffer.from(JSON.stringify([scope, key(page[page.length - 1])])).toString('base64url') : null };
}

export function renderLocalInbox(page: LocalInboxPage): string {
  const lines = ['Local inbox · current-session approvals, operations and native agents; profile-scoped external agents · observed metadata, not verified'];
  if (!page.rows.length) lines.push('No local items in this page.');
  for (const row of page.rows) {
    const ref = row.reference;
    const detail = ref.type === 'approval' ? `pending approval widget/tool transcript · tool: ${ref.tool} · expires: ${ref.expires}`
      : ref.type === 'operation' ? `operation ID: ${displayJson(ref.id)} · operation_state {} lists pending operations only`
      : `agent ID: ${displayJson(ref.id)} · inspect: zoom ${displayJson({ agent: ref.id })} or select in /optchat agents`;
    lines.push(`${row.source}:${row.id} · ${row.status} · verification: ${row.verification} · ${detail}`);
  }
  if (page.nextCursor) lines.push(`Next cursor: ${page.nextCursor}`);
  return lines.join('\n');
}
