import { createHash, randomBytes } from 'node:crypto';
import { isReadOnlyDiagnostic } from './operation-diagnostics.ts';
import { externalEffectsOf, productionWriteHost, scriptCommands, runsDeploy, segments } from './effect-classifier.ts';
import { browserConsentEffect } from './external-effects.ts';

interface Invocation { session: string; cwd: string; tool: string; input: unknown }
interface Refusal { block: true; reason: string; token?: string }
interface Pending { session: string; fingerprint: string; expires: number; approved: boolean; tool: string; kind?: string; summary: string; created: number }
/** What the operator sees for a call waiting on approval. */
export interface PendingApproval { token: string; tool: string; kind?: string; summary: string; expires: number }
/** `all`: every non-diagnostic call needs approval. `risk`: only the high-impact classes below do. */
export type ApprovalMode = 'all' | 'risk';
/** How a call that waited for the operator stopped waiting. */
export type Settled = 'approved' | 'denied' | 'superseded' | 'expired';
interface Options { now?: () => number; ttlMs?: number; maxPending?: number; mode?: ApprovalMode; onSettled?: (token: string, outcome: Settled) => void }

const reads = new Set(['read', 'zoom', 'date', 'grep', 'find', 'ls', 'search', 'project_evidence', 'get_goal', 'shell_status', 'catchup_report']);
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

// Risk mode is a guardrail against accidental high-impact effects, not a shell sandbox:
// obfuscated commands (eval, variables, encoded scripts) pass it. `all` mode is the boundary.
const riskClasses: [string, RegExp][] = [
  // `git stash push` saves local changes; it is not a remote push.
  ['push', /\bgit\b(?:(?!\bstash\b)[^;&|\n])*\spush\b/],
  ['publish', /\b(?:npm|pnpm|yarn|cargo|vsce)\s+publish\b|\bgh\s+(?:release\s+create|pr\s+merge|repo\s+(?:create|delete))\b/],
  ['global install', /\b(?:npm|pnpm|yarn)\s+(?:i|install|add|link)\b[^;&|\n]*\s(?:-g|--global)\b|\b(?:cargo|winget|choco|scoop)\s+install\b/],
  ['discard', /\bgit\b[^;&|\n]*\s(?:reset\s+--hard|clean\s+-[a-zA-Z]*f[a-zA-Z]*|worktree\s+remove\b[^;&|\n]*--force|branch\s+-D|stash\s+(?:drop|clear))\b/],
  ['paid model call', /\bpi\b[^;&|\n]*\s(?:-p|--print)\b|\bbench\.mjs\s+run\b|\bmodels\.(?:classify|generateImages)\b|\btools\.(?:subagent|spawn|tell)\b/],
];
const paidTools = new Set(['subagent', 'spawn', 'tell']);
/** Risk class of a call that touches the operator's autonomy contract; only the operator may approve it. */
export const CONTRACT_CHANGE = 'autonomy contract change';
/** Whether a call's arguments name autonomy.json, the operator's contract file. */
const namesContract = (input: unknown) => JSON.stringify(input ?? null).toLowerCase().includes('autonomy.json');
/**
 * Tools whose arguments are prose: naming a file there cannot change it. A delegated agent's task text is prose too:
 * the child runs this same gate and can never approve its own contract change.
 */
