export type VaultErrorCode = 'vault_unavailable' | 'invalid_secret' | 'invalid_binding' | 'secret_unknown' | 'secret_revoked'
  | 'secret_expired' | 'binding_mismatch' | 'secret_corrupt' | 'injection_failed';

/** Vault errors carry only a code: never a value, a cause or a sink's message, which could echo the secret. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode) { super(code); this.name = 'VaultError'; this.code = code; }
}
