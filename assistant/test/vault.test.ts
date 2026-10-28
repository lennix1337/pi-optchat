import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Vault, VaultError, type SecretBinding } from '../src/secrets/vault.ts';
import { osKeyProtector } from '../src/secrets/protector.ts';
import { CANARY, contains, diskBytes, memoryProtector, privateDir as withDir } from './vault-support.ts';

const bank: SecretBinding = { profileId: 'p', origin: 'https://bank.example', action: 'login' };
const code = (c: string) => (e: unknown) => e instanceof VaultError && e.code === c && !contains(String(e.stack), CANARY);

async function delivered(vault: Vault, ref: string, b = bank) {
  let got = '', kept: Buffer | undefined;
  await vault.inject(ref, b, value => { got = value.toString('utf8'); kept = value; });
  return { got, wiped: kept!.every(byte => byte === 0) };
}

test('a stored secret becomes an opaque reference: no read-back API, nothing in metadata or on disk', () => withDir('vault-', async dir => {
  const { protector, seen } = memoryProtector();
  const vault = await Vault.open({ databasePath: join(dir, 'vault.db'), protector });
  const input = Buffer.from(CANARY);
  const ref = vault.put(input, bank);
  assert.match(ref, /^sec_[A-Za-z0-9_-]{22}$/);
  assert.ok(!contains(ref, CANARY));
  const api = Object.getOwnPropertyNames(Vault.prototype).filter(n => /get|read|reveal|value|export|decrypt|peek/i.test(n));
  assert.deepEqual(api, [], 'there is no method that returns a value');
  assert.ok(!contains(JSON.stringify(vault.list('p')), CANARY));
  assert.deepEqual(vault.list('p').map(s => [s.ref, s.origin, s.action, s.revoked]), [[ref, bank.origin, 'login', false]]);
  assert.deepEqual(vault.list('other'), [], 'another profile sees nothing');
  const r = await delivered(vault, ref);
  assert.equal(r.got, CANARY); assert.ok(r.wiped, 'the injected buffer is wiped after the sink settles');
  vault.close();
  const disk = diskBytes(dir);
  assert.ok(!contains(disk, CANARY), 'the value is not on disk in any common encoding');
  assert.ok(seen.length >= 1);
  for (const key of seen) assert.ok(!contains(disk, key), 'the data key is never stored beside the data');
}));

test('a changed origin, action or profile is refused before decryption and the sink never runs', () => withDir('vault-', async dir => {
  const vault = await Vault.open({ databasePath: join(dir, 'vault.db'), protector: memoryProtector().protector });
  const ref = vault.put(Buffer.from(CANARY), bank);
  let calls = 0;
  for (const other of [
    { ...bank, origin: 'https://evil.example' }, { ...bank, origin: 'https://bank.example:444' }, { ...bank, origin: 'https://login.bank.example' },
    { ...bank, action: 'transfer' }, { ...bank, profileId: 'agent-2' },
  ]) await assert.rejects(vault.inject(ref, other, () => { calls++; }), code('binding_mismatch'));
  for (const bad of ['http://bank.example', 'https://bank.example/login', 'https://user:pw@bank.example', 'bank.example', 'javascript:alert(1)'])
    await assert.rejects(vault.inject(ref, { ...bank, origin: bad }, () => { calls++; }), code('invalid_binding'));
  assert.throws(() => vault.put(Buffer.from(CANARY), { ...bank, origin: 'https://bank.example/path' }), code('invalid_binding'));
  assert.throws(() => vault.put(Buffer.alloc(0), bank), code('invalid_secret'));
  assert.throws(() => vault.put(Buffer.alloc(8193, 1), bank), code('invalid_secret'));
  await assert.rejects(vault.inject('sec_' + 'A'.repeat(22), bank, () => { calls++; }), code('secret_unknown'));
  assert.equal(calls, 0);
  assert.equal((await delivered(vault, ref, { ...bank })).got, CANARY, 'the exact binding still works');
  await vault.inject((vault.put(Buffer.from('local'), { ...bank, origin: 'http://127.0.0.1:8080' })), { ...bank, origin: 'http://127.0.0.1:8080' }, () => {});
  vault.close();
}));

