import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boundedText } from '../contracts/validation.ts';
import { sha256 as sha } from '../hash.ts';
import { immediate } from '../store/transaction.ts';
import { allRows } from '../store/rows.ts';

/**
 * Versioned learning proposals: a concrete change to one allow-listed file, with its justification, test,
 * risk and rollback. Nothing in a proposal's own fields can approve it: approval, application and revert take
 * the operator authority object, which no message, page or connector result can carry. A proposal is approved
 * only after a measured improvement on the retained set; one that does not improve is rejected with its
 * measurement kept. Applying checks the file still holds the content the proposal was made against, and keeps
 * that content so revert restores it exactly.
 */
export type Risk = 'low' | 'medium' | 'high';
export type ProposalState = 'proposed' | 'measured' | 'approved' | 'applied' | 'reverted' | 'rejected' | 'superseded';
export type ProposalInput = { target: string; content: string; justification: string; test: string; risk: Risk; rollback: string; evidence: string[] };
export type Proposal = ProposalInput & {
  id: string; version: number; state: ProposalState; baseHash: string; contentHash: string; createdAt: string;
  before: number | null; after: number | null; decisionReason: string | null;
};
export type Evaluator = (content: string, target: string) => number | Promise<number>;
export type ProposalOptions = { databasePath: string; profileId: string; operatorAuthority: object; targets: string[]; evaluate: Evaluator; now?: () => number };

const MAX_CONTENT = 256 * 1024;
const MAX_FIELD = 4096;
const RISKS: readonly string[] = ['low', 'medium', 'high'];
const fail = (code: string): never => { throw new Error(code); };
const field = boundedText(MAX_FIELD);
const key = (path: string) => { const full = resolve(path); return process.platform === 'win32' ? full.toLowerCase() : full; };

