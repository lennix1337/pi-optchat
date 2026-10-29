import { spawn } from 'node:child_process';
import type { ComputerManager } from './manager.ts';
import { normalizeOrigins, readPublicPage, type Resolver } from './egress.ts';
import type { request } from 'node:https';

type BrokerIO = { resolve?: Resolver; transport?: typeof request };

export type Relay = { port: number; fingerprint: string; close: () => Promise<void>; failures: () => number; assertActive: () => void; finished: Promise<void> };

/** A bounded, temporary STDIO broker. No host socket or container network is opened. */
export async function startBrowserRelay(computers: ComputerManager, id: string, origins: readonly string[], expiresAt: number, io: BrokerIO = {}): Promise<Relay> {
  const grants = normalizeOrigins(origins);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error('egress_expired');
  const computer = computers.get(id);
  const target = await computers.isolatedTarget(id);
  computers.admit(id, computer.container);
  const child = spawn('docker', ['exec', '--interactive', '--user', '1000:1000', '--workdir', '/work', target, 'timeout', '-s', 'KILL', '150', 'node', '/opt/optchat/https-relay.mjs'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const controller = new AbortController();
  const seen = new Set<number>();
  let closed = false, failures = 0, active = 0, buffer = '', stderr = '';
  const admit = () => {
    if (closed || controller.signal.aborted || Date.now() >= expiresAt) throw new Error('egress_closed');
    computers.admit(id, computer.container);
    if (computers.get(id).profileId !== computer.profileId) throw new Error('computer_profile_mismatch');
  };
  let exitCode: number | null | undefined;
  const exited = new Promise<void>(resolve => child.once('close', code => { exitCode = code; controller.abort(); resolve(); }));
  const stop = (reason: string) => { controller.abort(new Error(reason)); child.stdin.end(); };
  child.on('error', () => stop('egress_transport_failed'));
  child.stdin.on('error', () => stop('egress_transport_failed'));
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 4096); });
  const deadline = setTimeout(() => stop('egress_expired'), Math.min(120_000, expiresAt - Date.now()));
  // Revocation terminates ongoing sockets as well as refusing the next request.
  const revocation = setInterval(() => { try { admit(); } catch { stop('egress_revoked'); } }, 100);
  const send = (value: unknown) => { if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.write(JSON.stringify(value) + '\n'); };
  let readyResolve: (value: { port: number; fingerprint: string }) => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<{ port: number; fingerprint: string }>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let started = false;
  child.once('close', () => { if (!started) readyReject(new Error(stderr.includes('certificate') ? 'egress_certificate_failed' : 'egress_relay_failed')); });
  const handle = async (value: any) => {
    if (!started) {
      if (value.ready !== true || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw new Error('egress_invalid_ready');
      started = true; readyResolve({ port: value.port, fingerprint: value.fingerprint }); return;
    }
    if (!Number.isSafeInteger(value.id) || value.id < 1 || seen.has(value.id) || seen.size >= 512 || active >= 16) throw new Error('egress_invalid_frame');
    seen.add(value.id); active++;
    try { send(await readPublicPage(value, { origins: grants, admit, resolve: io.resolve }, controller.signal, io.transport)); }
    catch { failures++; send({ id: value.id, status: 403, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Blocked by disposable browser policy').toString('base64') }); }
    finally { active--; }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 64 * 1024) { stop('egress_frame_too_large'); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { void handle(JSON.parse(line)).catch(() => stop('egress_invalid_frame')); }
      catch { stop('egress_invalid_frame'); }
    }
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(revocation); clearTimeout(deadline);
    stop('egress_closed');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error('egress_cleanup_uncertain')); }, 5000); })]);
      if (exitCode !== 0) throw new Error('egress_relay_exit_failed');
    } finally { clearTimeout(timer); }
  };
  send({ origins: grants });
  const startup = setTimeout(() => { readyReject(new Error('egress_start_timeout')); stop('egress_start_timeout'); }, 45_000);
  try { return { ...await ready, close, failures: () => failures, assertActive: admit, finished: exited }; }
  catch (error) { try { await close(); } catch (cleanup) { throw new Error('egress_setup_cleanup_failed', { cause: cleanup }); } throw error; }
  finally { clearTimeout(startup); }
}
