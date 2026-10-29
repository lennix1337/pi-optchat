import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { dockerCli, probeDocker } from '../src/computer/docker.ts';
import { createComputers, type ComputerManager, type ComputerOptions } from '../src/computer/manager.ts';
import { createGateway, type Gateway } from '../src/policy/gateway.ts';
import { withDir } from './runtime-support.ts';

/** A small image already on this host; tests never pull. */
export const IMAGE = process.env.OPTCHAT_COMPUTER_TEST_IMAGE ?? 'node:22.23.4-alpine3.23';

/** Fails loudly (never skips) when the local engine or image is missing: these tests are the isolation evidence. */
export async function requireDocker(): Promise<void> {
  const probe = await probeDocker(IMAGE);
  if (!probe.available) throw new Error(`docker backend unavailable: ${probe.reason}`);
  if (!probe.imagePresent) throw new Error(`test image ${IMAGE} is not present locally; this suite never pulls`);
}

export type Rig = { dir: string; owner: string; authority: object; computers: ComputerManager; gateway: Gateway; open: (extra?: Partial<ComputerOptions>) => ComputerManager };

/** A disposable owner with its own database; every container it created is removed afterwards, and only those. */
export async function withComputers(fn: (rig: Rig) => Promise<void>, extra: Partial<ComputerOptions> = {}, policy: () => 'allow' | 'review' | 'deny' = () => 'allow'): Promise<void> {
  await requireDocker();
  await withDir('computer-', async dir => {
    const owner = `test-${randomBytes(6).toString('hex')}`;
    const authority = {};
    const databasePath = join(dir, 'assistant.db');
    const open = (more: Partial<ComputerOptions> = {}) => createComputers({ databasePath, owner, operatorAuthority: authority, image: IMAGE, ...extra, ...more });
    const computers = open();
    const gateway = createGateway({ databasePath, profileId: 'p', operatorAuthority: authority, policy, inspect: () => ({ decision: 'allow', reasons: [] }) });
    try { await fn({ dir, owner, authority, computers, gateway, open }); } finally {
      const cleaner = open();
      try { await cleaner.cleanup(); } finally { cleaner.close(); computers.close(); gateway.close(); }
    }
  });
}

let sequence = 0;
export function base(operationId = `op-${++sequence}-${randomBytes(4).toString('hex')}`) {
  return { version: 1 as const, operationId, profileId: 'p', sessionId: 's', taskId: 't', runId: 'r', policyVersion: 'v1', expiresAt: Date.now() + 10 * 60_000 };
}

export async function inspectContainer(name: string): Promise<Record<string, any> | undefined> {
  const result = await dockerCli(['inspect', '--type', 'container', name]);
  return result.code === 0 ? JSON.parse(result.stdout)[0] : undefined;
}
