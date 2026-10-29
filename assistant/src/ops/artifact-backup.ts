import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArtifact } from '../contracts/artifacts.ts';
import { sha256 } from '../hash.ts';

export const REGISTRY = 'artifacts/registry.sqlite';
export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
export type BackupImage = { name: string; image: Buffer; tables: string[]; kind?: 'artifact' };
const fail = (): never => { throw new Error('backup_artifacts_invalid'); };
const folded = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;

/** Archive paths are portable: Windows separators, ADS, traversal and case aliases are not admitted. */
export function artifactName(name: string): boolean {
  return typeof name === 'string' && /^artifacts\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/v[1-9][0-9]*\/[\p{L}\p{N}][\p{L}\p{N}._ -]{0,119}$/u.test(name) &&
    !/[. ]$/.test(name) && !/\/(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);
}

/** Read only registered versions from the immutable registry snapshot, never arbitrary files in the directory. */
function references(image: Buffer, profileId: string): Map<string, { hash: string; size: number }> {
  const db = new DatabaseSync(':memory:');
  try {
    db.deserialize(image);
    if ((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check !== 'ok') fail();
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    if (tables.length !== 1 || tables[0].name !== 'artifacts') fail();
    const refs = new Map<string, { hash: string; size: number }>();
    const statement = db.prepare('SELECT profile, artifact_id, version, artifact, file_name, size FROM artifacts');
    let total = 0;
    for (const row of statement.iterate()) {
      const artifact = parseArtifact(JSON.parse(String(row.artifact)));
      const name = `artifacts/${artifact.location}`;
      if (row.profile !== profileId || artifact.profileId !== profileId) throw new Error('backup_profile_mismatch');
      if (artifact.artifactId !== row.artifact_id || artifact.artifactVersion !== row.version ||
          artifact.location !== `${row.artifact_id}/v${row.version}/${row.file_name}` || !artifactName(name) || refs.has(name) ||
          !Number.isSafeInteger(row.size) || Number(row.size) < 0 || Number(row.size) > 16 * 1024 * 1024) fail();
      total += Number(row.size);
      if (total > MAX_BACKUP_BYTES) throw new Error('backup_too_large');
      refs.set(name, { hash: artifact.hash, size: Number(row.size) });
    }
    return refs;
  } finally { db.close(); }
}

/** Every ancestor is literal, not a symlink/junction; the opened regular file also has only one hard link. */
function literalFile(root: string, name: string): string {
  let path = root;
  const parts = name.split('/');
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index]);
    const info = lstatSync(path);
    if (info.isSymbolicLink() || folded(realpathSync(path)) !== folded(resolve(path))) fail();
    if (index < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1 || info.size > MAX_BACKUP_BYTES) fail();
  }
  return path;
}

export function collectArtifacts(dataDir: string, profileId: string, snapshot: (path: string) => { image: Buffer; tables: string[] }, budget = MAX_BACKUP_BYTES): BackupImage[] {
  if (!existsSync(join(dataDir, 'artifacts'))) return [];
  const registryPath = literalFile(dataDir, REGISTRY);
  const registry = snapshot(registryPath);
  const refs = references(registry.image, profileId);
  if (registry.image.length + [...refs.values()].reduce((sum, ref) => sum + ref.size, 0) > budget) throw new Error('backup_too_large');
  const files: BackupImage[] = [{ name: REGISTRY, ...registry }];
  for (const [name, ref] of refs) {
    const path = literalFile(dataDir, name);
    const fd = openSync(path, constants.O_RDONLY);
    let image: Buffer;
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || info.size !== ref.size) fail();
      image = readFileSync(fd);
    } finally { closeSync(fd); }
    if (image.length !== ref.size || sha256(image) !== ref.hash) fail();
    files.push({ name, image, tables: [], kind: 'artifact' });
  }
  return files;
}

/** Validate the complete registry/content pairing before restore writes any file. */
export function validateArtifactImages(images: Map<string, Buffer>, kinds: Map<string, string>, profileId: string): void {
  const registry = images.get(REGISTRY);
  const files = [...kinds].filter(([, kind]) => kind === 'artifact').map(([name]) => name);
  if (!registry) { if (files.length) fail(); return; }
  const refs = references(registry, profileId);
  if (refs.size !== files.length) fail();
  for (const [name, ref] of refs) {
    const bytes = images.get(name);
    if (!bytes || kinds.get(name) !== 'artifact' || bytes.length !== ref.size || sha256(bytes) !== ref.hash) fail();
  }
}
