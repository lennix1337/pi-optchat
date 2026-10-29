import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserTextRequest, openBrowserText } from '../src/computer/effects.ts';
import { base, inspectContainer, withComputers } from './computer-support.ts';

test('offline browser renders text through gateway and respects ownership and takeover', () => withComputers(async ({ computers, gateway, authority }) => {
  const a = await computers.create('p', 'browser');
  const request = () => browserTextRequest(base(), a, 'Hello <script>offline</script>');
  const output = await openBrowserText(gateway, computers, request());
  assert.match(output, /Hello/);
  assert.match(output, /offline/);
  await computers.pause(a.id);
  const paused = request();
  await assert.rejects(openBrowserText(gateway, computers, paused), /computer_paused/);
  assert.equal(gateway.status(paused.operationId), 'absent');
  await computers.resume(a.id, authority);
  await computers.takeover(a.id, authority);
  await assert.rejects(openBrowserText(gateway, computers, request()), /computer_human_control/);
  computers.handBack(a.id, authority);
  assert.match(await openBrowserText(gateway, computers, request()), /Hello/);
  await assert.rejects(openBrowserText(gateway, computers, { ...request(), profileId: 'other' }), /computer_profile_mismatch/);
  await computers.destroy(a.id);
  assert.equal(await inspectContainer(a.container), undefined);
}, { image: 'optchat-computer-browser:1' }));

test('offline browser obeys review, exact binding, and network isolation', () => withComputers(async ({ computers, gateway, authority }) => {
  const a = await computers.create('p', 'browser');
  const b = await computers.create('p', 'other');
  const request = browserTextRequest(base(), a, 'reviewed artifact');
  await assert.rejects(openBrowserText(gateway, computers, request), /approval_required/);
  const review = gateway.prepare(request);
  assert.equal(review.decision, 'review');
  if (review.decision !== 'review') throw new Error('expected review');
  gateway.decide(review.reviewId, 'approve', authority);
  await assert.rejects(openBrowserText(gateway, computers, { ...request, destination: b.container }), /computer_destination_mismatch/);
  assert.match(await openBrowserText(gateway, computers, request), /reviewed artifact/);
  const info = await inspectContainer(a.container);
  assert.equal(info?.HostConfig.NetworkMode, 'none');
  assert.deepEqual(info?.Mounts, []);
  assert.equal(info?.HostConfig.ReadonlyRootfs, true);
}, { image: 'optchat-computer-browser:1' }, () => 'review'));

test('a browser close failure is reported, and a takeover cannot race into a running browser session', async () => {
  const { dockerCli } = await import('../src/computer/docker.ts');
  let mode: 'failure' | 'takeover' = 'failure';
  let race: (() => Promise<unknown>) | undefined;
  let raced: Promise<unknown> | undefined;
  let closeCalls = 0;
  await withComputers(async ({ computers, gateway, authority }) => {
    const a = await computers.create('p', 'browser');
    race = () => computers.takeover(a.id, authority);
    const failed = browserTextRequest(base(), a, mode);
    await assert.rejects(openBrowserText(gateway, computers, failed), (error: any) => {
      assert.equal(error.message, 'computer_browser_cleanup_failed');
      assert.match(error.sessionId, /^artifact-/);
      assert.equal(error.container, a.container);
      assert.equal(error.cleanupReason, 'computer_browser_close_failed');
      return true;
    });
    assert.equal(gateway.status(failed.operationId), 'uncertain');
    mode = 'takeover';
    // The operator asks for the computer while the agent's browser session is open: the takeover is refused
    // and the session still closes, so the operator never gets a computer with the agent's browser in it.
    assert.match(await openBrowserText(gateway, computers, browserTextRequest(base(), a, mode)), /takeover/);
    await assert.rejects(raced!, /computer_operations_active/);
    assert.equal(closeCalls, 2, 'the raced session still ran its close');
    await computers.takeover(a.id, authority);
    const held = browserTextRequest(base(), a, 'held');
    await assert.rejects(openBrowserText(gateway, computers, held), /computer_human_control/);
    assert.equal(gateway.status(held.operationId), 'absent', 'refused before the gateway records an intent');
    computers.handBack(a.id, authority);
  }, { image: 'optchat-computer-browser:1', docker: async (args, options) => {
    if (args.includes('agent-browser') && args.includes('close')) {
      closeCalls++;
      if (mode === 'failure') return { code: 1, stdout: '', stderr: 'close failure' };
    }
    const result = await dockerCli(args, options);
    if (mode === 'takeover' && args.includes('agent-browser') && args.includes('snapshot')) {
      raced = race!();
      raced.catch(() => undefined);
    }
    return result;
  } });
});

test('operator CLI previews through a disposable gateway and reports cleanup', async () => {
  const { spawnSync } = await import('node:child_process');
  const { dockerCli } = await import('../src/computer/docker.ts');
  const result = spawnSync(process.execPath, ['assistant/scripts/computer.mjs', 'preview', '--text', 'CLI offline proof'], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.mode, 'offline_text_only');
  assert.equal(output.containerCleanup, 'complete');
  assert.match(output.snapshot, /CLI offline proof/);
  const status = spawnSync(process.execPath, ['assistant/scripts/computer.mjs', 'status'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).probe.imagePresent, true);
  const listing = await dockerCli(['ps', '--all', '--filter', `label=optchat.computer.owner=${output.owner}`, '--format', '{{.Names}}']);
  assert.equal(listing.code, 0);
  assert.equal(listing.stdout.trim(), '');
});
