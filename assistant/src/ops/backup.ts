import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from '../hash.ts';
import type { KeyProtector } from '../secrets/protector.ts';
import { TaskStore } from '../store/db.ts';
import { checkDirectoryPrivacy, prepareDatabase } from '../store/privacy.ts';
import { createPrivateDirectory } from '../store/private-directory.ts';
import { artifactName, collectArtifacts, MAX_BACKUP_BYTES, REGISTRY, validateArtifactImages, type BackupImage } from './artifact-backup.ts';

/**
 * Encrypted, self-contained backups of one service data directory. Every SQLite database there except the vault is
 * snapshotted in a read transaction, packed with a manifest and sealed with AES-256-GCM under a fresh data key that the
 * OS protector (DPAPI for the current Windows user) wraps; only the wrapped key travels in the header, which is
 * authenticated as associated data. Restore decrypts and checks everything in memory, fences anything that could repeat
 * an effect or reuse an approval, and only then writes into an empty private directory.
 */
export type BackupEntry = { name: string; bytes: number; sha256: string; tables: string[]; kind?: 'artifact' };
export type BackupManifest = { format: 1; profileId: string; createdAt: string; tasksDatabase: string; entries: BackupEntry[] };
export type BackupSummary = { out: string; entries: BackupEntry[]; excluded: { name: string; reason: 'vault' | 'not_sqlite' }[] };
export type RestoreFences = { jobs: number; leases: number; grants: number; reviews: number; routines: number; connectorGrants: number; toolEffects: number };
export type RestoreReport = { profileId: string; createdAt: string; files: string[]; tasksDatabase: string; fenced: RestoreFences };

const MAGIC = Buffer.from('OPTCHAT-ASSISTANT-BACKUP\n');
const MAX_ARCHIVE = MAX_BACKUP_BYTES;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const SIDECAR = /-(?:wal|shm|journal)$/;
const SUPPORTED_TASKS_VERSION = 1;

/**
 * What a restored snapshot must not do again: it may be older than the external world. Unfinished jobs may have run
 * after the backup, so they are not requeued (effects become `effect_uncertain`, others `blocked`); approvals and
 * connector grants may have been spent or revoked since; active routines may have claimed later slots.
 * Finished and already-uncertain jobs, gateway intents and delivered notifications stay exactly as backed up.
 */
const restoreFences: readonly { key: keyof RestoreFences; table: string; sql: string }[] = [
  { key: 'jobs', table: 'jobs', sql: "UPDATE jobs SET state = CASE kind WHEN 'effect' THEN 'effect_uncertain' ELSE 'blocked' END, error = 'restored_unreconciled' WHERE state IN ('queued', 'running', 'dispatching')" },
  // A completed preview plan may have dispatched after the snapshot, before its effect row existed in the archive.
  { key: 'jobs', table: 'jobs', sql: "UPDATE jobs SET state = 'blocked', error = 'restored_unreconciled' WHERE kind = 'draft' AND state = 'done' AND CASE WHEN json_valid(result) THEN json_extract(result, '$.kind') = 'browser_text' ELSE 0 END" },
  { key: 'leases', table: 'lease', sql: 'UPDATE lease SET expires = 0 WHERE expires != 0' },
  { key: 'grants', table: 'grants', sql: 'UPDATE grants SET revoked = 1 WHERE revoked = 0' },
  { key: 'reviews', table: 'reviews', sql: "UPDATE reviews SET state = 'revoked' WHERE state = 'pending'" },
  { key: 'routines', table: 'routines', sql: "UPDATE routines SET state = 'paused', paused_reason = 'restored', next_run = NULL WHERE state = 'active'" },
  { key: 'connectorGrants', table: 'connector_grants', sql: 'UPDATE connector_grants SET revoked = 1 WHERE revoked = 0' },
  { key: 'toolEffects', table: 'tool_effects', sql: "UPDATE tool_effects SET state = 'uncertain' WHERE state IN ('preparing', 'waiting', 'dispatching')" },
];