test('rotation replaces the value; revocation is final and erases the ciphertext; expired references purge', () => withDir('vault-', async dir => {
  let now = 1_000_000;
  const vault = await Vault.open({ databasePath: join(dir, 'vault.db'), protector: memoryProtector().protector, now: () => now });
  const ref = vault.put(Buffer.from(CANARY), bank);
  vault.rotate(ref, bank, Buffer.from('rotated-value'));
  assert.equal((await delivered(vault, ref)).got, 'rotated-value');
  assert.throws(() => vault.rotate(ref, { ...bank, origin: 'https://evil.example' }, Buffer.from('x')), code('binding_mismatch'));
  assert.throws(() => vault.revoke(ref, 'agent-2'), code('binding_mismatch'));
  vault.revoke(ref, 'p');
  await assert.rejects(vault.inject(ref, bank, () => {}), code('secret_revoked'));
  assert.throws(() => vault.rotate(ref, bank, Buffer.from('again')), code('secret_revoked'));
  const ephemeral = vault.put(Buffer.from('short-lived'), bank, now + 1000);
  now += 1000;
  await assert.rejects(vault.inject(ephemeral, bank, () => {}), code('secret_expired'));
  assert.throws(() => vault.put(Buffer.from('x'), bank, now), code('invalid_secret'));
  const db = new DatabaseSync(join(dir, 'vault.db'));
  assert.equal((db.prepare('SELECT length(ct) AS n FROM secrets WHERE ref = ?').get(ref) as { n: number }).n, 0, 'revoked ciphertext is erased');
  db.close();
  assert.equal(vault.purge(), 2); assert.deepEqual(vault.list('p'), [], 'revoked and expired references are gone');
  vault.close();
  assert.ok(!contains(diskBytes(dir), CANARY));
  const reopened = await Vault.open({ databasePath: join(dir, 'vault.db'), protector: memoryProtector().protector }).catch(e => e);
  assert.ok(code('vault_unavailable')(reopened), 'another keystore cannot unwrap the data key');
}));

test('tampered or transplanted ciphertext fails authentication; a sink error never carries its message out', () => withDir('vault-', async dir => {
  const { protector } = memoryProtector(), path = join(dir, 'vault.db');
  const vault = await Vault.open({ databasePath: path, protector });
  const a = vault.put(Buffer.from(CANARY), bank), b = vault.put(Buffer.from('other'), { ...bank, origin: 'https://shop.example' });
  const db = new DatabaseSync(path);
  db.prepare("UPDATE secrets SET (iv, ct, tag) = (SELECT iv, ct, tag FROM secrets WHERE ref = ?) WHERE ref = ?").run(a, b);
  await assert.rejects(vault.inject(b, { ...bank, origin: 'https://shop.example' }, () => {}), code('secret_corrupt'), 'ciphertext is bound to its reference and origin');
  db.prepare('UPDATE secrets SET ct = ? WHERE ref = ?').run(Buffer.alloc(CANARY.length, 1), a);
  await assert.rejects(vault.inject(a, bank, () => {}), code('secret_corrupt'));
  db.close();
  const c = vault.put(Buffer.from(CANARY), bank);
  const failure = await vault.inject(c, bank, value => { throw new Error(`rejected ${value.toString()}`, { cause: value.toString() }); }).catch(e => e);
  assert.ok(code('injection_failed')(failure));
  assert.equal(failure.cause, undefined); assert.ok(!contains(failure.message, CANARY));
  vault.close();
}));

test('two first openers race on one database and agree on a single data key', () => withDir('vault-', async dir => {
  const { protector } = memoryProtector(), path = join(dir, 'vault.db');
  const [a, b] = await Promise.all([Vault.open({ databasePath: path, protector }), Vault.open({ databasePath: path, protector })]);
  const ref = a.put(Buffer.from(CANARY), bank);
  assert.equal((await delivered(b, ref)).got, CANARY);
  a.close(); b.close();
}));

test('without an OS keystore the vault refuses to open instead of keeping a key beside the data', () => withDir('vault-', async dir => {
  const failure = await Vault.open({ databasePath: join(dir, 'vault.db'), protector: osKeyProtector('linux') }).catch(e => e);
  assert.ok(code('vault_unavailable')(failure));
}));

test('Windows DPAPI protects the data key for the current user across reopen', { skip: process.platform !== 'win32' }, () => withDir('vault-dpapi-', async dir => {
  const protector = osKeyProtector(), path = join(dir, 'vault.db');
  const vault = await Vault.open({ databasePath: path, protector });
  const ref = vault.put(Buffer.from(CANARY), bank);
  vault.close();
  const reopened = await Vault.open({ databasePath: path, protector: osKeyProtector() });
  assert.equal((await delivered(reopened, ref)).got, CANARY);
  reopened.close();
  assert.ok(!contains(diskBytes(dir), CANARY));
  const blob = (() => { const db = new DatabaseSync(path); const r = db.prepare('SELECT kind, blob FROM vault_key').get() as { kind: string; blob: Uint8Array }; db.close(); return r; })();
  assert.equal(blob.kind, 'dpapi-current-user');
  const key = await protector.unprotect(Buffer.from(blob.blob));
  assert.equal(key.byteLength, 32); assert.ok(!contains(diskBytes(dir), key), 'only the DPAPI blob is stored');
  key.fill(0);
}));
