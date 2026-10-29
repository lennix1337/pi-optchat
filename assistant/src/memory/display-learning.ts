import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from '../hash.ts';
import { immediate } from '../store/transaction.ts';
import { retainedResults, RETAINED_DATASET, RETAINED_DATASET_HASH } from './retained-evaluator.ts';

export type DisplayBinding = { profileId: string; id: string; version: number; baseRevision: number; baseHash: string; candidateHash: string; datasetHash: string };
export type DisplayProposal = DisplayBinding & { candidate: string; baseline: string; state: 'proposed' | 'measured' | 'rejected' | 'approved' | 'applied' | 'reverted'; measurement: DisplayMeasurement | null; appliedRevision: number | null; reason: string | null };
export type DisplayMeasurement = { datasetId: string; datasetHash: string; provenance: string; baseline: ReturnType<typeof retainedResults>; candidate: ReturnType<typeof retainedResults> };
export type DisplayPreference = { text: string; revision: number; hash: string };

const initial = 'dashboard';
const fail = (message: string): never => { throw new Error(message); };
function validText(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed() && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
export function displayBinding(p: DisplayProposal): DisplayBinding {
  return { profileId: p.profileId, id: p.id, version: p.version, baseRevision: p.baseRevision, baseHash: p.baseHash, candidateHash: p.candidateHash, datasetHash: p.datasetHash };
}

/** Read the initialized learning-display.sqlite for one profile without mutation authority. Render text only, never as markup or instructions; a missing or unreadable database is an error. */
export function readDisplayPreference(databasePath: string, profileId: string): DisplayPreference {
  if (!validText(profileId)) fail('invalid_options');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare('SELECT text,revision FROM learning_display_current WHERE profile=?').get(profileId) as { text: string; revision: number } | undefined;
    const text = row?.text ?? initial;
    return { text, revision: row?.revision ?? 0, hash: sha256(text) };
  } finally { db.close(); }
}

