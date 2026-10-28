import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from '../hash.ts';
import type { KeyProtector } from '../secrets/protector.ts';
import { TaskStore } from '../store/db.ts';
import { prepareDatabase } from '../store/privacy.ts';

/**
 * Encrypted, self-contained backups of one service data directory. Every SQLite database there except the vault is
 * snapshotted in a read transaction, packed with a manifest and sealed with AES-256-GCM under a fresh data key that the
 * OS protector (DPAPI for the current Windows user) wraps; only the wrapped key travels in the header, which is
 * authenticated as associated data. Restore decrypts and checks everything in memory, fences anything that could repeat
 * an effect or reuse an approval, and only then writes into an empty private directory.
 */
export type BackupEntry = { name: string; bytes: number; sha256: string; tables: string[] };
export type BackupManifest = { format: 1; profileId: string; createdAt: string; tasksDatabase: string; entries: BackupEntry[] };
export type BackupSummary = { out: string; entries: BackupEntry[]; excluded: { name: string; reason: 'vault' | 'not_sqlite' }[] };
export type RestoreFences = { jobs: number; leases: number; grants: number; reviews: number; routines: number; connectorGrants: number };
export type RestoreReport = { profileId: string; createdAt: string; files: string[]; tasksDatabase: string; fenced: RestoreFences };

const MAGIC = Buffer.from('OPTCHAT-ASSISTANT-BACKUP\n');
const MAX_ARCHIVE = 512 * 1024 * 1024;
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
  { key: 'leases', table: 'lease', sql: 'UPDATE lease SET expires = 0 WHERE expires != 0' },
  { key: 'grants', table: 'grants', sql: 'UPDATE grants SET revoked = 1 WHERE revoked = 0' },
  { key: 'reviews', table: 'reviews', sql: "UPDATE reviews SET state = 'revoked' WHERE state = 'pending'" },
  { key: 'routines', table: 'routines', sql: "UPDATE routines SET state = 'paused', paused_reason = 'restored', next_run = NULL WHERE state = 'active'" },
  { key: 'connectorGrants', table: 'connector_grants', sql: 'UPDATE connector_grants SET revoked = 1 WHERE revoked = 0' },
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
function snapshot(path: string): { image: Buffer; tables: string[] } {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout=5000; BEGIN');
    try {
      const tables = tablesOf(db);
      const image = Buffer.from(db.serialize());
      image[18] = 1; image[19] = 1;
      return { image, tables };
    } finally { db.exec('COMMIT'); }
  } finally { db.close(); }
}

export async function createBackup(options: { databasePath: string; profileId: string; out: string; protector: KeyProtector; now?: () => number }): Promise<BackupSummary> {
  const { databasePath, profileId, out, protector } = options;
  if (!isAbsolute(databasePath) || !isAbsolute(out) || typeof profileId !== 'string' || !profileId.trim()) fail('invalid_options');
  const dataDir = dirname(databasePath);
  const entries: BackupEntry[] = [], images: Buffer[] = [], excluded: BackupSummary['excluded'] = [];
  for (const name of readdirSync(dataDir).sort()) {
    const path = join(dataDir, name);
    if (SIDECAR.test(name) || path === out || !statSync(path).isFile()) continue;
    if (!isSqlite(path)) { excluded.push({ name, reason: 'not_sqlite' }); continue; }
    const { image, tables } = snapshot(path);
    // Vault secrets stay bound to their own store and key; they are re-entered, never carried in a backup.
    if (tables.includes('vault_key')) { image.fill(0); excluded.push({ name, reason: 'vault' }); continue; }
    entries.push({ name, bytes: image.length, sha256: sha256(image), tables });
    images.push(image);
  }
  if (!entries.some(e => e.name === basename(databasePath))) fail('backup_tasks_missing');
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

/** Opens the archive; any format, key or authentication problem is the single code `backup_unreadable`. */
async function open(path: string, protector: KeyProtector): Promise<{ manifest: BackupManifest; images: Map<string, Buffer> }> {
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
    const images = new Map<string, Buffer>();
    let offset = 4 + manifestLength;
    for (const entry of manifest.entries) {
      if (typeof entry.name !== 'string' || basename(entry.name) !== entry.name || SIDECAR.test(entry.name) || images.has(entry.name)) throw new Error('entry');
      const image = plain.subarray(offset, offset + entry.bytes);
      if (image.length !== entry.bytes || sha256(image) !== entry.sha256) throw new Error('digest');
      images.set(entry.name, image); offset += entry.bytes;
    }
    if (offset !== plain.length || !images.has(manifest.tasksDatabase)) throw new Error('size');
    return { manifest, images };
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

export async function restoreBackup(options: { backup: string; into: string; profileId: string; protector: KeyProtector }): Promise<RestoreReport> {
  const { backup, into, profileId, protector } = options;
  if (!isAbsolute(into)) fail('invalid_options');
  let existing: string[];
  try { existing = readdirSync(into); } catch { fail('restore_target_invalid'); }
  if (existing.length) fail('restore_target_not_empty');
  const { manifest, images } = await open(backup, protector);
  if (manifest.profileId !== profileId) fail('backup_profile_mismatch');
  const fenced: RestoreFences = { jobs: 0, leases: 0, grants: 0, reviews: 0, routines: 0, connectorGrants: 0 };
  const checked = new Map<string, Buffer>();
  for (const [name, image] of images) checked.set(name, checkAndFence(image, name === manifest.tasksDatabase, profileId, fenced));
  const written: string[] = [];
  try {
    for (const [name, image] of checked) {
      const path = join(into, name);
      prepareDatabase(path);
      written.push(path);
      writeFileSync(path, image);
    }
    // The real store must open the restored tasks database (running its migrations) before the restore counts.
    new TaskStore(join(into, manifest.tasksDatabase), profileId).close();
  } catch (error) {
    for (const path of written) for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(path + suffix, { force: true });
    throw error;
  }
  return { profileId, createdAt: manifest.createdAt, files: [...checked.keys()], tasksDatabase: join(into, manifest.tasksDatabase), fenced };
}
