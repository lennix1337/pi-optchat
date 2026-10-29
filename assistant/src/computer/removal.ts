import type { DockerRunner } from './docker.ts';

const OWNER_LABEL = 'optchat.computer.owner';
type Removal = 'removed' | 'absent' | 'foreign' | 'failed';

async function census(docker: DockerRunner, owner?: string): Promise<Set<string> | undefined> {
  const args = ['ps', '--all'];
  if (owner !== undefined) args.push('--filter', `label=${OWNER_LABEL}=${owner}`);
  args.push('--format', '{{.Names}}');
  try {
    const result = await docker(args);
    return result.code === 0 ? new Set(result.stdout.split(/\r?\n/).filter(Boolean)) : undefined;
  } catch { return undefined; }
}

/** Inspect the current identity and remove by ID; a failed inspect is not evidence of absence. */
export async function removeComputer(docker: DockerRunner, owner: string, name: string, confirmAbsence: boolean, expectedId?: string, expectedIdentity?: { profile: string; agent: string }): Promise<Removal> {
  try {
    const target = expectedId ?? name;
    const format = expectedIdentity ? `{{.Id}}|{{index .Config.Labels "${OWNER_LABEL}"}}|{{index .Config.Labels "optchat.computer.profile"}}|{{index .Config.Labels "optchat.computer.agent"}}` : `{{.Id}}|{{index .Config.Labels "${OWNER_LABEL}"}}`;
    const inspected = await docker(['inspect', '--type', 'container', '--format', format, target]);
    if (inspected.code !== 0) {
      if (!confirmAbsence) return 'failed';
      if (expectedId) {
        const ids = await docker(['ps', '--all', '--no-trunc', '--format', '{{.ID}}']);
        return ids.code === 0 && !ids.stdout.split(/\r?\n/).includes(expectedId) ? 'absent' : 'failed';
      }
      const names = await census(docker);
      return names && !names.has(name) ? 'absent' : 'failed';
    }
    const [id, actualOwner, profile, agent] = inspected.stdout.trim().split('|');
    if (!id || !/^[a-f0-9]{64}$/.test(id) || !actualOwner) return 'failed';
    if (actualOwner !== owner || (expectedId !== undefined && id !== expectedId) || (expectedIdentity && (profile !== expectedIdentity.profile || agent !== expectedIdentity.agent))) return 'foreign';
    return (await docker(['rm', '--force', id])).code === 0 ? 'removed' : 'failed';
  } catch { return 'failed'; }
}

/** Collect independent outcomes so callers can persist successful transitions even on partial failure. */
export async function cleanupComputers(docker: DockerRunner, owner: string, tracked: readonly string[]): Promise<{ cleared: string[]; removed: number; failures: number } | undefined> {
  const all = await census(docker);
  const owned = await census(docker, owner);
  if (!all || !owned) return undefined;
  const trackedNames = new Set(tracked);
  const cleared: string[] = [];
  let removed = 0;
  let failures = 0;
  for (const name of new Set([...owned, ...trackedNames])) {
    const result = !all.has(name) && !owned.has(name) ? 'absent' : await removeComputer(docker, owner, name, false);
    if (result === 'removed') removed += 1;
    if (result === 'removed' || result === 'absent') cleared.push(name);
    if (result === 'failed' || (result === 'foreign' && trackedNames.has(name))) failures += 1;
  }
  return { cleared, removed, failures };
}
