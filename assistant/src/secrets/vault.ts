import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { prepareDatabase } from '../store/privacy.ts';
import { VaultError } from './errors.ts';
import type { KeyProtector } from './protector.ts';
export { VaultError, type VaultErrorCode } from './errors.ts';

/** Who may use a secret: one profile, one exact web origin, one named action. Anything else is refused before decryption. */
export type SecretBinding = { profileId: string; origin: string; action: string };
export type SecretInfo = { ref: string; origin: string; action: string; createdAt: number; rotatedAt: number | null; expiresAt: number | null; revoked: boolean };
export type VaultOptions = { databasePath: string; protector: KeyProtector; now?: () => number };
type Row = { ref: string; profile: string; origin: string; action: string; iv: Uint8Array; ct: Uint8Array; tag: Uint8Array; created: number; rotated: number | null; expires: number | null; revoked: number };

const MAX_SECRET_BYTES = 8192;
const REF = /^sec_[A-Za-z0-9_-]{22}$/;

function binding(input: SecretBinding): SecretBinding {
  const { profileId, origin, action } = input ?? {} as SecretBinding;
  if (typeof profileId !== 'string' || !profileId.trim() || profileId.length > 128) throw new VaultError('invalid_binding');
  if (typeof action !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(action)) throw new VaultError('invalid_binding');
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new VaultError('invalid_binding'); }
  const local = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  // Only an exact, already-normalized origin binds: no path, credentials or plain-http remote host.
  if ((parsed.protocol !== 'https:' && !local) || parsed.origin !== origin) throw new VaultError('invalid_binding');
  return { profileId, origin, action };
}

function secretBytes(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_SECRET_BYTES) throw new VaultError('invalid_secret');
  return Buffer.from(value);
}

const aad = (ref: string, b: SecretBinding) => Buffer.from(JSON.stringify(['optchat-vault-v1', ref, b.profileId, b.origin, b.action]));

/**
 * Encrypted secrets that can be stored and injected, never read back. Values are AES-256-GCM sealed with a data key the
 * OS protector wraps; the reference is random and the ciphertext is bound to its profile, origin and action.
 */
export class Vault {
  private readonly db: DatabaseSync;
  private key: Buffer;
  private readonly now: () => number;
  private constructor(db: DatabaseSync, key: Buffer, now: () => number) { this.db = db; this.key = key; this.now = now; }

