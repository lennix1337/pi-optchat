import { lookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { checkNavigation } from './network.ts';

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export type BrowserRead = { id: number; url: string; method: string; headers: Record<string, string> };
export type BrowserReply = { id: number; status: number; headers: Record<string, string>; body: string };
export type Resolver = (host: string) => Promise<readonly string[]>;
type Policy = { origins: readonly string[]; admit: () => void; resolve?: Resolver };
const safeHeaders = new Set(['accept', 'accept-language', 'user-agent', 'range', 'if-none-match', 'if-modified-since']);
const responseHeaders = new Set(['content-type', 'content-language', 'location', 'etag', 'last-modified', 'content-security-policy', 'x-content-type-options']);

export function normalizeOrigins(origins: readonly string[]): string[] {
  if (!Array.isArray(origins) || !origins.length || origins.length > 16) throw new Error('egress_invalid_origins');
  return [...new Set(origins.map(origin => {
    if (typeof origin !== 'string') throw new Error('egress_invalid_origins');
    const check = checkNavigation(origin, [origin]);
    if (!check.ok || new URL(origin).protocol !== 'https:' || new URL(origin).port || isIP(new URL(origin).hostname.replace(/^\[|\]$/g, '')) || check.origin !== origin) throw new Error('egress_invalid_origins');
    return origin;
  }))];
}

/** Strictly validate the untrusted container message before any DNS or socket activity. */
export function validateRead(value: unknown, origins: readonly string[]): BrowserRead {
  if (!value || typeof value !== 'object') throw new Error('egress_invalid_request');
  const r = value as BrowserRead;
  if (!Number.isSafeInteger(r.id) || r.id < 1 || typeof r.url !== 'string' || r.url.length > 8192 || !['GET', 'HEAD'].includes(r.method)) throw new Error('egress_invalid_request');
  const check = checkNavigation(r.url, origins);
  if (!check.ok) throw new Error(`egress_${check.reason}`);
  const url = new URL(r.url);
  if (url.protocol !== 'https:' || url.port || url.hash) throw new Error('egress_https_only');
  if (!r.headers || typeof r.headers !== 'object' || Array.isArray(r.headers) || Object.keys(r.headers).length > 16) throw new Error('egress_invalid_headers');
  for (const [name, value] of Object.entries(r.headers)) {
    if (!safeHeaders.has(name) || typeof value !== 'string' || value.length > 4096 || /[\r\n\0]/.test(value)) throw new Error('egress_invalid_headers');
  }
  return { id: r.id, url: url.href, method: r.method, headers: { ...r.headers } };
}

const publicResolver: Resolver = async host => (await lookup(host, { all: true, verbatim: true })).map(answer => answer.address);

/** One pinned, fresh TLS socket; DNS is never resolved again by the HTTP client. */
export async function prepareRead(value: unknown, policy: Policy): Promise<{ read: BrowserRead; options: RequestOptions }> {
  policy.admit();
  const read = validateRead(value, policy.origins);
  const url = new URL(read.url);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : await (policy.resolve ?? publicResolver)(host);
  policy.admit();
  if (!addresses.length) throw new Error('egress_unresolved');
  const check = checkNavigation(read.url, policy.origins, addresses);
  if (!check.ok) throw new Error(`egress_${check.reason}`);
  const address = addresses[0]!;
  return { read, options: {
    protocol: 'https:', hostname: host, port: 443, path: url.pathname + url.search, method: read.method,
    headers: { ...read.headers, host: url.host, 'accept-encoding': 'identity', connection: 'close' },
    servername: isIP(host) ? undefined : host, rejectUnauthorized: true, agent: false, family: isIP(address),
    lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)),
  } };
}

/** No redirect following, cookies, uploads or streaming tunnels. All responses are bounded. */
export async function readPublicPage(value: unknown, policy: Policy, signal: AbortSignal, transport: typeof httpsRequest = httpsRequest): Promise<BrowserReply> {
  const { read, options } = await prepareRead(value, policy);
  policy.admit();
  return new Promise((resolve, reject) => {
    const req = transport({ ...options, signal }, response => {
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        req.destroy(new Error('egress_unsupported_encoding')); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) req.destroy(new Error('egress_response_too_large'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          policy.admit();
          if (size > MAX_RESPONSE_BYTES) throw new Error('egress_response_too_large');
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (responseHeaders.has(name) && typeof value === 'string') headers[name] = value;
          }
          resolve({ id: read.id, status: response.statusCode ?? 502, headers, body: Buffer.concat(chunks).toString('base64') });
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(15_000, () => req.destroy(new Error('egress_timeout')));
    req.on('upgrade', (_response, socket) => { socket.destroy(); reject(new Error('egress_upgrade_refused')); });
    req.on('error', reject);
    req.end();
  });
}
