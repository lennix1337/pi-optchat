import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runShell, shellRequest } from '../src/computer/effects.ts';
import { base, withComputers } from './computer-support.ts';

const OTP = '482913';

/** Plays the operator's terminal: the takeover argv without a TTY, fed typed lines on stdin. */
function operatorTypes(argv: string[], lines: string): string {
  const [command, ...args] = argv.filter(arg => arg !== '--tty');
  const result = spawnSync(command, args, { input: lines, encoding: 'utf8', timeout: 30_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('takeover blocks the agent in every process, the operator signs in, and hand-back leaks no typed code', () => withComputers(async ({ computers, gateway, authority, open }) => {
  const a = await computers.create('p', 'agent-a');
  await assert.rejects(computers.takeover(a.id, {}), /unauthorized/);
  const { argv } = await computers.takeover(a.id, authority);
  assert.ok(argv.includes('HISTFILE=/dev/null') && argv.includes(a.container));

  const otherProcess = open(); // its own SQLite connection, as a separate agent process would have
  try {
    await assert.rejects(otherProcess.exec(a.id, ['cat', '/work/session']), /computer_human_control/);
    await assert.rejects(otherProcess.capture(a.id), /computer_human_control/);
  } finally { otherProcess.close(); }
  const held = base();
  await assert.rejects(runShell(gateway, computers, shellRequest(held, a, ['ls', '/work'])), /computer_human_control/);
  assert.equal(gateway.status(held.operationId), 'absent', 'a refused command records no gateway intent');

  operatorTypes(argv, `read -r code <<EOF\n${OTP}\nEOF\nexport CODE="$code"\necho signed-in > /work/session\nexit\n`);
  assert.equal(await computers.sweep().then(ids => ids.length), 0, 'a held computer is never swept');
  computers.handBack(a.id, authority);
  assert.throws(() => computers.handBack(a.id, authority), /computer_not_in_takeover/);

  const after = await runShell(gateway, computers, shellRequest(held, a, ['sh', '-c', `cat /work/session; grep -rs ${OTP} /work /tmp; env | grep -c ${OTP}; ls -A /work`]));
  assert.equal(after.stdout.trim().split('\n').join(' '), 'signed-in 0 session', 'the session is handed back; the typed code is nowhere');
}));

test('an expired computer is kept while the operator holds it and swept once handed back and idle', () => {
  let now = Date.now();
  return withComputers(async ({ computers, authority }) => {
    const a = await computers.create('p', 'agent-a');
    await computers.takeover(a.id, authority);
    now += 4_000;
    assert.deepEqual(await computers.sweep(), [], 'expiry never removes a computer under human control');
    computers.handBack(a.id, authority);
    now += 4_000;
    assert.deepEqual(await computers.sweep(), [a.id]);
  }, { now: () => now, ttlMs: 2_000 });
});

test('taking over a paused computer unpauses it for the operator and keeps the agent out', () => withComputers(async ({ computers, authority }) => {
  const a = await computers.create('p', 'agent-a');
  await computers.pause(a.id);
  const { argv } = await computers.takeover(a.id, authority);
  assert.equal(operatorTypes(argv, 'echo operator-here\nexit\n').trim(), 'operator-here');
  await assert.rejects(computers.exec(a.id, ['true']), /computer_human_control/);
  computers.handBack(a.id, authority);
  assert.equal((await computers.exec(a.id, ['echo', 'agent-back'])).stdout.trim(), 'agent-back');
}));
