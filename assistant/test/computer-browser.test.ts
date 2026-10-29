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

test('browser close failures and takeover races are reported without bypassing admission', async () => {
  const { dockerCli } = await import('../src/computer/docker.ts');
  let mode: 'failure' | 'takeover' = 'failure';
  let hold: (() => Promise<void>) | undefined;
  let closeCalls = 0;
  await withComputers(async ({ computers, gateway, authority }) => {
    const a = await computers.create('p', 'browser');
    hold = () => computers.takeover(a.id, authority).then(() => undefined);
    for (mode of ['failure', 'takeover'] as const) {
      const request = browserTextRequest(base(), a, mode);
      await assert.rejects(openBrowserText(gateway, computers, request), (error: any) => {
        assert.equal(error.message, 'computer_browser_cleanup_failed');
        assert.match(error.sessionId, /^artifact-/);
        assert.equal(error.container, a.container);
        assert.equal(error.cleanupReason, mode === 'failure' ? 'computer_browser_close_failed' : 'computer_human_control');
        return true;
      });
      assert.equal(gateway.status(request.operationId), 'uncertain');
      if (mode === 'takeover') computers.handBack(a.id, authority);
    }
    assert.equal(closeCalls, 1, 'takeover prevents close docker exec');
  }, { image: 'optchat-computer-browser:1', docker: async (args, options) => {
    if (args.includes('agent-browser') && args.includes('close')) {
      closeCalls++;
      if (mode === 'failure') return { code: 1, stdout: '', stderr: 'close failure' };
    }
    const result = await dockerCli(args, options);
    if (mode === 'takeover' && args.includes('agent-browser') && args.includes('snapshot')) await hold!();
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
