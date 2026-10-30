import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { Type } from 'typebox';
import { record as isRecord } from './cache.ts';
import { checkoutSlug, type FolderSlug } from './checkout-slug.ts';
import { normalPath, segments } from './effect-classifier.ts';
import { atomicWrite } from './store.ts';
import { stringEnum } from './string-enum.ts';

/** Structured operational facts are bounded, append-only records; they never grant authorization. */
export const OPERATIONAL_STATE_VERSION = 1 as const;
export const MAX_OPERATIONAL_ENTRIES = 256;
export const MAX_OPERATIONAL_STATE_BYTES = 256 * 1024;
export const MAX_OPERATIONAL_CONTEXT_CHARS = 8_000;
const MAX_TEXT_CHARS = 2_000;
const MAX_SOURCE_ID_CHARS = 128;
const MAX_EVIDENCE_REFS = 4;
const MAX_EVIDENCE_REF_CHARS = 256;
const ID_PATTERN = /^op_[a-f0-9]{24}$/;

export type OperationalKind = 'objective' | 'decision' | 'constraint' | 'authorization' | 'change' | 'check';
export type EvidenceKind = 'self-reported' | 'test' | 'log' | 'tool-result' | 'external';
export type CheckStatus = 'verified' | 'not_verified' | 'blocked';

export const GRANT_ACTIONS = ['push', 'merge', 'commit', 'paid', 'delete', 'publish', 'deploy'] as const;
export type GrantAction = typeof GRANT_ACTIONS[number];
const MAX_SCOPE_CHARS = 256;

/**
 * Structured scope of an authorization record (optional: free-text records stay valid).
 * `scope` is a repo root or path glob (`*` within a segment, `**` across segments); it covers its own path and everything under it.
 * `until` is an ISO expiry or `done` (active until superseded). `allow: false` records a prohibition.
 */
export interface Grant {
  action: GrantAction;
  scope: string;
  allow: boolean;
  until: string;
}

export interface EvidenceRef {
  kind: EvidenceKind;
  ref: string;
}

interface EntryBase {
  id: string;
  kind: OperationalKind;
  text: string;
  sourceMessageId: string;
  createdAt: string;
  supersedes?: string;
  evidence?: EvidenceRef[];
  grant?: Grant;
}

export type OperationalEntry = EntryBase & (
  | { kind: 'check'; status: CheckStatus; evidence: EvidenceRef[] }
  | { kind: Exclude<OperationalKind, 'check'>; status?: never }
);

export interface OperationalState {
  version: typeof OPERATIONAL_STATE_VERSION;
  entries: OperationalEntry[];
}

interface UpdateBase {
  text: string;
  sourceMessageId: string;
  supersedes?: string;
  evidence?: EvidenceRef[];
  grant?: Grant;
}

export type OperationalUpdate = UpdateBase & (
  | { kind: 'check'; status: CheckStatus; evidence: EvidenceRef[] }
  | { kind: Exclude<OperationalKind, 'check'>; status?: never }
);

const evidenceSchema = Type.Object({
  kind: stringEnum(['self-reported', 'test', 'log', 'tool-result', 'external']),
  ref: Type.String({ minLength: 1, maxLength: MAX_EVIDENCE_REF_CHARS }),
}, { additionalProperties: false });
const grantSchema = Type.Object({
  action: stringEnum(GRANT_ACTIONS),
  scope: Type.String({ minLength: 1, maxLength: MAX_SCOPE_CHARS }),
  allow: Type.Boolean(),
  until: Type.String({ minLength: 1, maxLength: 32 }),
}, { additionalProperties: false });
const updateCommon = {
  text: Type.String({ minLength: 1, maxLength: MAX_TEXT_CHARS }),
  sourceMessageId: Type.String({ minLength: 1, maxLength: MAX_SOURCE_ID_CHARS }),
  supersedes: Type.Optional(Type.String({ pattern: '^op_[a-f0-9]{24}$' })),
};
const nonCheckKinds = ['objective', 'decision', 'constraint', 'authorization', 'change'] as const;
/** TypeBox schema for the parent-owned operational_state update tool. Parent must validate sourceMessageId against the live memory root. */
export const OperationalUpdateSchema = Type.Union([
  Type.Object({
    ...updateCommon,
    kind: stringEnum(nonCheckKinds),
    grant: Type.Optional(grantSchema),
    evidence: Type.Optional(Type.Array(evidenceSchema, { minItems: 1, maxItems: MAX_EVIDENCE_REFS })),
  }, { additionalProperties: false }),
  Type.Object({
    ...updateCommon,
    kind: Type.Literal('check'),
    status: stringEnum(['verified', 'not_verified', 'blocked']),
    evidence: Type.Array(evidenceSchema, { minItems: 1, maxItems: MAX_EVIDENCE_REFS }),
  }, { additionalProperties: false }),
]);

