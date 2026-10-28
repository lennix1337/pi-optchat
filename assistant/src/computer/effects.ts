import type { EffectRequest, Gateway } from '../policy/gateway.ts';
import type { Computer, ComputerManager, ExecResult } from './manager.ts';
import { checkNavigation, type NavigationRefusal } from './network.ts';

type Base = Omit<EffectRequest, 'adapter' | 'action' | 'account' | 'destination' | 'payload'>;

/** An effect request whose account is the computer and whose destination is its container, so a grant binds both. */
export function shellRequest(base: Base, computer: Computer, argv: readonly string[]): EffectRequest {
  return { ...base, adapter: 'computer', action: 'shell', account: computer.id, destination: computer.container, payload: Buffer.from(JSON.stringify(argv)) };
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
 * the gateway records anything. No browser is provisioned in a computer yet, so admitted navigations fail
 * closed with `computer_browser_unprovisioned` instead of falling back to a host browser.
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
