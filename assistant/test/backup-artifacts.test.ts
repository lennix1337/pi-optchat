import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ArtifactRegistry } from '../src/artifacts/registry.ts';
import { createAssistantServer } from '../src/http/server.ts';
import { TaskStore } from '../src/store/db.ts';
import { createBackup, restoreBackup, safeDatabaseName, snapshotDatabase, validateBackupEntries } from '../src/ops/backup.ts';
import { artifactName, REGISTRY, validateArtifactImages } from '../src/ops/artifact-backup.ts';
import { memoryProtector, privateDir } from './vault-support.ts';
import { PROFILE, seedTask } from './ops-support.ts';

const content = Buffer.from('# private artifact content\n');
function fixture(root: string) {
  const data = join(root, 'data'), target = join(root, 'target'), source = join(root, 'source');
  mkdirSync(data); mkdirSync(target, { mode: 0o700 }); mkdirSync(source);
  const databasePath = join(data, 'tasks.sqlite'); seedTask(databasePath, 'task');
  const artifacts = join(data, 'artifacts'); mkdirSync(artifacts);
  const registryPath = join(artifacts, 'registry.sqlite');
  const registry = new ArtifactRegistry({ databasePath: registryPath, profileId: PROFILE, root: artifacts, sourceRoots: [source] });
  writeFileSync(join(source, 'result.md'), content);
  const record = registry.register({ sourcePath: join(source, 'result.md'), type: 'document', ownerId: 'owner', producerId: 'producer', provenance: 'fixture' });
  const second = Buffer.from('# version two\n'); writeFileSync(join(source, 'result.md'), second);
  const secondRecord = registry.register({ artifactId: record.artifactId, sourcePath: join(source, 'result.md'), type: 'document', ownerId: 'owner', producerId: 'producer', provenance: 'fixture2' });
  registry.close();
  const out = join(root, 'backup'), keys = memoryProtector();
  return { data, target, source, artifacts, registryPath, record, secondRecord, out, ...keys, options: { databasePath, profileId: PROFILE, out, protector: keys.protector } };
}

async function visibleRecovery(databasePath: string, registry: ArtifactRegistry, id: string) {
  const store = new TaskStore(databasePath, PROFILE), token = 'DISPOSABLE-BACKUP-TEST-TOKEN';
  const server = createAssistantServer({ store, token, profileId: PROFILE, web: true, artifacts: registry });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const login = await fetch(base + '/web/session', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal(login.status, 200);
    const { csrf } = await login.json() as { csrf: string };
    const headers = { origin: base, cookie: login.headers.get('set-cookie')!.split(';')[0], 'x-assistant-csrf': csrf, 'content-type': 'application/json' };
    const version = `/web/api/artifacts/${id}/versions/1`;
    const issued = await fetch(base + version + '/preview', { method: 'POST', headers, body: '{}' });
    assert.equal(issued.status, 200);
    const { url } = await issued.json() as { url: string };
    for (const path of [url, version + '/download']) {
      const response = await fetch(base + path, { headers }); assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); }
}

test('encrypted backup restores all artifact versions and real HTTP preview/download', () => privateDir('backup-artifacts-', async root => {
  const f = fixture(root);
  writeFileSync(join(f.artifacts, 'unregistered-secret.txt'), 'not an artifact');
  const summary = await createBackup(f.options);
  assert.equal(summary.entries.filter(entry => entry.kind === 'artifact').length, 2);
  assert.equal(summary.entries.some(entry => entry.name.includes('unregistered-secret')), false);
  assert.equal(readFileSync(f.out).includes(content), false);
  await restoreBackup({ backup: f.out, into: f.target, profileId: PROFILE, protector: f.protector });
  const restored = new ArtifactRegistry({ databasePath: join(f.target, REGISTRY), profileId: PROFILE, root: join(f.target, 'artifacts'), sourceRoots: [f.source] });
  try {
    assert.equal(restored.versions(f.record.artifactId).length, 2);
    assert.deepEqual(restored.read(f.record.artifactId, 1).bytes, content);
    await visibleRecovery(join(f.target, 'tasks.sqlite'), restored, f.record.artifactId);
  } finally { restored.close(); }
  const foreign = new ArtifactRegistry({ databasePath: join(f.target, REGISTRY), profileId: 'foreign', root: join(f.target, 'artifacts'), sourceRoots: [f.source] });
  try { assert.throws(() => foreign.read(f.record.artifactId, 1), /artifact_not_found/); } finally { foreign.close(); }
}));