function fail(message: string): never { throw new Error(`Invalid operational state: ${message}`); }
function assertKeys(value: Record<string, unknown>, allowed: string[], name: string) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${name} contains an unsupported field`);
}
const boundedString = (value: unknown, name: string, max: number) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${name} must be a non-empty string of at most ${max} characters`);
  return value;
};

function validateEvidenceRef(value: unknown, index: number): EvidenceRef {
  if (!isRecord(value)) fail(`evidence[${index}] must be an object`);
  assertKeys(value, ['kind', 'ref'], `evidence[${index}]`);
  if (value.kind !== 'self-reported' && value.kind !== 'test' && value.kind !== 'log' && value.kind !== 'tool-result' && value.kind !== 'external') fail(`evidence[${index}].kind is unsupported`);
  return { kind: value.kind, ref: boundedString(value.ref, `evidence[${index}].ref`, MAX_EVIDENCE_REF_CHARS) };
}

function validateEvidence(value: unknown): EvidenceRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EVIDENCE_REFS) fail(`evidence must contain 1–${MAX_EVIDENCE_REFS} references`);
  return value.map(validateEvidenceRef);
}

function validateGrant(value: unknown, where: string): Grant {
  if (!isRecord(value)) fail(`${where} must be an object`);
  assertKeys(value, ['action', 'scope', 'allow', 'until'], where);
  if (!GRANT_ACTIONS.includes(value.action as GrantAction)) fail(`${where}.action must be one of ${GRANT_ACTIONS.join(', ')}`);
  if (typeof value.allow !== 'boolean') fail(`${where}.allow must be a boolean`);
  // Stored as written (slashes aside): a Linux checkout is case-sensitive, and matching lowercases on its own.
  const scope = boundedString(value.scope, `${where}.scope`, MAX_SCOPE_CHARS).trim().replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  const until = boundedString(value.until, `${where}.until`, 32);
  if (until !== 'done' && (!Number.isFinite(Date.parse(until)) || new Date(until).toISOString() !== until)) fail(`${where}.until must be 'done' or an ISO timestamp`);
  return { action: value.action as GrantAction, scope, allow: value.allow, until };
}

function identity(entry: Pick<OperationalEntry, 'kind' | 'text' | 'sourceMessageId' | 'supersedes' | 'evidence' | 'grant'> & { status?: CheckStatus }) {
  return JSON.stringify({ kind: entry.kind, text: entry.text, sourceMessageId: entry.sourceMessageId,
    ...(entry.grant === undefined ? {} : { grant: entry.grant }),
    ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }),
    ...(entry.status === undefined ? {} : { status: entry.status }),
    ...(entry.evidence === undefined ? {} : { evidence: entry.evidence }) });
}

function stableId(entry: Parameters<typeof identity>[0]) {
  return `op_${createHash('sha256').update(identity(entry)).digest('hex').slice(0, 24)}`;
}

function operationalKind(value: unknown, where: string): OperationalKind {
  if (value !== 'objective' && value !== 'decision' && value !== 'constraint' && value !== 'authorization' && value !== 'change' && value !== 'check') fail(`${where} is unsupported`);
  return value;
}

function commonFields(value: Record<string, unknown>) {
  const text = boundedString(value.text, 'text', MAX_TEXT_CHARS);
  const sourceMessageId = boundedString(value.sourceMessageId, 'sourceMessageId', MAX_SOURCE_ID_CHARS);
  const supersedes = value.supersedes === undefined ? undefined : boundedString(value.supersedes, 'supersedes', 27);
  if (supersedes !== undefined && !ID_PATTERN.test(supersedes)) fail('supersedes must be an operational entry ID');
  const evidence = value.evidence === undefined ? undefined : validateEvidence(value.evidence);
  const grant = value.grant === undefined ? undefined : validateGrant(value.grant, 'grant');
  if (grant && value.kind !== 'authorization') fail('only authorization records carry a grant');
  return { text, sourceMessageId, ...(grant === undefined ? {} : { grant }), ...(evidence === undefined ? {} : { evidence }), ...(supersedes === undefined ? {} : { supersedes }) };
}

