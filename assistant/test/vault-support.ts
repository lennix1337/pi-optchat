import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyProtector } from '../src/secrets/protector.ts';
import { withDir } from './runtime-support.ts';

// The vault refuses a directory others can read, so fixtures get an owner-only ACL (current user, SYSTEM, Administrators).
const system32 = (tool: string) => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', tool);
let currentSid: string | undefined;
function ownerOnly(dir: string): void {
  if (!currentSid) {
    const who = spawnSync(system32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    currentSid = /"(S-1-\d+(?:-\d+)+)"\s*$/.exec(String(who.stdout ?? '').trim())?.[1];
    if (!currentSid) throw new Error(`could not read the current user SID: ${who.error?.message ?? `status ${who.status}`}`);
  }
  const grants = [currentSid, 'S-1-5-18', 'S-1-5-32-544'].map(sid => `*${sid}:(OI)(CI)F`);
  const r = spawnSync(system32('icacls.exe'), [dir, '/inheritance:r', '/grant:r', ...grants], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  if (r.status !== 0) throw new Error(`could not make the disposable fixture owner-only: ${r.error?.message ?? `status ${r.status} signal ${r.signal}`} ${String(r.stdout ?? '').trim().slice(0, 300)}`);
}

/** A disposable owner-only directory, removed afterwards. */
export function privateDir(prefix: string, fn: (dir: string) => void | Promise<void>): Promise<void> {
  return withDir(prefix, dir => {
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
    else {
      ownerOnly(dir);
    }
    return fn(dir);
  });
}

export const CANARY = 'CANARY-7f3e-vault-secret-do-not-leak';

/** A stand-in for the OS keystore: wraps with an in-memory key and records every data key it saw. */
export function memoryProtector(kind = 'test-memory') {
  const kek = randomBytes(32), seen: Buffer[] = [];
  const protector: KeyProtector = {
    kind,
    async protect(key) {
      seen.push(Buffer.from(key));
      const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', kek, iv);
      return Buffer.concat([iv, c.update(key), c.final(), c.getAuthTag()]);
    },
    async unprotect(blob) {
      const d = createDecipheriv('aes-256-gcm', kek, blob.subarray(0, 12));
      d.setAuthTag(blob.subarray(blob.length - 16));
      const key = Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
      seen.push(Buffer.from(key));
      return key;
    },
  };
  return { protector, seen };
}

/** Every byte the vault left on disk in `dir` (database, journal, WAL). */
export function diskBytes(dir: string): Buffer {
  return Buffer.concat(readdirSync(dir).map(name => readFileSync(join(dir, name))));
}

/** True when `needle` appears in `haystack` as UTF-8, UTF-16LE, hex or base64. */
export function contains(haystack: Buffer | string, needle: Buffer | string): boolean {
  const n = Buffer.isBuffer(needle) ? needle : Buffer.from(needle);
  const forms = [n, Buffer.from(n.toString('utf8'), 'utf16le'), Buffer.from(n.toString('hex')), Buffer.from(n.toString('base64').replace(/=+$/, ''))];
  const h = Buffer.isBuffer(haystack) ? haystack : Buffer.from(haystack);
  return forms.some(f => h.includes(f));
}
