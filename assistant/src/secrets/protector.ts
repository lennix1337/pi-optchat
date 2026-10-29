import { spawn } from 'node:child_process';
import { VaultError } from './errors.ts';

/** Wraps the vault's data key with a key the operating system holds for the current user. */
export interface KeyProtector {
  readonly kind: string;
  protect(key: Buffer): Promise<Buffer>;
  unprotect(blob: Buffer): Promise<Buffer>;
}

// DPAPI (CurrentUser): only this Windows account on this machine can unwrap. Data travels on stdin, never argv.
const dpapiScript = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$i=[Console]::In.ReadToEnd().Trim().Split(' ')
$d=[Convert]::FromBase64String($i[1])
$s=[Security.Cryptography.DataProtectionScope]::CurrentUser
$o=if($i[0] -eq 'protect'){[Security.Cryptography.ProtectedData]::Protect($d,$null,$s)}else{[Security.Cryptography.ProtectedData]::Unprotect($d,$null,$s)}
[Console]::Out.Write([Convert]::ToBase64String($o))`;
const encoded = Buffer.from(dpapiScript, 'utf16le').toString('base64');
// One call takes ~0.2 s idle but 7-8 s on a loaded Windows runner and over 15 s at its tail; it runs once per vault open, at
// service startup, so a stuck PowerShell is cut off only well past a slow start.
const DPAPI_TIMEOUT_MS = 60_000;

function dpapi(op: 'protect' | 'unprotect', data: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), DPAPI_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => { clearTimeout(timer); reject(new VaultError('vault_unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks).toString('utf8').trim();
      chunks.forEach(c => c.fill(0));
      if (code !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(out)) { reject(new VaultError('vault_unavailable')); return; }
      resolve(Buffer.from(out, 'base64'));
    });
    child.stdin.end(`${op} ${data.toString('base64')}`);
  });
}

const unavailable: KeyProtector = {
  kind: 'unavailable',
  protect: () => Promise.reject(new VaultError('vault_unavailable')),
  unprotect: () => Promise.reject(new VaultError('vault_unavailable')),
};

/**
 * The OS key protector for this platform. Windows uses DPAPI (current user). Other platforms have no
 * dependency-free OS keystore here, so the vault refuses to open rather than store a key beside the data.
 */
export function osKeyProtector(platform: NodeJS.Platform = process.platform): KeyProtector {
  if (platform !== 'win32') return unavailable;
  return { kind: 'dpapi-current-user', protect: key => dpapi('protect', key), unprotect: blob => dpapi('unprotect', blob) };
}
