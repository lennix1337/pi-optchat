import { localEnvironment, type Environment } from '../environment/local.ts';
import { VaultError } from './errors.ts';

/** Wraps the vault's data key with a key the operating system holds for the current user. */
export interface KeyProtector {
  readonly kind: string;
  protect(key: Buffer): Promise<Buffer>;
  unprotect(blob: Buffer): Promise<Buffer>;
}

/** DPAPI through the environment port (the `dpapi` action): the script and its timeout are the port's, data travels on stdin. */
async function dpapi(environment: Environment, op: 'protect' | 'unprotect', data: Buffer): Promise<Buffer> {
  let result: { code: number; stdout: string };
  try { result = await environment.run({ action: 'dpapi', op, data: data.toString('base64') }); }
  catch { throw new VaultError('vault_unavailable'); }
  const out = result.stdout.trim();
  if (result.code !== 0 || !/^[A-Za-z0-9+/]+=*$/.test(out)) throw new VaultError('vault_unavailable');
  return Buffer.from(out, 'base64');
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
export function osKeyProtector(platform: NodeJS.Platform = process.platform, environment: Environment = localEnvironment): KeyProtector {
  if (platform !== 'win32') return unavailable;
  return { kind: 'dpapi-current-user', protect: key => dpapi(environment, 'protect', key), unprotect: blob => dpapi(environment, 'unprotect', blob) };
}
