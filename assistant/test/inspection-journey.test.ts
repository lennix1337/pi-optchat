import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DisplayLearning, displayBinding } from '../src/memory/display-learning.ts';
import { createPrivateDirectory } from '../src/store/private-directory.ts';
import { prepareDatabase } from '../src/store/privacy.ts';
import { freePort, launchWeb } from './ops-support.ts';

test('real service shows reviewed display state across restart; browser has no learning mutation route', { timeout: 60000 }, async () => {
  const dir = join(tmpdir(), 'inspection-journey-' + randomUUID()); createPrivateDirectory(dir);
  const profileId = 'inspection-owner', token = randomUUID();
  const endpoint = `http://127.0.0.1:${await freePort()}`;
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ version: 1, profileId, token, endpoint, databasePath: join(dir, 'tasks.sqlite'), learning: true }));
  const authority = {}, path = join(dir, 'learning-display.sqlite');
  prepareDatabase(path); // as the trusted display-learning CLI does before opening it
  let owner: DisplayLearning | undefined = new DisplayLearning({ databasePath: path, profileId, operatorAuthority: authority });
  const proposal = owner.propose('dashboard status: task in progress; completed tasks'), binding = displayBinding(proposal);
  owner.measure(binding); owner.decide(binding, 'approve', authority, 'fixture operator only'); owner.apply(binding, authority); owner.close(); owner = undefined;
  let running: ReturnType<typeof launchWeb> | undefined;
  const login = async () => {
    const res = await fetch(endpoint + '/web/session', { method: 'POST', headers: { origin: endpoint, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal(res.status, 200);
    return { cookie: res.headers.get('set-cookie')!.split(';')[0], csrf: (await res.json() as { csrf: string }).csrf };
  };
  try {
    running = launchWeb(config); await running.ready;
    assert.equal((await fetch(endpoint + '/web/api/inspection')).status, 401);
    let session = await login();
    const current = async () => {
      const res = await fetch(endpoint + '/web/api/inspection', { headers: { cookie: session.cookie } }); assert.equal(res.status, 200);
      return await res.json() as { learning: { current: { text: string; revision: number }; proposals: { state: string; profileId: string }[] }; notices: unknown };
    };
    assert.equal((await current()).learning.current.text, proposal.candidate);
    const view = await current(); assert.deepEqual(view.learning.proposals.map(p => [p.profileId, p.state]), [[profileId, 'applied']]); assert.equal(view.notices, null);
    const mutation = await fetch(endpoint + '/web/api/inspection', { method: 'POST', headers: { origin: endpoint, cookie: session.cookie, 'x-assistant-csrf': session.csrf, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'revert', ...binding }) });
    assert.equal(mutation.status, 404); assert.equal((await current()).learning.current.text, proposal.candidate);
    await running.stop(); running = launchWeb(config); await running.ready; session = await login();
    assert.equal((await current()).learning.current.text, proposal.candidate);
    owner = new DisplayLearning({ databasePath: path, profileId, operatorAuthority: authority }); owner.revert(binding, authority, 'fixture rollback'); owner.close(); owner = undefined;
    const reverted = await current(); assert.equal(reverted.learning.current.text, proposal.baseline); assert.equal(reverted.learning.proposals[0].state, 'reverted');
  } finally { owner?.close(); await running?.stop(); rmSync(dir, { recursive: true, force: true }); }
});
