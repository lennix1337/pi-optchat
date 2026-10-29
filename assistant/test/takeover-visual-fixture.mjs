import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { ComputerManager } from '../src/computer/manager.ts';
import { beginGraphicalTakeover } from '../src/computer/graphical-takeover.ts';
import { dockerCli } from '../src/computer/docker.ts';

// Disposable viewing-only fixture; stdin handback is the trusted authority, never the HTTP cookie.
const dir = mkdtempSync(join(tmpdir(), 'takeover-visual-'));
const authority = {}, owner = `visual-${randomUUID()}`, cookie = randomBytes(24).toString('hex');
const manager = new ComputerManager({ databasePath: join(dir, 'db'), owner, image: 'optchat-computer-takeover:local', operatorAuthority: authority });
let session;
try {
  const computer = await manager.create('fixture', 'agent');
  const revocation = new AbortController();
  session = await beginGraphicalTakeover({ computers: manager, id: computer.id, authority, revocation: revocation.signal, authorizeOwner: request => request.headers.cookie === `takeover_fixture=${cookie}` });
  const recovery = await manager.inspectRecovery(authority);
  const humanId = recovery.computers.find(entry => entry.computer.id === computer.id)?.target;
  if (!humanId) throw new Error('fixture_human_identity_unverified');
  let refused = false;
  try { await manager.exec(computer.id, ['true']); } catch (error) { if (error.message !== 'computer_human_control') throw error; refused = true; }
  if (!refused) throw new Error('fixture_agent_not_refused');
  console.log(JSON.stringify({ status: 'ready', url: `http://127.0.0.1:${session.port}/`, cookie, owner, agentRefused: refused }));
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    if (line !== 'handback') { console.log(JSON.stringify({ status: 'invalid_command' })); continue; }
    await session.handBack(authority); session = undefined;
    const census = await dockerCli(['ps', '--all', '--no-trunc', '--format', '{{.ID}}']);
    if (census.code !== 0 || census.stdout.split(/\r?\n/).includes(humanId)) throw new Error('fixture_human_container_not_removed');
    const result = await manager.exec(computer.id, ['sh', '-c', 'test ! -e /work/takeover-profile && ! grep -r -I -l -F ABC /work /tmp >/dev/null && printf clean']);
    if (result.code !== 0 || result.stdout !== 'clean') throw new Error('fixture_agent_workspace_not_clean');
    console.log(JSON.stringify({ status: 'handed_back', humanContainerAbsent: true, cleanAgentWorkspace: true, canary: 'ABC', scanScope: '/work and /tmp only' }));
    input.close(); break;
  }
} finally {
  if (session) await session.handBack(authority);
  await manager.cleanup(); manager.close(); rmSync(dir, { recursive: true, force: true });
}