function validateCheckEvidence(status: CheckStatus, evidence: EvidenceRef[], where: string) {
  if (status === 'verified' && evidence.every(item => item.kind === 'self-reported')) fail(`${where} cannot be verified by self-reported evidence alone`);
}

function validateUpdate(value: unknown): OperationalUpdate {
  if (!isRecord(value)) fail('update must be an object');
  const kind = operationalKind(value.kind, 'kind');
  assertKeys(value, ['kind', 'text', 'sourceMessageId', 'supersedes', 'evidence', ...(kind === 'check' ? ['status'] : ['grant'])], 'update');
  const fields = commonFields(value);
  if (kind !== 'check') {
    if (Object.hasOwn(value, 'status')) fail('only checks have a status');
    return { kind, ...fields };
  }
  if (value.status !== 'verified' && value.status !== 'not_verified' && value.status !== 'blocked') fail('check status must be verified, not_verified, or blocked');
  if (!fields.evidence) fail('checks require evidence references');
  validateCheckEvidence(value.status, fields.evidence, 'check');
  return { kind, ...fields, status: value.status, evidence: fields.evidence };
}

function persistedEntry(value: unknown, index: number): OperationalEntry {
  const name = `entries[${index}]`;
  if (!isRecord(value)) fail(`${name} must be an object`);
  const kind = operationalKind(value.kind, `${name}.kind`);
  assertKeys(value, ['id', 'kind', 'text', 'sourceMessageId', 'createdAt', 'supersedes', 'evidence', ...(kind === 'check' ? ['status'] : ['grant'])], name);
  const id = boundedString(value.id, `${name}.id`, 27);
  if (!ID_PATTERN.test(id)) fail(`${name}.id is invalid`);
  const createdAt = boundedString(value.createdAt, `${name}.createdAt`, 32);
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) fail(`${name}.createdAt must be an ISO timestamp`);
  const fields = commonFields(value);
  let entry: OperationalEntry;
  if (kind === 'check') {
    if (value.status !== 'verified' && value.status !== 'not_verified' && value.status !== 'blocked') fail(`${name}.status is invalid`);
    if (!fields.evidence) fail(`${name} check has no evidence`);
    validateCheckEvidence(value.status, fields.evidence, `${name} check`);
    entry = { id, kind, ...fields, createdAt, status: value.status, evidence: fields.evidence };
  } else {
    if (Object.hasOwn(value, 'status')) fail(`${name} non-check has a status`);
    entry = { id, kind, ...fields, createdAt };
  }
  if (stableId(entry) !== id) fail(`${name}.id does not match its content`);
  return entry;
}

function validateLineage(entries: OperationalEntry[]) {
  const positions = new Map<string, number>(), successors = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (positions.has(entry.id)) fail(`duplicate entry ID ${entry.id}`);
    positions.set(entry.id, index);
  }
  for (const [index, entry] of entries.entries()) {
    if (!entry.supersedes) continue;
    const previous = positions.get(entry.supersedes);
    const prior = previous === undefined ? undefined : entries[previous];
    if (previous === undefined || previous >= index || !prior || prior.kind !== entry.kind) fail(`entry ${entry.id} supersedes a missing, later, or different-kind record`);
    if (successors.has(prior.id)) fail(`entry ${prior.id} has multiple successors`);
    successors.add(prior.id);
  }
}

function validateState(value: unknown): OperationalState {
  if (!isRecord(value)) fail('document must be an object');
  assertKeys(value, ['version', 'entries'], 'document');
  if (value.version !== OPERATIONAL_STATE_VERSION) fail(`version must be ${OPERATIONAL_STATE_VERSION}`);
  if (!Array.isArray(value.entries) || value.entries.length > MAX_OPERATIONAL_ENTRIES) fail(`entries must contain at most ${MAX_OPERATIONAL_ENTRIES} records`);
  const entries = value.entries.map(persistedEntry);
  validateLineage(entries);
  return { version: OPERATIONAL_STATE_VERSION, entries };
}