function fail(code: string): never { throw new Error(code); }
function isSqlite(path: string): boolean {
  const head = Buffer.alloc(SQLITE_MAGIC.length);
  const fd = openSync(path, 'r');
  try { return readSync(fd, head, 0, head.length, 0) === head.length && head.equals(SQLITE_MAGIC); } finally { closeSync(fd); }
}
function tablesOf(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name);
}
/** A consistent image of a live database. The header is switched to rollback-journal format so it can be deserialized. */
export function snapshotDatabase(path: string, budget = MAX_ARCHIVE): { image: Buffer; tables: string[] } {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    try {
      db.prepare('SELECT rootpage FROM sqlite_schema LIMIT 1').get();
      const pages = Number(db.prepare('PRAGMA page_count').get()!.page_count);
      const pageSize = Number(db.prepare('PRAGMA page_size').get()!.page_size);
      const logicalBytes = pages * pageSize;
      // File stat misses committed WAL pages. Inspect this same read transaction before allocating a snapshot.
      if (!Number.isSafeInteger(logicalBytes) || logicalBytes > budget) fail('backup_too_large');
      const tables = tablesOf(db);
      const image = Buffer.from(db.serialize());
      image[18] = 1; image[19] = 1;
      return { image, tables };
    } finally { db.exec('COMMIT'); }
  } finally { db.close(); }
}

function collectDatabases(dataDir: string, out: string): { files: BackupImage[]; excluded: BackupSummary['excluded'] } {
  const files: BackupImage[] = [], excluded: BackupSummary['excluded'] = [];
  let bytes = 0;
  for (const name of readdirSync(dataDir).sort()) {
    const path = join(dataDir, name);
    const info = lstatSync(path);
    if (SIDECAR.test(name) || path === out) continue;
    if (info.isSymbolicLink()) fail('backup_path_invalid');
    if (!info.isFile()) continue;
    if (info.nlink !== 1) fail('backup_path_invalid');
    if (info.size > MAX_ARCHIVE) fail('backup_too_large');
    if (!isSqlite(path)) { excluded.push({ name, reason: 'not_sqlite' }); continue; }
    if (!safeDatabaseName(name)) fail('backup_path_invalid');
    const { image, tables } = snapshotDatabase(path, MAX_ARCHIVE - bytes);
    // Vault secrets stay bound to their own store and key; they are re-entered, never carried in a backup.
    if (tables.includes('vault_key')) { image.fill(0); excluded.push({ name, reason: 'vault' }); continue; }
    bytes += image.length;
    if (bytes > MAX_ARCHIVE) { image.fill(0); fail('backup_too_large'); }
    files.push({ name, image, tables });
  }
  return { files, excluded };
}

