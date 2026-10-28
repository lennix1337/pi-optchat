import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArtifact, type Artifact } from '../contracts/artifacts.ts';
import { boundedText, text } from '../contracts/validation.ts';
import { sha256 } from '../hash.ts';
import { immediate } from '../store/transaction.ts';

/**
 * Registered formats per skill-output type: the ones a browser renders locally without a converter.
 * PDF, DOCX and PPTX are refused because no local renderer is available here.
 */
export const artifactFormats: ReadonlyMap<string, readonly string[]> = new Map([
  ['document', ['.md']],
  ['slides', ['.html']],
  ['page', ['.html']],
  ['dashboard', ['.html']],
  ['design', ['.svg']],
  ['design_system', ['.json', '.css']],
]);
export type ArtifactType = 'document' | 'slides' | 'page' | 'dashboard' | 'design' | 'design_system';
export type ArtifactRecord = Artifact & { fileName: string; size: number; createdAt: string; reviewedBy: string | null; reviewedAt: string | null };
export type RegisterInput = { sourcePath: string; type: ArtifactType; ownerId: string; producerId: string; provenance: string; artifactId?: string };
export type ReviewDecision = 'approved' | 'rejected';
export type ArtifactPage = { artifacts: ArtifactRecord[]; more: boolean };
type Options = { databasePath: string; profileId: string; root: string; sourceRoots: string[]; now?: () => number };