test('backup refuses missing/changed bytes, foreign registry profiles and linked directories/files', () => privateDir('backup-artifact-guards-', async root => {
  const cases = ['changed', 'missing', 'foreign', 'junction', 'hardlink', 'registry-link', 'reserved-artifact'];
  for (const name of cases) {
    const home = join(root, name); mkdirSync(home); const f = fixture(home);
    const path = join(f.artifacts, f.record.location);
    if (name === 'changed') writeFileSync(path, Buffer.alloc(content.length, 32));
    if (name === 'missing') renameSync(path, path + '.missing');
    if (name === 'foreign') { const db = new DatabaseSync(f.registryPath); db.exec("UPDATE artifacts SET profile = 'foreign'"); db.close(); }
    if (name === 'junction') { renameSync(f.artifacts, join(home, 'elsewhere')); symlinkSync(join(home, 'elsewhere'), f.artifacts, process.platform === 'win32' ? 'junction' : 'dir'); }
    if (name === 'hardlink') linkSync(path, join(home, 'hardlink'));
    if (name === 'registry-link') linkSync(f.registryPath, join(home, 'registry-hardlink'));
    if (name === 'reserved-artifact') {
      const db = new DatabaseSync(f.registryPath);
      const invalid = { ...f.record, location: `${f.record.artifactId}/v1/CON.md` };
      // Represents an existing entry from a platform that permits this filename. No Windows device is opened.
      const { fileName, size, createdAt, reviewedBy, reviewedAt, ...artifact } = invalid;
      db.prepare('UPDATE artifacts SET artifact = ?, file_name = ? WHERE version = 1').run(JSON.stringify(artifact), 'CON.md'); db.close();
    }
    const expected = name === 'junction' ? /backup_path_invalid/ : name === 'foreign' ? /backup_profile_mismatch/ : name === 'missing' ? /ENOENT/ : /backup_artifacts_invalid/;
    await assert.rejects(createBackup(f.options), expected, name);
    assert.equal(readdirSync(home).includes('backup'), false, name);
  }
}));