/** Mutation construction and database access belong only to a trusted local CLI/process. The authority object is an in-process capability, not proof of a human. Web/model consumers get only read-only APIs; OS owners and database administrators are outside this boundary. Display labels are never instructions or markup. */
export class DisplayLearning {
  private readonly db: DatabaseSync;
  private readonly profile: string;
  private readonly authority: object;
  constructor(options: { databasePath: string; profileId: string; operatorAuthority: object }) {
    if (!validText(options.profileId) || !options.operatorAuthority || typeof options.operatorAuthority !== 'object') fail('invalid_options');
    this.profile = options.profileId; this.authority = options.operatorAuthority;
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS learning_display_current (profile TEXT PRIMARY KEY, text TEXT NOT NULL, revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS learning_display_proposal (profile TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, baseline TEXT NOT NULL, base_revision INTEGER NOT NULL, base_hash TEXT NOT NULL, candidate TEXT NOT NULL, candidate_hash TEXT NOT NULL, dataset_hash TEXT NOT NULL, state TEXT NOT NULL, measurement TEXT, applied_revision INTEGER, reason TEXT, PRIMARY KEY(profile,id,version));`);
  }
  current(): DisplayPreference {
    const row = this.db.prepare('SELECT text,revision FROM learning_display_current WHERE profile=?').get(this.profile) as { text: string; revision: number } | undefined;
    const text = row?.text ?? initial; return { text, revision: row?.revision ?? 0, hash: sha256(text) };
  }
  propose(candidate: string): DisplayProposal {
    if (!validText(candidate)) fail('invalid_candidate');
    return immediate(this.db, () => {
      const base = this.current(); if (base.text === candidate) fail('proposal_no_change');
      const id = randomUUID();
      this.db.prepare('INSERT INTO learning_display_proposal (profile,id,version,baseline,base_revision,base_hash,candidate,candidate_hash,dataset_hash,state) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(this.profile, id, 1, base.text, base.revision, base.hash, candidate, sha256(candidate), RETAINED_DATASET_HASH, 'proposed');
      return this.get(id, 1);
    });
  }
  get(id: string, version: number): DisplayProposal {
    const r = this.db.prepare('SELECT * FROM learning_display_proposal WHERE profile=? AND id=? AND version=?').get(this.profile, id, version) as Record<string, unknown> | undefined;
    if (!r) return fail('proposal_not_found');
    return { profileId: r.profile as string, id: r.id as string, version: r.version as number, baseline: r.baseline as string, baseRevision: r.base_revision as number, baseHash: r.base_hash as string, candidate: r.candidate as string, candidateHash: r.candidate_hash as string, datasetHash: r.dataset_hash as string, state: r.state as DisplayProposal['state'], measurement: r.measurement === null ? null : JSON.parse(r.measurement as string) as DisplayMeasurement, appliedRevision: r.applied_revision as number | null, reason: r.reason as string | null };
  }
  /** Read-only, bounded product review list for this profile; decisions remain in the trusted CLI. */
  list(): DisplayProposal[] {
    const rows = this.db.prepare('SELECT id,version FROM learning_display_proposal WHERE profile=? ORDER BY rowid DESC LIMIT 50').all(this.profile) as { id: string; version: number }[];
    return rows.map(row => this.get(row.id, row.version));
  }
  private checked(b: DisplayBinding): DisplayProposal {
    if (b.profileId !== this.profile) fail('stale_binding');
    const p = this.get(b.id, b.version);
    if (p.baseRevision !== b.baseRevision || p.baseHash !== b.baseHash || p.candidateHash !== b.candidateHash || p.datasetHash !== b.datasetHash || b.datasetHash !== RETAINED_DATASET_HASH) fail('stale_binding');
    return p;
  }
  private baseCurrent(p: DisplayProposal): void {
    const current = this.current(); if (current.revision !== p.baseRevision || current.hash !== p.baseHash) fail('stale_baseline');
  }
  private authorized(authority: object): void { if (authority !== this.authority) fail('unauthorized'); }
  measure(binding: DisplayBinding): DisplayProposal {
    return immediate(this.db, () => {
      const p = this.checked(binding); if (p.state !== 'proposed') fail('proposal_not_measurable'); this.baseCurrent(p);
      const measurement: DisplayMeasurement = { datasetId: RETAINED_DATASET.id, datasetHash: RETAINED_DATASET_HASH, provenance: RETAINED_DATASET.provenance, baseline: retainedResults(p.baseline), candidate: retainedResults(p.candidate) };
      const improved = measurement.candidate.score > measurement.baseline.score;
      this.db.prepare('UPDATE learning_display_proposal SET state=?, measurement=?, reason=? WHERE profile=? AND id=? AND version=?').run(improved ? 'measured' : 'rejected', JSON.stringify(measurement), improved ? null : 'not_improved', this.profile, p.id, p.version);
      return this.get(p.id, p.version);
    });
  }
  decide(binding: DisplayBinding, decision: 'approve' | 'reject', authority: object, reason: string): DisplayProposal {
    this.authorized(authority); if (!validText(reason)) fail('invalid_reason');
    return immediate(this.db, () => {
      const p = this.checked(binding); this.baseCurrent(p);
      if (p.state !== 'measured' || !['approve', 'reject'].includes(decision)) fail('proposal_not_decidable');
      this.db.prepare('UPDATE learning_display_proposal SET state=?,reason=? WHERE profile=? AND id=? AND version=?').run(decision === 'approve' ? 'approved' : 'rejected', reason, this.profile, p.id, p.version);
      return this.get(p.id, p.version);
    });
  }
  apply(binding: DisplayBinding, authority: object): DisplayProposal {
    this.authorized(authority);
    return immediate(this.db, () => {
      const p = this.checked(binding); if (p.state !== 'approved') fail('proposal_not_approved'); this.baseCurrent(p);
      const next = p.baseRevision + 1;
      this.db.prepare('INSERT INTO learning_display_current(profile,text,revision) VALUES(?,?,?) ON CONFLICT(profile) DO UPDATE SET text=excluded.text,revision=excluded.revision').run(this.profile, p.candidate, next);
      this.db.prepare('UPDATE learning_display_proposal SET state=?,applied_revision=? WHERE profile=? AND id=? AND version=?').run('applied', next, this.profile, p.id, p.version);
      return this.get(p.id, p.version);
    });
  }
  revert(binding: DisplayBinding, authority: object, reason: string): DisplayProposal {
    this.authorized(authority); if (!validText(reason)) fail('invalid_reason');
    return immediate(this.db, () => {
      const p = this.checked(binding); if (p.state !== 'applied') fail('proposal_not_applied');
      const current = this.current(); if (current.revision !== p.appliedRevision || current.hash !== p.candidateHash) fail('stale_applied');
      this.db.prepare('UPDATE learning_display_current SET text=?,revision=? WHERE profile=?').run(p.baseline, current.revision + 1, this.profile);
      this.db.prepare('UPDATE learning_display_proposal SET state=?,reason=? WHERE profile=? AND id=? AND version=?').run('reverted', reason, this.profile, p.id, p.version);
      return this.get(p.id, p.version);
    });
  }
  close(): void { this.db.close(); }
}