  static async open(options: VaultOptions): Promise<Vault> {
    if (!options?.protector || typeof options.databasePath !== 'string') throw new VaultError('vault_unavailable');
    prepareDatabase(options.databasePath);
    const db = new DatabaseSync(options.databasePath);
    try {
      // secure_delete zeroes freed pages, so rotated or revoked ciphertext does not linger in the file.
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS vault_key (id INTEGER PRIMARY KEY CHECK (id = 1), kind TEXT NOT NULL, blob BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS secrets (ref TEXT PRIMARY KEY, profile TEXT NOT NULL, origin TEXT NOT NULL, action TEXT NOT NULL,
          iv BLOB NOT NULL, ct BLOB NOT NULL, tag BLOB NOT NULL, created INTEGER NOT NULL, rotated INTEGER, expires INTEGER, revoked INTEGER NOT NULL DEFAULT 0);`);
      const key = await Vault.dataKey(db, options.protector);
      return new Vault(db, key, options.now ?? Date.now);
    } catch (error) {
      db.close();
      throw error instanceof VaultError ? error : new VaultError('vault_unavailable');
    }
  }

  private static async dataKey(db: DatabaseSync, protector: KeyProtector): Promise<Buffer> {
    const stored = () => db.prepare('SELECT kind, blob FROM vault_key WHERE id = 1').get() as { kind: string; blob: Uint8Array } | undefined;
    let row = stored();
    if (!row) {
      const fresh = randomBytes(32);
      const blob = await protector.protect(fresh);
      // A second opener may have written its key first; the first committed key wins and this one is discarded.
      db.prepare('INSERT OR IGNORE INTO vault_key (id, kind, blob) VALUES (1, ?, ?)').run(protector.kind, blob);
      fresh.fill(0);
      row = stored()!;
    }
    if (row.kind !== protector.kind) throw new VaultError('vault_unavailable');
    let key: Buffer;
    try { key = await protector.unprotect(Buffer.from(row.blob)); } catch { throw new VaultError('vault_unavailable'); }
    if (key.byteLength !== 32) { key.fill(0); throw new VaultError('vault_unavailable'); }
    return key;
  }

  private seal(ref: string, b: SecretBinding, value: Buffer) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.live(), iv);
    cipher.setAAD(aad(ref, b));
    const ct = Buffer.concat([cipher.update(value), cipher.final()]);
    return { iv, ct, tag: cipher.getAuthTag() };
  }

  private live(): Buffer { if (!this.key.byteLength) throw new VaultError('vault_unavailable'); return this.key; }

  private row(ref: string): Row {
    if (typeof ref !== 'string' || !REF.test(ref)) throw new VaultError('secret_unknown');
    const row = this.db.prepare('SELECT * FROM secrets WHERE ref = ?').get(ref) as Row | undefined;
    if (!row) throw new VaultError('secret_unknown');
    return row;
  }

  /** Stores a copy of `value` and returns an opaque reference. The caller should wipe its own buffer. */
  put(value: Uint8Array, bindingInput: SecretBinding, expiresAt?: number): string {
    const b = binding(bindingInput), bytes = secretBytes(value);
    if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= this.now())) { bytes.fill(0); throw new VaultError('invalid_secret'); }
    const ref = `sec_${randomBytes(16).toString('base64url')}`;
    try {
      const { iv, ct, tag } = this.seal(ref, b, bytes);
      this.db.prepare('INSERT INTO secrets (ref, profile, origin, action, iv, ct, tag, created, expires) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ref, b.profileId, b.origin, b.action, iv, ct, tag, this.now(), expiresAt ?? null);
    } finally { bytes.fill(0); }
    return ref;
  }

  /** Metadata only: there is deliberately no way to read a value back. */
  list(profileId: string): SecretInfo[] {
    return (this.db.prepare('SELECT ref, origin, action, created, rotated, expires, revoked FROM secrets WHERE profile = ? ORDER BY created, ref').all(profileId) as Row[])
      .map(r => ({ ref: r.ref, origin: r.origin, action: r.action, createdAt: r.created, rotatedAt: r.rotated, expiresAt: r.expires, revoked: r.revoked === 1 }));
  }

  /**
   * Decrypts the secret only for the exact binding it was stored with and hands it to `sink`, the consented destination.
   * The buffer is wiped when the sink settles; a sink failure surfaces as `injection_failed` without its message.
   */
  async inject(ref: string, bindingInput: SecretBinding, sink: (value: Buffer) => void | Promise<void>): Promise<void> {
    const b = binding(bindingInput), row = this.row(ref);
    if (row.profile !== b.profileId || row.origin !== b.origin || row.action !== b.action) throw new VaultError('binding_mismatch');
    if (row.revoked) throw new VaultError('secret_revoked');
    if (row.expires !== null && row.expires <= this.now()) throw new VaultError('secret_expired');
    let value: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.live(), row.iv);
      decipher.setAAD(aad(ref, b));
      decipher.setAuthTag(row.tag);
      value = Buffer.concat([decipher.update(row.ct), decipher.final()]);
    } catch { throw new VaultError('secret_corrupt'); }
    try { await sink(value); }
    catch { throw new VaultError('injection_failed'); }
    finally { value.fill(0); }
  }

  /** Replaces the value behind `ref`; the old ciphertext is overwritten. */
  rotate(ref: string, bindingInput: SecretBinding, value: Uint8Array): void {
    const b = binding(bindingInput), bytes = secretBytes(value), row = this.row(ref);
    try {
      if (row.profile !== b.profileId || row.origin !== b.origin || row.action !== b.action) throw new VaultError('binding_mismatch');
      if (row.revoked) throw new VaultError('secret_revoked');
      const { iv, ct, tag } = this.seal(ref, b, bytes);
      this.db.prepare('UPDATE secrets SET iv = ?, ct = ?, tag = ?, rotated = ? WHERE ref = ? AND revoked = 0').run(iv, ct, tag, this.now(), ref);
    } finally { bytes.fill(0); }
  }

  /** Revocation is final and erases the ciphertext; the reference stays listed as revoked. */
  revoke(ref: string, profileId: string): void {
    const row = this.row(ref);
    if (row.profile !== profileId) throw new VaultError('binding_mismatch');
    this.db.prepare("UPDATE secrets SET revoked = 1, iv = x'', ct = x'', tag = x'' WHERE ref = ?").run(ref);
  }

  /** Deletes revoked and expired entries (ephemeral references included). Returns how many were removed. */
  purge(): number {
    return Number(this.db.prepare('DELETE FROM secrets WHERE revoked = 1 OR (expires IS NOT NULL AND expires <= ?)').run(this.now()).changes);
  }

  close(): void { this.key.fill(0); this.key = Buffer.alloc(0); this.db.close(); }
}
