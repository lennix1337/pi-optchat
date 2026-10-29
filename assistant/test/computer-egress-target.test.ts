import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComputerManager } from '../src/computer/manager.ts';

test('broker target requires proven own immutable network-none read-only container without host mounts', async () => {
  const authority = {};
  const good = () => ({ Id: 'a'.repeat(64), Config: { Labels: { 'optchat.computer.owner': 'owner' } }, HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true }, Mounts: [] });
  let info: any = good();
  let inspectFailure = false;
  let held = false;
  let created = false;
  const manager = new ComputerManager({ databasePath: ':memory:', owner: 'owner', operatorAuthority: authority, image: 'image', docker: async args => {
    if (args[0] === 'run') { created = true; return { code: 0, stdout: '', stderr: '' }; }
    if (args[0] === 'inspect' && args.includes('{{json .}}')) {
      if (held) await manager.takeover(computer.id, authority);
      return { code: inspectFailure ? 1 : 0, stdout: JSON.stringify(info), stderr: 'private diagnostic' };
    }
    if (args[0] === 'inspect') return { code: created ? 0 : 1, stdout: 'owner|running', stderr: '' };
    throw new Error('unexpected_docker_operation');
  } });
  const computer = await manager.create('p', 'browser');
  try {
    assert.equal(await manager.isolatedTarget(computer.id), 'a'.repeat(64));
    for (const bad of [
      { ...good(), Id: '_'.repeat(64) },
      { ...good(), Config: { Labels: { 'optchat.computer.owner': 'foreign' } } },
      { ...good(), HostConfig: { NetworkMode: 'bridge', ReadonlyRootfs: true } },
      { ...good(), HostConfig: { NetworkMode: 'none', ReadonlyRootfs: false } },
      { ...good(), Mounts: [{ Source: '/host' }] },
      {},
    ]) { info = bad; await assert.rejects(manager.isolatedTarget(computer.id), /isolation_mismatch/); }
    info = good(); inspectFailure = true;
    await assert.rejects(manager.isolatedTarget(computer.id), /inspection_failed/);
    inspectFailure = false; held = true;
    await assert.rejects(manager.isolatedTarget(computer.id), /human_control/);
  } finally { manager.close(); }
});