export function emptyOperationalState(): OperationalState {
  return { version: OPERATIONAL_STATE_VERSION, entries: [] };
}

/** Reads and strictly validates the bounded JSON document. Corruption is surfaced rather than overwritten. */
export function readOperationalState(file: string): OperationalState {
  if (!existsSync(file)) return emptyOperationalState();
  const size = statSync(file).size;
  if (size > MAX_OPERATIONAL_STATE_BYTES) fail(`file exceeds ${MAX_OPERATIONAL_STATE_BYTES} bytes`);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Could not read operational state JSON at ${file}`, { cause: error }); }
  if (Buffer.byteLength(JSON.stringify(parsed), 'utf8') > MAX_OPERATIONAL_STATE_BYTES) fail(`document exceeds ${MAX_OPERATIONAL_STATE_BYTES} bytes`);
  return validateState(parsed);
}

/** Appends one explicit fact, preserving prior records and their supersession lineage. */
export function updateOperationalState(file: string, update: OperationalUpdate): OperationalState {
  const input = validateUpdate(update);
  // Older records may hold prose scopes; a new one must be matchable, or the grant it describes never applies.
  if (input.grant && /[\s;,#]/.test(input.grant.scope)) fail('grant.scope must be one repo root, path or glob (no spaces, lists or prose); put the details in text');
  const current = readOperationalState(file);
  const id = stableId(input);
  const duplicate = current.entries.find(entry => entry.id === id);
  if (duplicate) return current;
  if (current.entries.length >= MAX_OPERATIONAL_ENTRIES) fail(`entry limit ${MAX_OPERATIONAL_ENTRIES} reached`);

  if (input.supersedes) {
    const prior = current.entries.find(entry => entry.id === input.supersedes);
    if (!prior || prior.kind !== input.kind) fail('supersedes must reference an existing record of the same kind');
    if (current.entries.some(entry => entry.supersedes === prior.id)) fail('superseded record already has a successor');
  }
  const entry = { id, ...input, createdAt: new Date().toISOString() } as OperationalEntry;
  const next = validateState({ version: OPERATIONAL_STATE_VERSION, entries: [...current.entries, entry] });
  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_OPERATIONAL_STATE_BYTES) fail(`document exceeds ${MAX_OPERATIONAL_STATE_BYTES} bytes`);
  atomicWrite(file, serialized);
  return next;
}

function normalizeScope(scope: string) {
  return scope.trim().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() || '/';
}

function scopeRegex(scope: string) {
  const escape = (piece: string) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const source = scope.split('**').map(part => part.split('*').map(escape).join('[^/]*')).join('.*');
  return new RegExp(`^${source}(?:/.*)?$`);
}

/** The spelling scopes and targets are matched in: repeated separators collapse and a Git Bash `/c/` drive reads as `c:/`. */
function matchPath(path: string) {
  return normalizeScope(path).replace(/\/{2,}/g, '/').replace(/^\/([a-z])(?=\/|$)/, '$1:');
}

/** True when `scope` (path or glob) covers `target`: the target is the scope's path or lies under it. */
export function scopeCovers(scope: string, target: string) {
  return scopeRegex(matchPath(scope)).test(matchPath(target));
}

const FOLDER_SCOPE = /^(?:[a-z]:)?\//;
const REPO_SLUG = /^[\w.-]+\/[\w.-]+$/;

/** Whether a grant's scope covers a target: by path (`scopeCovers`), or, for a wildcard-free folder scope, by the GitHub repository that checkout's origin names, for effects that target a repository by slug (`gh pr merge --repo`). */
export function grantCovers(scope: string, target: string, slugOf: FolderSlug = checkoutSlug) {
  if (scopeCovers(scope, target)) return true;
  const folder = matchPath(scope);
  // The checkout is read at the scope's own spelling: Linux paths are case-sensitive.
  const checkout = (scope.trim().replaceAll('\\', '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/').replace(/^\/([a-z])(?=\/|$)/i, '$1:');
  return REPO_SLUG.test(target) && FOLDER_SCOPE.test(folder) && !folder.includes('*') && slugOf(checkout) === target.toLowerCase();
}

const scopesOverlap = (a: string, b: string) => scopeCovers(a, b) || scopeCovers(b, a);
const expired = (grant: Grant, now: number) => grant.until !== 'done' && Date.parse(grant.until) <= now;

/** Grant records still in force: not expired, not explicitly superseded, not replaced by a newer same-action record with an overlapping scope. */
export function activeGrants(state: OperationalState, now = Date.now()) {
  const explicit = new Set(state.entries.flatMap(entry => entry.supersedes ? [entry.supersedes] : []));
  const grants = state.entries.flatMap((entry, index) => entry.kind === 'authorization' && entry.grant && !explicit.has(entry.id) && !expired(entry.grant, now)
    ? [{ entry, grant: entry.grant, index }] : []);
  return grants.filter(a => !grants.some(b => b.index > a.index && b.grant.action === a.grant.action && scopesOverlap(a.grant.scope, b.grant.scope)))
    .map(({ entry, grant }) => ({ entry, grant }));
}

/** The latest active grant of `action` whose scope covers `target`; its `allow` says whether the action is permitted. Undefined when no record applies. */
export function latestGrant(state: OperationalState, action: GrantAction, target: string, now = Date.now()) {
  return activeGrants(state, now).filter(({ grant }) => grant.action === action && grantCovers(grant.scope, target)).at(-1);
}

/** Grant action a risk-class call needs, or undefined when no grant action applies. */
export function grantActionFor(kind: string | undefined, input: unknown): GrantAction | undefined {
  const command = isRecord(input) && typeof input.command === 'string' ? input.command : '';
  switch (kind) {
    case 'push': return 'push';
    case 'publish': return /\bpr\s+merge\b/.test(command) ? 'merge' : 'publish';
    case 'paid model call': return 'paid';
    case 'recursive delete': case 'discard': return 'delete';
    default: return undefined;
  }
}

/** Where a call acts: the session folder, each folder its shell segments `cd` into, and every `git -C` folder. */
export function grantTargets(input: unknown, cwd: string) {
  const command = isRecord(input) && typeof input.command === 'string' ? input.command : '';
  const dirs = segments(command, cwd).flatMap(({ command: segment, dir }) =>
    [dir, ...[...segment.matchAll(/\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/g)].map(match => normalPath(match[1], dir))]);
  return [...new Set([cwd, ...dirs])];
}

/** Actions an operator's typed order may lift past an `ask` rule, and the words that must name them in the quote. */
const ORDER_WORDS: Partial<Record<GrantAction, RegExp>> = { merge: /merg|mescl/i, deploy: /deplo/i, publish: /publi|release|lan[cç]/i };
const NEGATION = /(?:^|[^\p{L}])(?:sem|n[ãa]o|nunca|nem|jamais|not|never|without|don'?t)(?![\p{L}])/iu;
/** How long a typed order keeps lifting `ask` rules: a work session, not a standing permission. */
export const ORDER_GRANT_TTL_MS = 12 * 3_600_000;

/** True when some clause names the action with no negation before it, and no clause negates it. */
function namesAction(text: string, action: GrantAction) {
  const word = ORDER_WORDS[action];
  if (!word) return false;
  const verdicts = text.split(/[.;,!?\n]/).flatMap(clause => {
    const found = word.exec(clause);
    return found ? [!NEGATION.test(clause.slice(0, found.index))] : [];
  });
  return verdicts.length > 0 && verdicts.every(Boolean);
}

/** One place, not a family: an owner/repo slug or a path at least three levels deep, without wildcards. */
const specificScope = (scope: string) => !scope.includes('*') && (/^[^/:]+\/[^/]+$/.test(scope) || scope.split('/').filter(Boolean).length >= 3);

/**
 * The operator's typed order that lifts an `ask` rule for this effect, as a line for the log, or undefined. The latest live
 * record that covers a target must be an allow on a specific scope, recorded within ORDER_GRANT_TTL_MS, whose text is still
 * exactly the operator's message (`sourceText` reads the original) and names this action without negating it. The record
 * either grants this action or is a merge/deploy/publish order that names it, so one typed sentence ("pode fazer o merge
 * e deploy") covers each action it names. A misread "sim", a model-widened scope, or a later "não o deploy" lifts nothing.
 * A folder scope covers the GitHub repository its checkout's origin names (`slugOf`, read locally).
 */
export function orderGrantFor(state: OperationalState, effect: { action: string; targets: string[] }, sourceText: (id: string) => string | undefined, now = Date.now(), slugOf: FolderSlug = checkoutSlug) {
  const action = effect.action as GrantAction, word = ORDER_WORDS[action];
  if (!word) return undefined;
  const found = activeGrants(state, now)
    .filter(({ entry, grant }) => (grant.action === action || (Object.hasOwn(ORDER_WORDS, grant.action) && word.test(entry.text)))
      && effect.targets.some(t => grantCovers(grant.scope, t, slugOf)))
    .at(-1);
  if (!found?.grant.allow || !specificScope(found.grant.scope)) return undefined;
  const { entry } = found, age = now - Date.parse(entry.createdAt);
  if (!(age >= 0 && age <= ORDER_GRANT_TTL_MS) || sourceText(entry.sourceMessageId) !== entry.text || !namesAction(entry.text, action)) return undefined;
  return `operator order ${entry.sourceMessageId} (record ${entry.id}): "${entry.text.length > 160 ? `${entry.text.slice(0, 159)}\u2026` : entry.text}"`;
}

/** One advisor-facing line about the latest grant matching any of the call's targets, or undefined when there is none. */
export function describeGrant(state: OperationalState, kind: string | undefined, input: unknown, target: string | string[], now = Date.now()) {
  const action = grantActionFor(kind, input), targets = [target].flat();
  const found = action && activeGrants(state, now).filter(({ grant }) => grant.action === action && targets.some(t => grantCovers(grant.scope, t))).at(-1);
  return found ? `${found.grant.allow ? 'ALLOWED' : 'PROHIBITED'} ${found.grant.action} in ${found.grant.scope} until ${found.grant.until} (record ${found.entry.id}, source message ${found.entry.sourceMessageId}): ${found.entry.text}` : undefined;
}

const KIND_ORDER: OperationalKind[] = ['objective', 'constraint', 'authorization', 'decision', 'check', 'change'];
const CONTEXT_HEADER = 'Operational state (records; no authority; implementation != verification):';
const TRUNCATION_NOTE = '[TRUNCATED: records omitted; inspect full state.]';

/** Produces a bounded structured prompt section; evidence labels are preserved and authorization remains non-authoritative. */
export function renderOperationalContext(state: OperationalState, maxChars = 6_000, now = Date.now()): string {
  const valid = validateState(state);
  if (!Number.isInteger(maxChars) || maxChars < 128) throw new Error('maxChars must be an integer of at least 128');
  const limit = Math.min(maxChars, MAX_OPERATIONAL_CONTEXT_CHARS);
  const superseded = new Set(valid.entries.flatMap(entry => entry.supersedes ? [entry.supersedes] : []));
  const liveGrants = new Set(activeGrants(valid, now).map(({ entry }) => entry.id));
  const active = valid.entries.filter(entry => !superseded.has(entry.id) && (!entry.grant || liveGrants.has(entry.id))).sort((a, b) => {
    const kind = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    return kind || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
  });
  const lines = [CONTEXT_HEADER];
  for (const [index, entry] of active.entries()) {
    const details = [`${entry.kind}${entry.kind === 'check' ? `:${entry.status}` : ''}`, `id=${entry.id}`, `source=${entry.sourceMessageId}`,
      ...(entry.grant ? [`grant=${entry.grant.allow ? 'allow' : 'deny'}:${entry.grant.action} scope=${entry.grant.scope} until=${entry.grant.until}`] : []),
      ...(entry.supersedes ? [`supersedes=${entry.supersedes}`] : [])];
    const record = [`- ${details.join(' ')} — ${entry.text}`,
      ...(entry.evidence ?? []).map(item => `  evidence [${item.kind}${item.kind === 'self-reported' ? '; unverified assertion' : ''}] ${item.ref}`)].join('\n');
    const candidate = [...lines, record].join('\n');
    const moreRecords = index < active.length - 1;
    if (candidate.length > limit || (moreRecords && candidate.length + 1 + TRUNCATION_NOTE.length > limit)) {
      lines.push(TRUNCATION_NOTE);
      break;
    }
    lines.push(record);
  }
  return lines.join('\n');
}
