import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import { createPrivateDirectory } from '../store/private-directory.ts';
import { EnvironmentRefused, type OpenRequest, type RunRequest, type RunResult } from './actions.ts';
import type { Environment } from './local.ts';

/**
 * The environment over loopback, for an environment that runs apart from the service (a daemon on this machine today,
 * the same protocol from another host later). Only one-shot actions cross it: a stream is a live pipe, so `open` is
 * refused for a remote client. Every request needs the bearer token from a private token file; the daemon binds
 * 127.0.0.1 only and never accepts a request without it.
 */
export const DAEMON_RUN_PATH = '/v1/run';
const MAX_BODY = 64 * 1024;
const MAX_DRAIN = 1024 * 1024;
/** A base64url string of 32 random bytes, the only form `loadOrCreateToken` writes. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RESPONSE_TIMEOUT_MS = 130_000;

/**
 * The daemon's token. Created once with owner-only permissions inside a private directory, read on every start. A
 * malformed file is refused, never silently replaced, because a replaced token would lock out the running daemon.
 */
export function loadOrCreateToken(path: string): string {
  if (!isAbsolute(path)) throw new TypeError('Token path must be absolute');
  createPrivateDirectory(dirname(path));
  let text: string;
  try { text = readFileSync(path, 'utf8').trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('base64url');
    writeFileSync(path, `${token}\n`, { flag: 'wx', mode: 0o600 });
    return token;
  }
  if (!TOKEN.test(text)) throw new EnvironmentRefused('daemon_token_invalid');
  return text;
}

function bearerMatches(header: string | undefined, expected: Buffer): boolean {
  const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readRequest(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  // An oversized body is drained, not cut off, so the client still reads the 413; past the drain cap the socket is closed.
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_DRAIN) { request.destroy(); throw new EnvironmentRefused('body_too_large'); }
    if (size <= MAX_BODY) chunks.push(chunk as Buffer);
  }
  if (size > MAX_BODY) throw new EnvironmentRefused('body_too_large');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new EnvironmentRefused('invalid_json'); }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function handle(environment: Environment, expected: Buffer, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST' || request.url !== DAEMON_RUN_PATH) { send(response, 404, { error: 'not_found' }); return; }
  if (!bearerMatches(request.headers.authorization, expected)) { send(response, 401, { error: 'unauthorized' }); return; }
  let body: unknown;
  try { body = await readRequest(request); }
  catch (error) {
    if (error instanceof EnvironmentRefused) { send(response, error.message === 'body_too_large' ? 413 : 400, { error: error.message }); return; }
    throw error;
  }
  try { send(response, 200, await environment.run(body as RunRequest)); }
  catch (error) {
    // The allow-list refused the request before any process started; anything else is a daemon fault, not a result.
    if (error instanceof EnvironmentRefused) { send(response, 400, { error: error.message }); return; }
    throw error;
  }
}

/** Starts the loopback daemon around `environment`. `port` 0 picks a free port (tests). */
export function startEnvironmentDaemon(options: { environment: Environment; token: string; port?: number }): Promise<{ endpoint: string; close(): Promise<void> }> {
  const expected = Buffer.from(options.token);
  const server: Server = createServer((request, response) => {
    handle(options.environment, expected, request, response).catch(() => send(response, 500, { error: 'daemon_failed' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address() as AddressInfo;
      resolve({
        endpoint: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }),
      });
    });
  });
}

/** The client side: the same `Environment` interface, carried over the loopback daemon. */
export function daemonEnvironment(options: { endpoint: string; token: string }): Environment {
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(options.endpoint)) throw new TypeError('daemon endpoint must be loopback');
  return {
    async run(request: RunRequest): Promise<RunResult> {
      const response = await fetch(`${options.endpoint}${DAEMON_RUN_PATH}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(RESPONSE_TIMEOUT_MS),
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' }, body: JSON.stringify(request),
      });
      const body = await response.json().catch(() => null) as Partial<RunResult> & { error?: unknown } | null;
      if (!response.ok) throw new EnvironmentRefused(typeof body?.error === 'string' ? body.error : `daemon_${response.status}`);
      if (!body || typeof body.code !== 'number' || typeof body.stdout !== 'string' || typeof body.stderr !== 'string' || typeof body.uncertain !== 'boolean') {
        throw new EnvironmentRefused('daemon_invalid_response');
      }
      return { code: body.code, stdout: body.stdout, stderr: body.stderr, uncertain: body.uncertain };
    },
    open(_request: OpenRequest) { throw new EnvironmentRefused('stream_not_remotable'); },
  };
}
