import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { ComputerManager } from '../src/computer/manager.ts';
import { beginGraphicalTakeover } from '../src/computer/graphical-takeover.ts';
import { onTakeoverDisplay } from '../src/computer/takeover-session.ts';

// Disposable viewing fixture for a human: the agent's own offline page is shown through the takeover page.
// stdin handback is the trusted authority, never the HTTP cookie.
const dir = mkdtempSync(join(tmpdir(), 'takeover-visual-'));
const authority = {}, owner = `visual-${randomUUID()}`, cookie = randomBytes(24).toString('hex');
const manager = new ComputerManager({ databasePath: join(dir, 'db'), owner, image: 'optchat-computer-takeover:local', operatorAuthority: authority });
let session;
try {
  const computer = await manager.create('fixture', 'agent');
  const page = 'data:text/html,%3Ctitle%3EOffline%20login%20fixture%3C%2Ftitle%3E%3Ch1%3EOffline%20login%3C%2Fh1%3E%3Clabel%3ECode%20%3Cinput%20type%3Dpassword%3E%3C%2Flabel%3E';
  const opened = await manager.exec(computer.id, onTakeoverDisplay(['agent-browser', '--session', 'agent', '--headed', 'open', page]), { timeoutMs: 60_000 });
  if (opened.code !== 0) throw new Error('fixture_agent_browser_failed');
  const before = await manager.isolatedTarget(computer.id);
  const revocation = new AbortController();
  session = await beginGraphicalTakeover({ computers: manager, id: computer.id, authority, revocation: revocation.signal, authorizeOwner: request => request.headers.cookie === `takeover_fixture=${cookie}` });
  let refused = false;
  try { await manager.exec(computer.id, ['true']); } catch (error) { if (error.message !== 'computer_human_control') throw error; refused = true; }
  if (!refused) throw new Error('fixture_agent_not_refused');
  console.log(JSON.stringify({ status: 'ready', url: `http://127.0.0.1:${session.port}/`, cookie, owner, agentRefused: refused }));
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    if (line !== 'handback') { console.log(JSON.stringify({ status: 'invalid_command' })); continue; }
    await session.handBack(authority); session = undefined;
    if (await manager.isolatedTarget(computer.id) !== before) throw new Error('fixture_container_replaced');
    const snapshot = await manager.exec(computer.id, ['agent-browser', '--session', 'agent', 'snapshot'], { timeoutMs: 60_000 });
    if (snapshot.code !== 0 || !snapshot.stdout.includes('Offline login')) throw new Error('fixture_agent_browser_not_continued');
    console.log(JSON.stringify({ status: 'handed_back', sameContainer: true, agentBrowserContinues: true }));
    input.close(); break;
  }
} finally {
  if (session) await session.handBack(authority);
  await manager.cleanup(); manager.close(); rmSync(dir, { recursive: true, force: true });
}
