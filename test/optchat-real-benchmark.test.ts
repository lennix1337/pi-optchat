import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertLiveServices, snapshotHash, taskDockerfile } from './optchat-real-benchmark.ts';
import type { OpenHumanTask } from './pi-account-benchmark.ts';

test('live gate preserves RAM and workload isolation while recording idle infrastructure instead of stopping it', () => {
  const service = { id: 'fixture', image: 'ghcr.io/github/github-mcp-server', cpuPercent: 0 };
  assert.doesNotThrow(() => assertLiveServices([service], 5 * 1024 ** 3));
  assert.throws(() => assertLiveServices([service], 4 * 1024 ** 3), /5 GiB/);
  for (const cpuPercent of [NaN, -1, 1.01]) assert.throws(() => assertLiveServices([{ ...service, cpuPercent }], 8 * 1024 ** 3), /another workload/);
  assert.throws(() => assertLiveServices([{ ...service, image: 'unrelated-benchmark' }], 8 * 1024 ** 3), /another workload/);
});

test('frozen runtime fingerprint detects content or file-name changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oc-fingerprint-'));
  try {
    await writeFile(join(root, 'src.ts'), 'before');
    const hash = await snapshotHash(root);
    assert.equal(hash, await snapshotHash(root));
    await writeFile(join(root, 'src.ts'), 'after');
    assert.notEqual(hash, await snapshotHash(root));
    await rm(join(root, 'src.ts'));
    await writeFile(join(root, 'renamed.ts'), 'before');
    assert.notEqual(hash, await snapshotHash(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('task image overlay preserves official task base and copies only the staged runtime', () => {
  const task = { image: 'swebench/sweb.eval.x86_64.psf_1776_requests-5414:latest' } as OpenHumanTask;
  const text = taskDockerfile(task);
  assert.match(text, /FROM swebench\/sweb\.eval\.x86_64\.psf_1776_requests-5414:latest/);
  assert.match(text, /COPY --from=runtime \/app \/app/);
  assert.doesNotMatch(text, /COPY \. |auth\.json|--mount|docker\.sock/);
  for (const image of ['swebench/sweb.eval.x86_64.pylint-dev_1776_pylint-4970:latest', 'swebench/sweb.eval.x86_64.scikit-learn_1776_scikit-learn-14141:latest']) {
    assert.ok(taskDockerfile({ image } as OpenHumanTask).includes(`FROM ${image}`), 'official hyphenated names must not be rejected');
  }
  assert.throws(() => taskDockerfile({ image: 'untrusted\nRUN malicious' } as OpenHumanTask), /Official/);
});
