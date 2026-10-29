import { isIP } from 'node:net';

/** Why a navigation target is refused; the URL itself is never echoed back. */
export type NavigationRefusal = 'invalid_url' | 'scheme_not_allowed' | 'credentials_in_url' | 'internal_target' | 'origin_not_granted';
export type NavigationCheck = { ok: true; origin: string } | { ok: false; reason: NavigationRefusal };

const internalNames = ['localhost', 'metadata', 'metadata.google.internal', 'host.docker.internal', 'gateway.docker.internal', 'kubernetes.default'];
const internalSuffixes = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.ts.net'];

const blockedIpv4: readonly [number, number][] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
  [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];

function ipv4Internal(address: string): boolean {
  const value = address.split('.').reduce((result, part) => (result * 256 + Number(part)) >>> 0, 0);
  return blockedIpv4.some(([prefix, bits]) => (value >>> (32 - bits)) === (prefix >>> (32 - bits)));
}

// Admit only global unicast space, excluding special-purpose blocks within it.
const blockedIpv6: readonly [bigint, number][] = [
  [0x20010000000000000000000000000000n, 23], // IETF protocol assignments, including Teredo
  [0x20010db8000000000000000000000000n, 32], // documentation
  [0x20020000000000000000000000000000n, 16], // 6to4
  [0x3fff0000000000000000000000000000n, 20], // documentation
];

function ipv6Internal(address: string): boolean {
  if (address.includes('%')) return true;
  // WHATWG serialization expands embedded IPv4 into hex and compresses equivalent spellings.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right] = normalized.split('::');
  const head = left ? left.split(':') : [];
  const tail = right ? right.split(':') : [];
  const words = right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  const value = words.reduce((result, word) => (result << 16n) | BigInt(parseInt(word, 16)), 0n);
  if ((value >> 125n) !== 1n) return true; // 2000::/3
  return blockedIpv6.some(([prefix, bits]) => (value >> BigInt(128 - bits)) === (prefix >> BigInt(128 - bits)));
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
 * Supplied resolved addresses are checked, but this predicate does not pin DNS or enforce network egress.
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
