import { randomUUID } from 'node:crypto';
import type { EffectRequest, Gateway } from '../policy/gateway.ts';
import type { Computer, ComputerManager } from './manager.ts';
import { normalizeOrigins, validateRead } from './egress.ts';
import { startBrowserRelay } from './relay.ts';
import { computerRequest } from './effects.ts';

type Base = Omit<EffectRequest, 'adapter' | 'action' | 'account' | 'destination' | 'payload'>;
function payload(url: string, origins: readonly string[]) {
  const grants = normalizeOrigins(origins);
  validateRead({ id: 1, url, method: 'GET', headers: {} }, grants);
  return { url, origins: grants };
}

/** Authority binds both the top-level URL and explicit subresource/redirect origin grants. */
export function browserReadRequest(base: Base, computer: Computer, navigation: { url: string; origins: readonly string[] }): EffectRequest {
  const data = payload(navigation.url, navigation.origins);
  return computerRequest(base, computer, 'browser_read', Buffer.from(JSON.stringify(data)));
}

/** Public, credential-free HTTPS reads through a network-none browser and inspected STDIO broker. */
export async function openBrowserRead(gateway: Gateway, computers: ComputerManager, request: EffectRequest): Promise<{ snapshot: string; blockedRequests: number; caFingerprint: string }> {
  const check = (profile: string, account: string, destination: string) => {
    computers.admit(account, destination);
    if (computers.get(account).profileId !== profile) throw new Error('computer_profile_mismatch');
  };
  check(request.profileId, request.account, request.destination);
  let sinkFailure: unknown;
  return gateway.dispatch(request, (bytes, metadata) => (async () => {
    if (metadata.adapter !== 'computer' || metadata.action !== 'browser_read' || bytes.length > 16_384) throw new Error('invalid_request');
    check(metadata.profileId, metadata.account, metadata.destination);
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const data = payload(parsed.url, parsed.origins);
    const relay = await startBrowserRelay(computers, metadata.account, data.origins, metadata.expiresAt);
    const sessionId = `public-${randomUUID()}`;
    const launchArgs = `--proxy-server=http://127.0.0.1:${relay.port},--proxy-bypass-list=<-loopback>,--disable-quic,--disable-background-networking,--disable-dev-shm-usage,--no-sandbox,--disable-gpu`;
    const run = (args: string[]) => computers.exec(metadata.account, ['agent-browser', '--session', sessionId, '--args', launchArgs, ...args], { destination: metadata.destination, timeoutMs: 60_000 });
    let cleanupReason: string | undefined;
    try {
      check(metadata.profileId, metadata.account, metadata.destination);
      relay.assertActive();
      const opened = await run(['open', data.url]);
      if (opened.code !== 0) throw new Error('computer_browser_open_failed');
      const snapshot = await run(['snapshot']);
      if (snapshot.code !== 0 || snapshot.truncated) throw new Error('computer_browser_snapshot_failed');
      check(metadata.profileId, metadata.account, metadata.destination);
      relay.assertActive();
      return { snapshot: snapshot.stdout, blockedRequests: relay.failures(), caFingerprint: relay.fingerprint };
    } finally {
      try { if ((await run(['close'])).code !== 0) throw new Error('computer_browser_close_failed'); }
      catch (error) { cleanupReason = error instanceof Error ? error.message : 'computer_browser_close_failed'; }
      try { await relay.close(); } catch (error) { cleanupReason ??= error instanceof Error ? error.message : 'egress_cleanup_failed'; }
      if (cleanupReason) throw Object.assign(new Error('computer_browser_cleanup_failed'), { sessionId, container: metadata.destination, cleanupReason });
    }
  })().catch(error => { sinkFailure = error; throw error; })).catch(error => {
    const reason = sinkFailure instanceof Error ? sinkFailure.message : undefined;
    throw Object.assign(error, { browserReason: reason && /^[a-z_]+$/.test(reason) ? reason : 'egress_failed' });
  });
}
