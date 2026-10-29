import type { EffectRequest, Gateway } from '../policy/gateway.ts';
import type { Computer, ComputerManager, ExecResult } from './manager.ts';
import { checkNavigation, type NavigationRefusal } from './network.ts';

type Base = Omit<EffectRequest, 'adapter' | 'action' | 'account' | 'destination' | 'payload'>;

/** Computer effects bind the same account/container boundary regardless of the payload adapter. */
export function computerRequest(base: Base, computer: Computer, action: string, payload: Uint8Array): EffectRequest {
  return { ...base, adapter: 'computer', action, account: computer.id, destination: computer.container, payload };
}

export function shellRequest(base: Base, computer: Computer, argv: readonly string[]): EffectRequest {
  return computerRequest(base, computer, 'shell', Buffer.from(JSON.stringify(argv)));
}

function parseArgv(bytes: Uint8Array): string[] {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new Error('invalid_request'); }
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error('invalid_request');
  return value;
}

/**
 * Runs a shell command in an isolated computer through the effect gateway. The sink executes the
 * dispatched bytes on the dispatched account and destination, never the caller's request object.
 * A refusal raised by the sink after admission (a takeover that raced in) surfaces as `effect_uncertain`.
 */
export async function runShell(gateway: Gateway, computers: ComputerManager, request: EffectRequest, timeoutMs?: number): Promise<ExecResult> {
  // Refuse a held, paused or mismatched computer before the gateway records an intent; the sink checks again.
  computers.admit(request.account, request.destination);
  return gateway.dispatch(request, (bytes, metadata) => {
    if (metadata.adapter !== 'computer' || metadata.action !== 'shell') throw new Error('invalid_request');
    return computers.exec(metadata.account, parseArgv(bytes), { destination: metadata.destination, timeoutMs });
  });
}

/**
 * Admits a browser navigation for a computer. Internal, metadata and ungranted origins are refused before
 * the gateway records anything. This legacy unbound API stays fail-closed; external reads require the
 * gateway-bound browser-egress adapter and its inspected STDIO proxy, never a host-browser fallback.
 */
export async function navigate(computers: ComputerManager, computerId: string, url: string, grantedOrigins: readonly string[], resolve?: (host: string) => Promise<readonly string[]>): Promise<never> {
  computers.get(computerId);
  let resolved: readonly string[] = [];
  const first = checkNavigation(url, grantedOrigins);
  if (!first.ok) throw new Error(`navigation_${first.reason satisfies NavigationRefusal}`);
  if (resolve) {
    try { resolved = await resolve(new URL(url).hostname); } catch { throw new Error('navigation_unresolved'); }
    const second = checkNavigation(url, grantedOrigins, resolved);
    if (!second.ok) throw new Error(`navigation_${second.reason}`);
  }
  throw new Error('computer_browser_unprovisioned');
}

/** A bounded, inert text artifact, not a URL or HTML document. */
export function browserTextRequest(base: Base, computer: Computer, text: string): EffectRequest {
  if (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text) > 1000) throw new Error('invalid_request');
  return computerRequest(base, computer, 'browser_text', Buffer.from(text));
}

/** Open inert text in a fresh offline browser session and return its accessibility snapshot. */
export async function openBrowserText(gateway: Gateway, computers: ComputerManager, request: EffectRequest): Promise<string> {
  const check = (profile: string, account: string, destination: string) => {
    computers.admit(account, destination);
    if (computers.get(account).profileId !== profile) throw new Error('computer_profile_mismatch');
  };
  check(request.profileId, request.account, request.destination);
  let cleanupFailure: { sessionId: string; container: string; cleanupReason: string } | undefined;
  try { return await gateway.dispatch(request, async (bytes, metadata) => {
    if (metadata.adapter !== 'computer' || metadata.action !== 'browser_text') throw new Error('invalid_request');
    check(metadata.profileId, metadata.account, metadata.destination);
    const text = Buffer.from(bytes).toString('utf8');
    if (bytes.length > 1000 || !Buffer.from(text).equals(Buffer.from(bytes))) throw new Error('invalid_request');
    const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; sandbox"><pre>${escaped}</pre>`;
    const url = `data:text/html;base64,${Buffer.from(html).toString('base64')}`;
    const session = `artifact-${crypto.randomUUID()}`;
    const run = (args: string[]) => computers.exec(metadata.account, ['agent-browser', '--session', session, ...args], { destination: metadata.destination, timeoutMs: 60_000 });
    try {
      const opened = await run(['open', url]);
      if (opened.code !== 0) throw new Error('computer_browser_open_failed');
      const snapshot = await run(['snapshot']);
      if (snapshot.code !== 0 || snapshot.truncated) throw new Error('computer_browser_snapshot_failed');
      return snapshot.stdout;
    } finally {
      try {
        const closed = await run(['close']);
        if (closed.code !== 0) throw new Error('computer_browser_close_failed');
      } catch (error) {
        cleanupFailure = { sessionId: session, container: metadata.destination, cleanupReason: error instanceof Error ? error.message : 'computer_browser_close_failed' };
        throw error;
      }
    }
  }); } catch (error) {
    if (cleanupFailure) throw Object.assign(new Error('computer_browser_cleanup_failed', { cause: error }), cleanupFailure);
    throw error;
  }
}