const prose = new Set(['self_reload', 'operational_state', 'create_goal', 'contact_supervisor', 'subagent_supervisor', 'spawn', 'subagent', 'tell']);
const readOnlyCommand = /^(?:grep|rg|cat|head|tail|less|wc|ls|stat|file|diff|cmp|sha\d*sum|md5sum|jq|echo|printf|test|Get-Content|gc|Select-String|sls|Test-Path|Get-Item|Get-ChildItem|Get-FileHash|git\s+(?:grep|log|diff|show|status|blame|ls-files))\b/i;
/** Shell control words in front of a segment's command: `for f in a b` only lists words, `do`/`then` precede the real command. */
const controlPrefix = /^(?:(?:do|then|else|elif|if|while|until)\s+)+/;
const loopHeader = /^for\s+\w+\s+in\b/;
/** `node -e|-p` whose inline script uses no file-writing API only reads. */
const nodeInline = /^node\s+(?:-e|-p|--eval|--print)\s/;
const fsWrite = /\b(?:writeFile|appendFile|rename|copyFile|cp|rm|unlink|truncate|createWriteStream|open|symlink|link)(?:Sync)?\s*\(/;
/** Codemode tools that can write a file; a script without one only reads or reports. */
const codemodeWriter = /\btools\.(?:edit|write|bash|shell_start)\s*\(/;

/** Shell text without here-document bodies: a body is content for the file its command line names, like a write's content. */
const withoutHeredocBodies = (command: string) =>
  command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, match => match.slice(0, match.indexOf('\n')));
const redirect = /\d*>>?\s*("[^"]*"|'[^']*'|[^\s;&|]+)/g;
/** `for f in ... autonomy.json ...` makes `$f` name the contract: the loop body is read with the file name in its place. */
function loopVariablesResolved(text: string) {
  for (const [, name, words] of text.matchAll(/\bfor\s+(\w+)\s+in\s+([^;\n]*)/g)) {
    if (namesContract(words)) text = text.replace(new RegExp(`\\$\\{?${name}\\b\\}?`, 'g'), 'autonomy.json');
  }
  return text;
}
/** A copy writes only its last argument; its sources are read. */
const copyCommand = /^(?:cp|Copy-Item|cpi)\s/i;

/**
 * Whether shell text can write the contract file: a redirect into it, a copy onto it, or any other segment that names it
 * and is not a read-only command. Command substitution naming it counts, since its segments cannot be told apart.
 */
function shellWritesContract(command: string) {
  const text = loopVariablesResolved(withoutHeredocBodies(command).replace(/\d*>&\d/g, ''));
  if (!namesContract(text)) return false;
  if (/`|\$\(/.test(text)) return true;
  return segments(text, '.').some(({ command: segment }) => {
    if ([...segment.matchAll(redirect)].some(match => namesContract(match[1]))) return true;
    const rest = segment.replace(redirect, '').replace(/^(?:\w+=\S*\s+)*/, '').trim().replace(controlPrefix, '');
    if (copyCommand.test(rest)) return namesContract(rest.split(/\s+/).filter(arg => !arg.startsWith('-')).at(-1));
    if (loopHeader.test(rest) || (nodeInline.test(rest) && !fsWrite.test(rest))) return false;
    return namesContract(rest) && !readOnlyCommand.test(rest);
  });
}

/**
 * A call that can change the contract: an edit or write of the file, a shell command naming it that is not read-only,
 * or any other tool (codemode, subagents) naming it. Searches, reads and prose such as a reload checkpoint never are.
 */
export function touchesContract({ tool, input }: { tool: string; input: unknown }) {
  if (reads.has(tool) || prose.has(tool) || diagnostic({ session: '', cwd: '', tool, input })) return false;
  if (tool === 'edit' || tool === 'write') return record(input) && typeof input.path === 'string' && namesContract(input.path);
  if ((tool === 'bash' || tool === 'shell_start') && record(input) && typeof input.command === 'string') return shellWritesContract(input.command);
  if (tool === 'codemode' && record(input) && typeof input.code === 'string') return namesContract(input.code) && codemodeWriter.test(input.code);
  return namesContract(input);
}
const subagentInspection = new Set(['list', 'models', 'guide', 'status', 'validate']);
const tempPath = /^(?:[a-zA-Z]:[\\/](?:tmp|temp)[\\/]|\/tmp\/|\/c\/tmp\/|\$\{?(?:TMP|TEMP|TMPDIR)\b|%TEMP%)/i;

/** A recursive delete (rm -r, Remove-Item -Recurse, rd /s) whose targets are not all inside a temp folder. */
function recursiveDelete(command: string) {
  for (const segment of command.split(/[;&|\n]+/)) {
    const words = segment.trim().split(/\s+/).map(word => word.replace(/^['"]|['"]$/g, ''));
    const at = words.findIndex(word => /^(?:rm|Remove-Item|ri|rmdir|rd)$/i.test(word));
    if (at < 0) continue;
    const args = words.slice(at + 1);
    const flags = args.filter(arg => /^[-/]/.test(arg) && !tempPath.test(arg));
    if (!flags.some(flag => /^-[a-zA-Z]*[rR]|^--recursive$|^-Recurse$|^\/s$/i.test(flag))) continue;
    const targets = args.filter(arg => !flags.includes(arg));
    if (!targets.length || !targets.every(target => tempPath.test(target))) return true;
  }
  return false;
}

/** The high-impact class a call belongs to in risk mode, or undefined for ordinary work. */
function riskClass({ tool, input }: Invocation) {
  // The agent never widens its own contract: any call that can write autonomy.json waits for the operator.
  if (touchesContract({ tool, input })) return CONTRACT_CHANGE;
  if (paidTools.has(tool)) return record(input) && typeof input.action === 'string' && subagentInspection.has(input.action) ? undefined : 'paid model call';
  if (tool === 'browser_harness') return browserConsentEffect(input) ? 'consent click' : undefined;
  const text = record(input) && typeof input.command === 'string' && (tool === 'bash' || tool === 'shell_start') ? input.command
    : record(input) && typeof input.code === 'string' && tool === 'codemode' ? input.code : undefined;
  return text === undefined ? undefined : shellRisk(text, tool === 'codemode');
}

/** The high-impact class of shell text (a codemode script is judged by the commands it hands to shell tools). */
function shellRisk(text: string, script: boolean) {
  if (recursiveDelete(text)) return 'recursive delete';
  if (productionWriteHost(text)) return 'production write';
  const external = (script ? scriptCommands(text) : [text]).flatMap(externalEffectsOf);
  if (external.some(e => e.action === 'message')) return 'third-party message';
  if (external.length) return 'production write';
  if (/\bgh\s+pr\s+merge\b[^;&|\n]*\s--admin\b/.test(text)) return 'merge bypassing CI';
  if (runsDeploy(text)) return 'deploy';
  return riskClasses.find(([, pattern]) => pattern.test(text))?.[0];
}

/** One line the operator can recognise: the command for shell tools, otherwise the tool and its action. */
function summarize({ tool, input, cwd }: Invocation) {
  const where = cwd ? ` (in ${cwd.replaceAll('\\', '/').split('/').filter(Boolean).at(-1)})` : '';
  const text = record(input) && typeof input.command === 'string' ? input.command
    : record(input) && typeof input.code === 'string' ? `${tool} script`
      : record(input) ? [tool, input.action, input.agent, input.name].filter(part => typeof part === 'string').join(' ') : tool;
  const line = text.replace(/\s+/g, ' ').trim();
  return (line.length > 120 ? `${line.slice(0, 119)}…` : line) + where;
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

/** Standing key a call needs: `push:<root>` for the exact push shape, `paid-subagents` for direct subagent launches. */
function standingKey(call: Invocation) {
  if (call.tool === 'subagent') return 'paid-subagents';
  const root = standingPushRoot(call);
  return root && `push:${root}`;
}

/** Operator-typed `approve-standing push-main <root>...` (1–16 valid roots) or `approve-standing paid-subagents`, else undefined. */
function standingKeys(text: string) {
  if (text === 'approve-standing paid-subagents') return ['paid-subagents'];
  const match = /^approve-standing push-main((?: \S+)+)$/.exec(text);
  const roots = match?.[1].trim().split(' ').map(pushRoot) ?? [];
  return roots.length > 0 && roots.length <= 16 && roots.every(Boolean) ? roots.map(root => `push:${root}`) : undefined;
}

/** One-shot tool approval, not a shell sandbox or an authorization inferred from conversation. */
export class EffectApprovals {
  private readonly pending = new Map<string, Pending>();
  private readonly standing = new Map<string, Set<string>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxPending: number;
  private readonly mode: ApprovalMode;
  private readonly onSettled: (token: string, outcome: Settled) => void;
  // Long enough for an operator who stepped away; the call stays visible on screen meanwhile.
  constructor({ now = Date.now, ttlMs = 30 * 60_000, maxPending = 32, mode = 'all', onSettled = () => {} }: Options = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 256) throw new Error('Invalid approval bounds');
    this.now = now; this.ttlMs = ttlMs; this.maxPending = maxPending; this.mode = mode; this.onSettled = onSettled;
  }
  /** Drops a call; one still waiting for the operator reports how it stopped waiting. */
  private drop(token: string, outcome: Exclude<Settled, 'approved'>) {
    const entry = this.pending.get(token);
    this.pending.delete(token);
    if (entry && !entry.approved) this.onSettled(token, outcome);
  }
  /** Session lifecycle reset: one-shot approvals and standing grants end together. */
  clear() { [...this.pending.keys()].forEach(token => this.drop(token, 'expired')); this.standing.clear(); }
  private expire() {
    [...this.pending].forEach(([token, entry]) => { if (this.now() >= entry.expires) this.drop(token, 'expired'); });
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
    const kind = this.mode === 'risk' ? riskClass(call) : undefined;
    if (this.mode === 'risk' && !kind) return;
    const key = standingKey(call);
    if (key && this.standing.get(call.session)?.has(key)) return;
    const fingerprint = createHash('sha256').update(serialized).digest('hex');
    for (const [token, entry] of this.pending) {
      if (entry.fingerprint !== fingerprint) continue;
      if (entry.approved) { this.pending.delete(token); return; }
      return this.refusal(call.tool, token, kind);
    }
    if (this.pending.size >= this.maxPending) return { block: true, reason: 'Not executed: effect approval capacity reached. Wait for expiry or session reset; do not dispatch a substitute action.' };
    const token = randomBytes(12).toString('hex');
    const now = this.now();
    this.pending.set(token, { session: call.session, fingerprint, expires: now + this.ttlMs, approved: false, tool: call.tool, kind, summary: summarize(call), created: now });
    return this.refusal(call.tool, token, kind);
  }
  private refusal(tool: string, token: string, kind?: string): Refusal {
    return { block: true, token, reason: `Not executed: ${tool}${kind ? ` is a ${kind} effect and` : ''} requires approval of this exact invocation. Inspect its arguments in the tool transcript. No nested calls, retries or changed arguments are authorized. The operator approves it once by typing /approve (or exactly: approve-effect ${token}), or drops it with /deny. Tell them in one line what this call does and wait.` };
  }
  /** Calls of this session still waiting on the operator, newest first. */
  pendingFor(session: string): PendingApproval[] {
    this.expire();
    return [...this.pending].filter(([, entry]) => entry.session === session && !entry.approved)
      .sort(([, a], [, b]) => b.created - a.created)
      .map(([token, { tool, kind, summary, expires }]) => ({ token, tool, kind, summary, expires }));
  }
  /** Approves one call and drops the older calls it superseded: the model was told to wait, so they were abandoned. */
  private grant(token: string) {
    const entry = this.pending.get(token)!;
    entry.approved = true;
    this.onSettled(token, 'approved');
    [...this.pending].forEach(([key, other]) => { if (other.session === entry.session && !other.approved && other.created <= entry.created && key !== token) this.drop(key, 'superseded'); });
  }
  /** The advisor's approval of one pending call; unlike the operator's, it leaves the other pending calls waiting. */
  approveByAdvisor(session: string, token: string) {
    const entry = this.pending.get(token);
    if (!entry || entry.session !== session || entry.approved) return false;
    entry.approved = true;
    this.onSettled(token, 'approved');
    return true;
  }
  /** Operator `/approve`: approves the newest pending call of this session once. */
  approveLatest(session: string, source: string): PendingApproval | undefined {
    if (source !== 'interactive') return;
    const latest = this.pendingFor(session)[0];
    if (latest) this.grant(latest.token);
    return latest;
  }
  /**
   * The operator's Slack reply to one approval post: approves (like `/approve`) or drops that exact pending call.
   * Only the Slack bridge calls it, for a human reply from the configured operator in that post's DM thread.
   */
  decideFromPhone(session: string, token: string, approve: boolean): boolean {
    this.expire();
    const entry = this.pending.get(token);
    if (!entry || entry.session !== session || entry.approved) return false;
    if (approve) this.grant(token); else this.drop(token, 'denied');
    return true;
  }
  /** Operator `/deny`: drops every pending call of this session. */
  deny(session: string, source: string): PendingApproval[] {
    if (source !== 'interactive') return [];
    const dropped = this.pendingFor(session);
    for (const { token } of dropped) this.drop(token, 'denied');
    return dropped;
  }
  /** `embedded`: a token inside other text, never an approval (it may be pasted transcript). */
  approve(session: string, source: string, text: string): 'approved' | 'standing' | 'invalid' | 'ignored' | 'embedded' {
    if (source !== 'interactive') return 'ignored';
    if (text.trim().startsWith('approve-standing ')) {
      const keys = standingKeys(text.trim());
      if (!keys) return 'invalid';
      this.standing.set(session, new Set([...(this.standing.get(session) ?? []), ...keys]));
      return 'standing';
    }
    const match = /^approve-effect ([a-f0-9]{24})$/.exec(text.trim());
    if (!match) return /\bapprove-effect [a-f0-9]{24}\b/.test(text) ? 'embedded' : 'ignored';
    this.expire();
    const entry = this.pending.get(match[1]);
    if (!entry || entry.session !== session || entry.approved) return 'invalid';
    this.grant(match[1]);
    return 'approved';
  }
}
