import { isIP } from 'node:net';

/** Why a navigation target is refused; the URL itself is never echoed back. */
export type NavigationRefusal = 'invalid_url' | 'scheme_not_allowed' | 'credentials_in_url' | 'internal_target' | 'origin_not_granted';
export type NavigationCheck = { ok: true; origin: string } | { ok: false; reason: NavigationRefusal };

const internalNames = ['localhost', 'metadata', 'metadata.google.internal', 'host.docker.internal', 'gateway.docker.internal', 'kubernetes.default'];
const internalSuffixes = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.ts.net'];

function ipv4Internal(address: string): boolean {
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function ipv6Internal(address: string): boolean {
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4Internal(mapped[1]);
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped) {
    const high = parseInt(hexMapped[1], 16); const low = parseInt(hexMapped[2], 16);
    return ipv4Internal(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower) || lower.startsWith('64:ff9b:') || lower.startsWith('2001:db8');
}

/** True for loopback, private, link-local (cloud metadata), CGNAT/Tailscale, multicast and reserved addresses or names. */
export function isInternalHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return true;
  const family = isIP(host);
  if (family === 4) return ipv4Internal(host);
  if (family === 6) return ipv6Internal(host);
  return internalNames.includes(host) || internalSuffixes.some(suffix => host.endsWith(suffix)) || !host.includes('.');
}

/**
 * Admits a browser navigation only to an https/http origin that is public and explicitly granted.
 * WHATWG parsing normalizes numeric hosts (decimal, hex, octal IPv4), so they are judged as addresses.
 * Resolved addresses are checked too when the caller supplies them, which closes DNS rebinding to internal targets.
 */
export function checkNavigation(target: string, grantedOrigins: readonly string[], resolved: readonly string[] = []): NavigationCheck {
  let url: URL;
  try { url = new URL(target); } catch { return { ok: false, reason: 'invalid_url' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'scheme_not_allowed' };
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };
  if (isInternalHost(url.hostname) || resolved.some(address => isIP(address) === 0 || isInternalHost(address))) return { ok: false, reason: 'internal_target' };
  if (!grantedOrigins.includes(url.origin)) return { ok: false, reason: 'origin_not_granted' };
  return { ok: true, origin: url.origin };
}