export class LearningProposals {
  private readonly db: DatabaseSync;
  private readonly profileId: string;
  private readonly authority: object;
  private readonly targets: Map<string, string>;
  private readonly evaluate: Evaluator;
  private readonly now: () => number;
  constructor(options: ProposalOptions) {
    if (!options.operatorAuthority || typeof options.operatorAuthority !== 'object' || !field(options.profileId) || typeof options.evaluate !== 'function' || !Array.isArray(options.targets) || options.targets.length === 0) fail('invalid_options');
    this.profileId = options.profileId;
    this.authority = options.operatorAuthority;
    this.evaluate = options.evaluate;
    this.now = options.now ?? Date.now;
    this.targets = new Map(options.targets.map(t => [key(t), resolve(t)]));
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS learning_proposals (id TEXT NOT NULL, version INTEGER NOT NULL, profile TEXT NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL, base_hash TEXT NOT NULL, before REAL, after REAL, reason TEXT, previous TEXT, PRIMARY KEY (id, version));`);
  }

  /** Records a proposal against the target's current content. `revises` starts a new version and supersedes the open one. */
  propose(input: ProposalInput, revises?: string): Proposal {
    const target = this.target(input?.target);
    const ok = typeof input.content === 'string' && input.content.isWellFormed() && input.content.length <= MAX_CONTENT
      && [input.justification, input.test, input.rollback].every(field) && RISKS.includes(input.risk)
      && Array.isArray(input.evidence) && input.evidence.length > 0 && input.evidence.length <= 32 && input.evidence.every(field);
    if (!ok) fail('invalid_proposal');
    const body: ProposalInput = { target, content: input.content, justification: input.justification, test: input.test, risk: input.risk, rollback: input.rollback, evidence: [...input.evidence] };
    const base = this.readTarget(target);
    if (sha(base) === sha(body.content)) fail('proposal_no_change');
    let id: string = randomUUID(); let version = 1;
    if (revises !== undefined) {
      const latest = this.latest(revises);
      if (!['proposed', 'measured', 'rejected'].includes(latest.state)) fail('proposal_not_revisable');
      if (latest.target !== target) fail('invalid_proposal');
      id = latest.id; version = latest.version + 1;
      if (latest.state !== 'rejected') this.setState(latest, 'superseded', 'revised');
    }
    this.db.prepare('INSERT INTO learning_proposals (id, version, profile, body, state, base_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, version, this.profileId, JSON.stringify({ ...body, createdAt: new Date(this.now()).toISOString() }), 'proposed', sha(base));
    return this.get(id, version);
  }

  /** Scores the current file and the proposed content on the retained set; no improvement rejects the proposal, keeping both scores. */
  async measure(id: string): Promise<Proposal> {
    const p = this.latest(id);
    if (p.state !== 'proposed') fail('proposal_not_measurable');
    const base = this.readTarget(p.target);
    if (sha(base) !== p.baseHash) fail('target_changed');
    let before: number; let after: number;
    try { before = await this.evaluate(base, p.target); after = await this.evaluate(p.content, p.target); } catch { return fail('evaluation_failed'); }
    if (!Number.isFinite(before) || !Number.isFinite(after)) fail('evaluation_failed');
    const improved = after > before;
    const changed = this.db.prepare('UPDATE learning_proposals SET state = ?, before = ?, after = ?, reason = ? WHERE id = ? AND version = ? AND profile = ? AND state = ?')
      .run(improved ? 'measured' : 'rejected', before, after, improved ? null : 'not_improved', p.id, p.version, this.profileId, 'proposed').changes;
    if (changed !== 1) fail('proposal_conflict');
    return this.get(p.id, p.version);
  }

  decide(id: string, decision: 'approve' | 'reject', authority: object, reason: string): Proposal {
    this.authorize(authority);
    if (!field(reason)) fail('invalid_decision');
    const p = this.latest(id);
    if (decision === 'approve') {
      if (p.state !== 'measured') fail(p.state === 'proposed' ? 'proposal_unmeasured' : 'proposal_not_approvable');
    } else if (decision === 'reject') {
      if (!['proposed', 'measured', 'approved'].includes(p.state)) fail('proposal_not_rejectable');
    } else fail('invalid_decision');
    this.setState(p, decision === 'approve' ? 'approved' : 'rejected', reason);
    return this.get(p.id, p.version);
  }

  /** Writes the approved content only if the file still holds the content the proposal was measured against. */
  apply(id: string, authority: object): Proposal {
    this.authorize(authority);
    const p = this.latest(id);
    if (p.state !== 'approved') fail('proposal_not_approved');
    const base = this.readTarget(p.target);
    if (sha(base) !== p.baseHash) fail('target_changed');
    this.transition(p, 'applied', p.decisionReason ?? 'applied', () => {
      this.db.prepare('UPDATE learning_proposals SET previous = ? WHERE id = ? AND version = ? AND profile = ?').run(base, p.id, p.version, this.profileId);
      this.writeTarget(p.target, p.content);
    });
    return this.get(p.id, p.version);
  }

  /** Restores the exact previous content, refusing if the file changed after the proposal was applied. */
  revert(id: string, authority: object, reason: string): Proposal {
    this.authorize(authority);
    if (!field(reason)) fail('invalid_decision');
    const p = this.latest(id);
    if (p.state !== 'applied') fail('proposal_not_applied');
    if (sha(this.readTarget(p.target)) !== p.contentHash) fail('target_changed');
    const row = this.db.prepare('SELECT previous FROM learning_proposals WHERE id = ? AND version = ? AND profile = ?').get(p.id, p.version, this.profileId) as { previous: string | null };
    if (typeof row.previous !== 'string') fail('proposal_not_applied');
    this.transition(p, 'reverted', reason, () => this.writeTarget(p.target, row.previous as string));
    return this.get(p.id, p.version);
  }

  get(id: string, version: number): Proposal {
    const row = this.db.prepare('SELECT * FROM learning_proposals WHERE id = ? AND version = ? AND profile = ?').get(id, version, this.profileId) as Record<string, unknown> | undefined;
    if (!row) fail('proposal_not_found');
    return this.toProposal(row as Record<string, unknown>);
  }

  /** Every version, oldest first; superseded and rejected versions stay readable as evidence. */
  history(id: string): Proposal[] {
    return allRows<Record<string, unknown>, Proposal>(this.db, 'SELECT * FROM learning_proposals WHERE id = ? AND profile = ? ORDER BY version', r => this.toProposal(r), id, this.profileId);
  }

  close(): void { this.db.close(); }

  private latest(id: string): Proposal {
    const versions = typeof id === 'string' ? this.history(id) : [];
    return versions.at(-1) ?? fail('proposal_not_found');
  }
  private authorize(authority: object): void { if (authority !== this.authority) fail('unauthorized'); }
  private target(path: unknown): string {
    if (typeof path !== 'string' || !path) fail('target_not_allowed');
    return this.targets.get(key(path as string)) ?? fail('target_not_allowed');
  }
  private readTarget(path: string): string {
    try { return readFileSync(path, 'utf8'); } catch { return fail('target_unreadable'); }
  }
  private writeTarget(path: string, content: string): void {
    const temp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temp, content, 'utf8');
    renameSync(temp, path);
  }
  private setState(p: Proposal, state: ProposalState, reason: string): void {
    const changed = this.db.prepare('UPDATE learning_proposals SET state = ?, reason = ? WHERE id = ? AND version = ? AND profile = ? AND state = ?')
      .run(state, reason, p.id, p.version, this.profileId, p.state).changes;
    if (changed !== 1) fail('proposal_conflict');
  }
  /** State and file change together: the state is claimed first and rolled back if the write fails, so a lost race writes nothing. */
  private transition(p: Proposal, state: ProposalState, reason: string, write: () => void): void {
    immediate(this.db, () => { this.setState(p, state, reason); write(); });
  }
  private toProposal(row: Record<string, unknown>): Proposal {
    const body = JSON.parse(row.body as string) as ProposalInput & { createdAt: string };
    return {
      ...body, evidence: [...body.evidence], id: row.id as string, version: row.version as number, state: row.state as ProposalState,
      baseHash: row.base_hash as string, contentHash: sha(body.content), before: row.before as number | null, after: row.after as number | null,
      decisionReason: (row.reason as string | null) ?? null,
    };
  }
}
