import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyProtector } from '../src/secrets/protector.ts';
import { withDir } from './runtime-support.ts';

// The vault refuses a directory others can read, so fixtures get an owner-only ACL (current user, SYSTEM, Administrators).
const ownerOnly = `$ErrorActionPreference='Stop'
$acl=[System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')) {
 $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
[System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]::new($env:VAULT_FIXTURE),$acl)`;

/** A disposable owner-only directory, removed afterwards. */
export function privateDir(prefix: string, fn: (dir: string) => void | Promise<void>): Promise<void> {
  return withDir(prefix, dir => {
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
    else {
      const r = spawnSync('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', ownerOnly], { env: { ...process.env, VAULT_FIXTURE: dir }, timeout: 15000, windowsHide: true });
      if (r.status !== 0) throw new Error('could not make the disposable fixture owner-only');
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