export async function createBackup(options: { databasePath: string; profileId: string; out: string; protector: KeyProtector; now?: () => number }): Promise<BackupSummary> {
  const { databasePath, profileId, out, protector } = options;
  if (!isAbsolute(databasePath) || !isAbsolute(out) || typeof profileId !== 'string' || !profileId.trim()) fail('invalid_options');
  const dataDir = dirname(databasePath);
  const { files, excluded } = collectDatabases(dataDir, out);
  const entries: BackupEntry[] = [], images: Buffer[] = [];
  const budget = MAX_ARCHIVE - files.reduce((sum, file) => sum + file.image.length, 0);
  for (const file of [...files, ...collectArtifacts(dataDir, profileId, path => snapshotDatabase(path, budget), budget)]) {
    entries.push({ name: file.name, bytes: file.image.length, sha256: sha256(file.image), tables: file.tables, ...(file.kind ? { kind: file.kind } : {}) });
    images.push(file.image);
  }
  validateBackupEntries(entries);
  if (!entries.some(e => e.name === basename(databasePath))) fail('backup_tasks_missing');
  if (entries.reduce((sum, e) => sum + e.bytes, 0) > MAX_ARCHIVE) fail('backup_too_large');
  const manifest: BackupManifest = { format: 1, profileId, createdAt: new Date((options.now ?? Date.now)()).toISOString(), tasksDatabase: basename(databasePath), entries };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const length = Buffer.alloc(4); length.writeUInt32BE(manifestBytes.length);
  const plain = Buffer.concat([length, manifestBytes, ...images]);
  images.forEach(i => i.fill(0));
  if (plain.length > MAX_ARCHIVE) { plain.fill(0); fail('backup_too_large'); }
  const key = randomBytes(32), iv = randomBytes(12);
  try {
    const header = Buffer.from(JSON.stringify({ format: 1, protector: protector.kind, wrappedKey: (await protector.protect(key)).toString('base64'), iv: iv.toString('base64') }));
    const headerLength = Buffer.alloc(4); headerLength.writeUInt32BE(header.length);
    const aad = Buffer.concat([MAGIC, headerLength, header]);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad);
    const sealed = Buffer.concat([aad, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    try { writeFileSync(out, sealed, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('backup_exists'); throw error; }
  } finally { key.fill(0); plain.fill(0); }
  return { out, entries, excluded };
}

export function safeDatabaseName(name: unknown): boolean {
  return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..' &&
    !/[\/\\:*?"<>|\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && !SIDECAR.test(name) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);
}

/** Creation and restore share exactly the same portable names, sizes and case-folded uniqueness. */
export function validateBackupEntries(entries: readonly BackupEntry[]): void {
  const names = new Set<string>();
  for (const entry of entries) {
    const kind = entry.kind ?? 'sqlite';
    const validName = kind === 'artifact' ? artifactName(entry.name) : kind === 'sqlite' && (entry.name === REGISTRY || safeDatabaseName(entry.name));
    if (!validName || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_ARCHIVE || names.has(entry.name.toLowerCase())) fail('backup_path_invalid');
    names.add(entry.name.toLowerCase());
  }
  for (const name of names) {
    const parents = name.split('/'); parents.pop();
    while (parents.length) {
      if (names.has(parents.join('/'))) fail('backup_path_invalid');
      parents.pop();
    }
  }
}

/** Opens the archive; any format, key or authentication problem is the single code `backup_unreadable`. */
async function open(path: string, protector: KeyProtector): Promise<{ manifest: BackupManifest; images: Map<string, Buffer>; kinds: Map<string, string> }> {
  if (!isAbsolute(path)) fail('invalid_options');
  if (statSync(path).size > MAX_ARCHIVE + 64 * 1024) fail('backup_unreadable');
  const sealed = readFileSync(path);
  let plain: Buffer;
  try {
    if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('magic');
    const headerLength = sealed.readUInt32BE(MAGIC.length);
    const headerEnd = MAGIC.length + 4 + headerLength;
    if (headerLength > 4096 || sealed.length < headerEnd + 16) throw new Error('length');
    const header = JSON.parse(sealed.subarray(MAGIC.length + 4, headerEnd).toString('utf8')) as { format: number; protector: string; wrappedKey: string; iv: string };
    if (header.format !== 1 || header.protector !== protector.kind) throw new Error('header');
    const key = await protector.unprotect(Buffer.from(header.wrappedKey, 'base64'));
    try {
      if (key.length !== 32) throw new Error('key');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
      decipher.setAAD(sealed.subarray(0, headerEnd));
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      plain = Buffer.concat([decipher.update(sealed.subarray(headerEnd, sealed.length - 16)), decipher.final()]);
    } finally { key.fill(0); }
  } catch { fail('backup_unreadable'); }
  try {
    const manifestLength = plain.readUInt32BE(0);
    const manifest = JSON.parse(plain.subarray(4, 4 + manifestLength).toString('utf8')) as BackupManifest;
    if (manifest.format !== 1 || !Array.isArray(manifest.entries)) throw new Error('manifest');
    validateBackupEntries(manifest.entries);
    const images = new Map<string, Buffer>(), kinds = new Map<string, string>();
    let offset = 4 + manifestLength;
    for (const entry of manifest.entries) {
      kinds.set(entry.name, entry.kind ?? 'sqlite');
      const image = plain.subarray(offset, offset + entry.bytes);
      if (image.length !== entry.bytes || sha256(image) !== entry.sha256) throw new Error('digest');
      images.set(entry.name, image); offset += entry.bytes;
    }
    if (offset !== plain.length || typeof manifest.tasksDatabase !== 'string' || basename(manifest.tasksDatabase) !== manifest.tasksDatabase || !images.has(manifest.tasksDatabase) || kinds.get(manifest.tasksDatabase) !== 'sqlite') throw new Error('size');
    return { manifest, images, kinds };
  } catch { plain.fill(0); fail('backup_unreadable'); }
}

/** Integrity, schema version and profile checks plus restore fences, on an in-memory copy. Returns the image to write. */
function checkAndFence(image: Buffer, isTasks: boolean, profileId: string, fenced: RestoreFences): Buffer {
  const db = new DatabaseSync(':memory:');
  try {
    try { db.deserialize(image); } catch { fail('backup_integrity_failed'); }
    if ((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check !== 'ok') fail('backup_integrity_failed');
    const tables = tablesOf(db);
    if (isTasks) {
      const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
      if (version > SUPPORTED_TASKS_VERSION || !['events', 'responses', 'tasks'].every(t => tables.includes(t))) fail('backup_schema_unsupported');
      const foreign = db.prepare('SELECT 1 FROM tasks WHERE profile != ? UNION ALL SELECT 1 FROM events WHERE profile != ? LIMIT 1').get(profileId, profileId);
      if (foreign) fail('backup_profile_mismatch');
    }
    for (const fence of restoreFences) {
      if (tables.includes(fence.table)) fenced[fence.key] += Number(db.prepare(fence.sql).run().changes);
    }
    return Buffer.from(db.serialize());
  } finally { db.close(); }
}

/** Target is empty and owner-controlled; this is not a concurrent path-replacement boundary. */
function writeRestored(into: string, checked: Map<string, Buffer>, tasksDatabase: string, profileId: string): void {
  const written: string[] = [], directories: string[] = [];
  try {
    for (const [name, image] of checked) {
      const path = join(into, name);
      let parent = into;
      for (const part of name.split('/').slice(0, -1)) {
        parent = join(parent, part);
        if (!directories.includes(parent)) { directories.push(parent); createPrivateDirectory(parent); }
      }
      written.push(path);
      prepareDatabase(path);
      writeFileSync(path, image);
    }
    // Run the real store's migrations before reporting recovery.
    new TaskStore(join(into, tasksDatabase), profileId).close();
  } catch (error) {
    for (const path of written) for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    for (const path of directories.reverse()) rmSync(path, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreBackup(options: { backup: string; into: string; profileId: string; protector: KeyProtector }): Promise<RestoreReport> {
  const { backup, into, profileId, protector } = options;
  if (!isAbsolute(into)) fail('invalid_options');
  let existing: string[];
  try { existing = readdirSync(into); } catch { fail('restore_target_invalid'); }
  if (existing.length) fail('restore_target_not_empty');
  checkDirectoryPrivacy(into);
  const { manifest, images, kinds } = await open(backup, protector);
  if (manifest.profileId !== profileId) fail('backup_profile_mismatch');
  validateArtifactImages(images, kinds, profileId);
  const fenced: RestoreFences = { jobs: 0, leases: 0, grants: 0, reviews: 0, routines: 0, connectorGrants: 0, toolEffects: 0 };
  const checked = new Map<string, Buffer>();
  for (const [name, image] of images) checked.set(name, kinds.get(name) === 'artifact' ? image : checkAndFence(image, name === manifest.tasksDatabase, profileId, fenced));
  writeRestored(into, checked, manifest.tasksDatabase, profileId);
  return { profileId, createdAt: manifest.createdAt, files: [...checked.keys()], tasksDatabase: join(into, manifest.tasksDatabase), fenced };
}