test('restore refuses a junction target before unwrapping the private archive', () => privateDir('backup-artifact-target-', async root => {
  const f = fixture(root); await createBackup(f.options);
  const link = join(root, 'linked-target'); symlinkSync(f.target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const before = f.seen.length;
  await assert.rejects(restoreBackup({ backup: f.out, into: link, profileId: PROFILE, protector: f.protector }), /Privacy requires/);
  assert.equal(f.seen.length, before); assert.deepEqual(readdirSync(f.target), []);
}));

test('archive pairing rejects missing, unexpected, wrong-kind and digest-mismatched managed files', () => privateDir('backup-artifact-pairing-', async root => {
  const f = fixture(root); const db = new DatabaseSync(f.registryPath);
  const image = Buffer.from(db.serialize()); db.close();
  const name = `artifacts/${f.record.location}`;
  assert.throws(() => validateArtifactImages(new Map([[REGISTRY, image]]), new Map([[REGISTRY, 'sqlite']]), PROFILE), /backup_artifacts_invalid/);
  assert.throws(() => validateArtifactImages(new Map([[name, content]]), new Map([[name, 'artifact']]), PROFILE), /backup_artifacts_invalid/);
  const second = `artifacts/${f.secondRecord.location}`;
  const bytes = new Map([[REGISTRY, image], [name, content], [second, readFileSync(join(f.artifacts, f.secondRecord.location))]]);
  const kinds = new Map([[REGISTRY, 'sqlite'], [name, 'artifact'], [second, 'artifact']]);
  validateArtifactImages(bytes, kinds, PROFILE);
  bytes.set(name, Buffer.alloc(content.length, 32));
  assert.throws(() => validateArtifactImages(bytes, kinds, PROFILE), /backup_artifacts_invalid/);
  bytes.set(name, content); kinds.set(name, 'sqlite');
  assert.throws(() => validateArtifactImages(bytes, kinds, PROFILE), /backup_artifacts_invalid/);
  const valid = `artifacts/${f.record.artifactId}/v1/result.md`;
  assert.equal(artifactName(valid), true);
  for (const bad of [valid.replace('v1/', '../'), valid.replace('/result.md', '/CON.md'), valid + ' ', valid.replace('/v1/', '\\v1\\'), valid.replace('result.md', 'result.md:stream'), valid.replace('result.md', '../result.md')]) assert.equal(artifactName(bad), false, bad);
}));

test('logical WAL-backed snapshots refuse their budget before serialization for tasks and registry', () => privateDir('backup-wal-budget-', async root => {
  for (const table of ['tasks', 'artifacts']) {
    const path = join(root, `${table}.sqlite`), writer = new DatabaseSync(path);
    try {
      writer.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ${table} (payload BLOB); INSERT INTO ${table} VALUES (zeroblob(32768))`);
      assert.ok(statSync(path).size < 8192, 'main file alone misses committed WAL pages');
      let calls = 0; const original = DatabaseSync.prototype.serialize;
      DatabaseSync.prototype.serialize = function (...args: Parameters<typeof original>) { calls++; return original.apply(this, args); };
      try { assert.throws(() => snapshotDatabase(path, 8192), /backup_too_large/); assert.equal(calls, 0); }
      finally { DatabaseSync.prototype.serialize = original; }
    } finally { writer.close(); }
  }
}));

test('portable database names preserve safe legacy spaces and reject aliases and device names', () => {
  for (const name of ['tasks.sqlite', 'base pessoal.sqlite', 'memória.sqlite']) assert.equal(safeDatabaseName(name), true, name);
  for (const name of ['../escape', 'foo:bar', 'CON.md', 'NUL', 'name.', 'name ', 'foo\\\\bar', 'x-wal', '..', '', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) assert.equal(safeDatabaseName(name), false, name);
});

test('archive creation and reading share case-folded uniqueness and portable name admission', () => {
  const entry = { name: 'tasks.sqlite', bytes: 4096, sha256: '0'.repeat(64), tables: [] };
  validateBackupEntries([entry]);
  assert.throws(() => validateBackupEntries([entry, { ...entry, name: 'TASKS.sqlite' }]), /backup_path_invalid/);
  assert.throws(() => validateBackupEntries([{ ...entry, name: 'bad|name.sqlite' }]), /backup_path_invalid/);
  for (const entries of [
    [{ ...entry, name: 'ARTIFACTS' }, { ...entry, name: REGISTRY }],
    [{ ...entry, name: REGISTRY }, { ...entry, name: 'ARTIFACTS' }],
  ]) assert.throws(() => validateBackupEntries(entries), /backup_path_invalid/);
});

test('case-colliding SQLite files cannot produce a successful unrestorable archive', { skip: process.platform === 'win32' ? 'Windows fixture filesystem is case-insensitive; shared admission is tested above' : false }, () => privateDir('backup-case-collision-', async root => {
  const f = fixture(root), db = new DatabaseSync(join(f.data, 'TASKS.sqlite')); db.exec('CREATE TABLE data (id)'); db.close();
  await assert.rejects(createBackup(f.options), /backup_path_invalid/);
  assert.equal(readdirSync(root).includes('backup'), false);
}));

test('creation refuses an existing SQLite filename that restoration cannot safely address', { skip: process.platform === 'win32' ? 'Windows does not expose colon filenames as regular directory entries' : false }, () => privateDir('backup-nonportable-', async root => {
  const f = fixture(root), db = new DatabaseSync(join(f.data, 'unsafe:name.sqlite')); db.exec('CREATE TABLE data (id)'); db.close();
  await assert.rejects(createBackup(f.options), /backup_path_invalid/);
  assert.equal(readdirSync(root).includes('backup'), false);
}));

/** Re-seal an authenticated test archive to probe post-decryption validation, not only the GCM layer. */
function mutatedArchive(bytes: Buffer, key: Buffer, mutate: (manifest: any) => void): Buffer {
  const headerStart = Buffer.byteLength('OPTCHAT-ASSISTANT-BACKUP\n') + 4;
  const headerEnd = headerStart + bytes.readUInt32BE(headerStart - 4), aad = bytes.subarray(0, headerEnd);
  const header = JSON.parse(bytes.subarray(headerStart, headerEnd).toString());
  const decrypt = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decrypt.setAAD(aad); decrypt.setAuthTag(bytes.subarray(-16));
  const plain = Buffer.concat([decrypt.update(bytes.subarray(headerEnd, -16)), decrypt.final()]);
  const n = plain.readUInt32BE(0), manifest = JSON.parse(plain.subarray(4, 4 + n).toString());
  mutate(manifest); const metadata = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
  const next = Buffer.concat([length, metadata, plain.subarray(4 + n)]);
  const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64')); cipher.setAAD(aad);
  return Buffer.concat([aad, cipher.update(next), cipher.final(), cipher.getAuthTag()]);
}

test('authenticated malformed artifact paths/kinds/lengths refuse before writing any restored file', () => privateDir('backup-artifact-archive-', async root => {
  const f = fixture(root); await createBackup(f.options); const original = readFileSync(f.out);
  const mutations = [
    (m: any) => { m.entries.find((e: any) => e.kind === 'artifact').name = '../escape'; },
    (m: any) => { m.entries.find((e: any) => e.kind === 'artifact').kind = 'sqlite'; },
    (m: any) => { m.entries.find((e: any) => e.kind === 'artifact').bytes = -1; },
    (m: any) => { m.entries.find((e: any) => e.kind === 'artifact').sha256 = '0'.repeat(64); },
    (m: any) => { m.tasksDatabase = REGISTRY; },
  ];
  for (const mutate of mutations) {
    writeFileSync(f.out, mutatedArchive(original, f.seen[0], mutate));
    await assert.rejects(restoreBackup({ backup: f.out, into: f.target, profileId: PROFILE, protector: f.protector }), /backup_unreadable/);
    assert.deepEqual(readdirSync(f.target), []);
  }
}));