const maxBytes = 16 * 1024 * 1024;
const pageSize = 100;
const field = boundedText(500);
const fileNamePattern = /^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,119}$/u;
const fail = (code: string): never => { throw new Error(code); };
const folded = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
function inside(root: string, path: string): boolean {
  const rel = relative(folded(root), folded(path));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Versioned registry of files produced by existing skills. Registration copies the producer's bytes into a
 * managed root, so a version keeps its hash even if the producer later rewrites its output. Every read
 * resolves the stored location under that root and re-checks the hash; artifact content stays untrusted.
 */
export class ArtifactRegistry {
  private readonly db: DatabaseSync;
  private readonly profileId: string;
  private readonly root: string;
  private readonly sourceRoots: string[];
  private readonly now: () => number;
  constructor({ databasePath, profileId, root, sourceRoots, now = Date.now }: Options) {
    if (!field(profileId) || !isAbsolute(root) || !Array.isArray(sourceRoots) || !sourceRoots.length || !sourceRoots.every(path => typeof path === 'string' && isAbsolute(path))) fail('invalid_options');
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
    this.sourceRoots = sourceRoots.map(path => realpathSync(path));
    this.profileId = profileId;
    this.now = now;
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS artifacts (profile TEXT NOT NULL, artifact_id TEXT NOT NULL, version INTEGER NOT NULL, type TEXT NOT NULL,
        artifact TEXT NOT NULL, file_name TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL, reviewed_by TEXT, reviewed_at TEXT,
        PRIMARY KEY (profile, artifact_id, version));`);
  }
  matchesProfile(profileId: string): boolean { return this.profileId === profileId; }

  /** Registers a new artifact, or the next version of `artifactId` with the same type and owner. */
  register(input: RegisterInput): ArtifactRecord {
    const formats = artifactFormats.get(input?.type) ?? fail('artifact_type_unsupported');
    if (![input.ownerId, input.producerId, input.provenance].every(field) || (input.artifactId !== undefined && !text(input.artifactId))) fail('artifact_invalid');
    const fileName = basename(input.sourcePath);
    if (!fileNamePattern.test(fileName) || !formats.includes(extname(fileName).toLowerCase())) fail('artifact_format_unsupported');
    const bytes = this.readSource(input.sourcePath);
    const hash = sha256(bytes);
    return immediate(this.db, () => {
      const previous = input.artifactId === undefined ? null : this.latest(input.artifactId) ?? fail('artifact_not_found');
      if (previous && (previous.type !== input.type || previous.ownerId !== input.ownerId)) fail('artifact_identity_mismatch');
      if (previous?.hash === hash) fail('artifact_no_change');
      const artifactId = previous?.artifactId ?? randomUUID();
      const artifactVersion = (previous?.artifactVersion ?? 0) + 1;
      const artifact = parseArtifact({
        version: 1, artifactId, profileId: this.profileId, ownerId: input.ownerId, type: input.type, artifactVersion, hash,
        producerId: input.producerId, location: `${artifactId}/v${artifactVersion}/${fileName}`, provenance: input.provenance, review: 'not_reviewed',
      });
      const createdAt = new Date(this.now()).toISOString();
      this.db.prepare('INSERT INTO artifacts (profile, artifact_id, version, type, artifact, file_name, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(this.profileId, artifactId, artifactVersion, input.type, JSON.stringify(artifact), fileName, bytes.length, createdAt);
      const target = this.managedPath(artifact.location);
      mkdirSync(dirname(target), { recursive: true });
      // Written last: a failed write rolls back the row, so no row points at missing bytes.
      writeFileSync(target, bytes, { flag: 'wx' });
      return { ...artifact, fileName, size: bytes.length, createdAt, reviewedBy: null, reviewedAt: null };
    });
  }

  /** Latest version of each artifact, newest first, optionally of one type. */
  list(type?: string): ArtifactPage {
    if (type !== undefined && !artifactFormats.has(type)) fail('artifact_type_unsupported');
    const rows = this.db.prepare(`SELECT * FROM artifacts a WHERE profile = ? AND (? IS NULL OR type = ?)
      AND version = (SELECT MAX(version) FROM artifacts b WHERE b.profile = a.profile AND b.artifact_id = a.artifact_id)
      ORDER BY created_at DESC, artifact_id LIMIT ?`).all(this.profileId, type ?? null, type ?? null, pageSize + 1);
    return { artifacts: rows.slice(0, pageSize).map(row => this.record(row)), more: rows.length > pageSize };
  }
  versions(artifactId: string): ArtifactRecord[] {
    return this.db.prepare('SELECT * FROM artifacts WHERE profile = ? AND artifact_id = ? ORDER BY version').all(this.profileId, artifactId).map(row => this.record(row));
  }
  get(artifactId: string, version: number): ArtifactRecord | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE profile = ? AND artifact_id = ? AND version = ?').get(this.profileId, artifactId, version);
    return row ? this.record(row) : null;
  }
  /** Bytes of one version, only from under the managed root and only while they still match the registered hash. */
  read(artifactId: string, version: number): { record: ArtifactRecord; bytes: Buffer } {
    const record = this.get(artifactId, version) ?? fail('artifact_not_found');
    const path = this.managedPath(record.location);
    let bytes: Buffer;
    try { bytes = readFileSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('artifact_changed');
      throw error;
    }
    if (sha256(bytes) !== record.hash) fail('artifact_changed');
    return { record, bytes };
  }
  /** One review result per version; a changed artifact is a new version with its own review. */
  review(artifactId: string, version: number, decision: ReviewDecision, reviewerId: string): ArtifactRecord {
    if (decision !== 'approved' && decision !== 'rejected') fail('artifact_invalid');
    if (!field(reviewerId)) fail('artifact_invalid');
    return immediate(this.db, () => {
      const current = this.get(artifactId, version) ?? fail('artifact_not_found');
      if (current.review !== 'not_reviewed') fail('artifact_already_reviewed');
      const { fileName, size, createdAt, reviewedBy, reviewedAt, ...artifact } = current;
      const reviewed = parseArtifact({ ...artifact, review: decision });
      const at = new Date(this.now()).toISOString();
      this.db.prepare('UPDATE artifacts SET artifact = ?, reviewed_by = ?, reviewed_at = ? WHERE profile = ? AND artifact_id = ? AND version = ?')
        .run(JSON.stringify(reviewed), reviewerId, at, this.profileId, artifactId, version);
      return { ...reviewed, fileName, size, createdAt, reviewedBy: reviewerId, reviewedAt: at };
    });
  }
  close(): void { this.db.close(); }

  private latest(artifactId: string): ArtifactRecord | null {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE profile = ? AND artifact_id = ? ORDER BY version DESC LIMIT 1').get(this.profileId, artifactId);
    return row ? this.record(row) : null;
  }
  private record(row: Record<string, unknown>): ArtifactRecord {
    const artifact = parseArtifact(JSON.parse(String(row.artifact)));
    return { ...artifact, fileName: String(row.file_name), size: Number(row.size), createdAt: String(row.created_at), reviewedBy: row.reviewed_by === null ? null : String(row.reviewed_by), reviewedAt: row.reviewed_at === null ? null : String(row.reviewed_at) };
  }
  /** The only mapping from a stored location to disk: lexical and real paths must both stay under the managed root. */
  private managedPath(location: string): string {
    const path = resolve(this.root, location);
    if (!inside(this.root, path) || (existsSync(path) && !inside(this.root, realpathSync(path)))) fail('artifact_location_invalid');
    return path;
  }
  /** Producer output is read once from a regular, single-link file under a configured source root. */
  private readSource(sourcePath: string): Buffer {
    if (typeof sourcePath !== 'string' || !isAbsolute(sourcePath)) fail('artifact_invalid');
    let real: string;
    try {
      if (!lstatSync(sourcePath).isFile()) fail('artifact_source_invalid');
      real = realpathSync(sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('artifact_source_missing');
      throw error;
    }
    if (!this.sourceRoots.some(root => inside(root, real))) fail('artifact_source_outside_roots');
    const fd = openSync(real, constants.O_RDONLY);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) fail('artifact_source_invalid');
      const bytes = readFileSync(fd);
      if (bytes.length > maxBytes) fail('artifact_source_invalid');
      return bytes;
    } finally { closeSync(fd); }
  }
}
