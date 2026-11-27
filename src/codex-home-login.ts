import { statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultAgentDir, isProxyPlaceholder, readStoredAuth } from './remote-login.ts';
import { nonnegative } from './diagnostic-metadata.ts';

export type CodexLogin = { type: 'api_key' } | { type: 'oauth'; maskedEmail?: string; expires: number };
export type CodexLogins = ReadonlyMap<string, CodexLogin | undefined>;
export const isCodexAccount = (id: string) => /^openai-codex(?:-account-\d+)?$/.test(id);

function claimField(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
}

function displayClaims(token: unknown): unknown {
  if (typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
  catch { return undefined; }
}

function maskedEmail(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 254) return undefined;
  const m = /^([a-z0-9._+\-]+)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(value);
  return m && m[0] === value ? `${m[1]!.slice(0, 3)}…@${m[2]}` : undefined;
}

function readLogins(agentDir: string): CodexLogins {
  const { raw, sidecar } = readStoredAuth(agentDir);
  const logins = new Map<string, CodexLogin | undefined>();
  for (const [id, entry] of Object.entries(raw)) {
    if (!isCodexAccount(id)) continue;
    logins.set(id, undefined);
    const accountId = entry?.type === 'api_key' ? claimField(claimField(displayClaims(entry.key), 'https://api.openai.com/auth'), 'chatgpt_account_id') : undefined;
    const proxied = (typeof accountId === 'string' && accountId.startsWith('pi-mul')) || isProxyPlaceholder(entry);
    const credential = proxied ? sidecar[id] : entry;
    if (proxied && credential?.type !== 'oauth') continue;
    if (credential?.type === 'api_key' && typeof credential.key === 'string' && credential.key.trim()) {
      logins.set(id, { type: 'api_key' });
    } else if (credential?.type === 'oauth') {
      const claims = displayClaims(credential.access), expires = credential.expires;
      if (claims && typeof claims === 'object' && !Array.isArray(claims) && nonnegative(expires) && expires <= 8.64e15) {
        const email = claimField(claimField(claims, 'https://api.openai.com/profile'), 'email');
        logins.set(id, { type: 'oauth', maskedEmail: maskedEmail(email), expires });
      }
    }
  }
  return logins;
}

function revision(path: string): string {
  try {
    const { ino, size, mtimeNs, ctimeNs } = statSync(path, { bigint: true });
    return `${ino}:${size}:${mtimeNs}:${ctimeNs}`;
  } catch { return ''; }
}

/** Only the redacted projection is retained between Home publications. */
export function codexHomeLoginReader(agentDir = defaultAgentDir()): () => CodexLogins {
  const paths = ['auth.json', 'pi-multi-account-proxy-oauth.json'].map(name => join(agentDir, name));
  let cached: { stamp: string; logins: CodexLogins } | undefined;
  return () => {
    const current = paths.map(revision).join('|');
    if (cached?.stamp !== current) cached = { stamp: current, logins: readLogins(agentDir) };
    return cached.logins;
  };
}
