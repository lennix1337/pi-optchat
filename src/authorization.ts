import { createHash, randomBytes } from 'node:crypto';
import { isReadOnlyDiagnostic } from './operation-diagnostics.ts';

interface Invocation { session: string; cwd: string; tool: string; input: unknown }
interface Refusal { block: true; reason: string; token?: string }
interface Pending { session: string; fingerprint: string; expires: number; approved: boolean }
interface Options { now?: () => number; ttlMs?: number; maxPending?: number }

const reads = new Set(['read', 'zoom', 'date', 'grep', 'find', 'ls', 'search', 'project_evidence', 'get_goal', 'shell_status']);
const navigation = new Set(['map', 'task', 'search', 'symbol', 'callers', 'callees', 'impact', 'exemplar', 'edit_check', 'quality', 'test_gate']);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function jsonDescriptors(value: object) {
  if (Object.getOwnPropertySymbols(value).length) throw new Error('Symbol arguments cannot be approved');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Arguments must contain only enumerable JSON values');
  }
  return descriptors;
}

// Do not invoke toJSON/getters or silently collapse undefined, NaN, functions or cycles.
function jsonValue(value: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (depth > 20) throw new Error('Arguments exceed the approval depth limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error('Arguments must be finite JSON data');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Arguments must be plain JSON data');
  if (Array.isArray(value) && !Object.keys(value).every((key, index) => key === String(index))) throw new Error('Arguments must be dense JSON arrays');
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new Error('Arguments must be dense JSON arrays');
  seen.add(value);
  const descriptors = jsonDescriptors(value);
  const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null);
  for (const key of Object.keys(value).sort()) {
    (result as Record<string, unknown>)[key] = jsonValue(descriptors[key].value, seen, depth + 1);
  }
  seen.delete(value);
  return result;
}

function diagnostic({ tool, input }: Invocation) {
  if (reads.has(tool)) return true;
  if (tool === 'operation_state' || tool === 'operational_state') return record(input) && Object.keys(input).length === 0;
  if (isReadOnlyDiagnostic(tool, input)) return true;
  if (tool === 'project_checks') return record(input) && input.name === undefined && Object.keys(input).every(key => key === 'root' || key === 'fresh');
  return tool === 'ripwire' && record(input) && typeof input.action === 'string' && navigation.has(input.action);
}

const pushMain = /^git -C (\S+) push origin main$/;

/** Lowercase forward-slash absolute path without dot segments, or undefined. */
function pushRoot(path: string) {
  const root = path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  return /^[a-z]:(\/[a-z0-9_-][a-z0-9._-]*)+$/.test(root) && !root.split('/').some(part => part === '.' || part === '..') ? root : undefined;
}

/** Standing grant shape: exactly `git -C <listed root> push origin main`, optional numeric timeout, nothing else. */
function standingPushRoot({ tool, input }: Invocation) {
  if (tool !== 'bash' || !record(input) || typeof input.command !== 'string') return;
  if (!Object.keys(input).every(key => key === 'command' || (key === 'timeout' && typeof input.timeout === 'number'))) return;
  const match = pushMain.exec(input.command);
  return match ? pushRoot(match[1]) : undefined;
}

/** Operator-typed `approve-standing push-main <root>...`: 1–16 valid roots, else undefined. */
function standingRoots(text: string) {
  const match = /^approve-standing push-main((?: \S+)+)$/.exec(text);
  const roots = match?.[1].trim().split(' ').map(pushRoot) ?? [];
  return roots.length > 0 && roots.length <= 16 && roots.every(Boolean) ? roots as string[] : undefined;
}

/** One-shot tool approval, not a shell sandbox or an authorization inferred from conversation. */
export class EffectApprovals {
  private readonly pending = new Map<string, Pending>();
  private readonly standing = new Map<string, Set<string>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxPending: number;
  constructor({ now = Date.now, ttlMs = 5 * 60_000, maxPending = 32 }: Options = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 256) throw new Error('Invalid approval bounds');
    this.now = now; this.ttlMs = ttlMs; this.maxPending = maxPending;
  }
  /** Session lifecycle reset: one-shot approvals and standing grants end together. */
  clear() { for (const grants of [this.pending, this.standing]) grants.clear(); }
  private expire() {
    this.pending.forEach((entry, token) => { if (this.now() >= entry.expires) this.pending.delete(token); });
  }
  admit(call: Invocation): Refusal | undefined {
    this.expire();
    let serialized: string;
    try {
      serialized = JSON.stringify(jsonValue(call));
      if (serialized.length > 128 * 1024) throw new Error('Arguments exceed approval size limit');
    } catch {
      return { block: true, reason: 'Not executed: effect approval requires bounded, finite plain JSON arguments.' };
    }
    if (diagnostic(call)) return;
    const root = standingPushRoot(call);
    if (root && this.standing.get(call.session)?.has(root)) return;
    const fingerprint = createHash('sha256').update(serialized).digest('hex');
    for (const [token, entry] of this.pending) {
      if (entry.fingerprint !== fingerprint) continue;
      if (entry.approved) { this.pending.delete(token); return; }
      return this.refusal(call.tool, token);
    }
    if (this.pending.size >= this.maxPending) return { block: true, reason: 'Not executed: effect approval capacity reached. Wait for expiry or session reset; do not dispatch a substitute action.' };
    const token = randomBytes(12).toString('hex');
    this.pending.set(token, { session: call.session, fingerprint, expires: this.now() + this.ttlMs, approved: false });
    return this.refusal(call.tool, token);
  }
  private refusal(tool: string, token: string): Refusal {
    return { block: true, token, reason: `Not executed: ${tool} requires approval of this exact invocation. Inspect its arguments in the tool transcript. No nested calls, retries or changed arguments are authorized. To approve once, enter exactly:\napprove-effect ${token}` };
  }
  approve(session: string, source: string, text: string): 'approved' | 'standing' | 'invalid' | 'ignored' {
    if (source !== 'interactive') return 'ignored';
    if (text.trim().startsWith('approve-standing ')) {
      const roots = standingRoots(text.trim());
      if (!roots) return 'invalid';
      this.standing.set(session, new Set([...(this.standing.get(session) ?? []), ...roots]));
      return 'standing';
    }
    const match = /^approve-effect ([a-f0-9]{24})$/.exec(text.trim());
    if (!match) return 'ignored';
    this.expire();
    const entry = this.pending.get(match[1]);
    if (!entry || entry.session !== session || entry.approved) return 'invalid';
    entry.approved = true;
    return 'approved';
  }
}
