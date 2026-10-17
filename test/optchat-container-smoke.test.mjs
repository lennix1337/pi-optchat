import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertSmokeGate, contextFiles, dockerfile, smokeArgs, stageContext } from './optchat-container-smoke.mjs';

test('real harness smoke fails closed on active containers or insufficient RAM', () => {
  assert.throws(() => assertSmokeGate('unrelated-container\n', 10 * 1024 ** 3), /another Docker container/);
  for (const memory of [NaN, 0, 5 * 1024 ** 3 - 1]) assert.throws(() => assertSmokeGate('', memory), /5 GiB/);
  assert.doesNotThrow(() => assertSmokeGate('\n', 5 * 1024 ** 3));
  assert.doesNotThrow(() => assertSmokeGate('existing-service', 5 * 1024 ** 3, true));
  assert.throws(() => assertSmokeGate('existing-service', 0, true), /5 GiB/);
});

test('whole OptChat runtime has no network, host mounts, credentials, capabilities or writable image', () => {
  const args = smokeArgs('optchat-smoke-ab12:local', 'optchat-smoke-ab12');
  for (const [flag, value] of [['--network', 'none'], ['--memory', '4g'], ['--memory-swap', '4g'], ['--cpus', '4'], ['--cap-drop', 'ALL']]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.ok(args.includes('--read-only'));
  assert.ok(!args.some(arg => ['-v', '--mount', '--volume', '--env-file', '--privileged', '--env', '-e'].includes(arg)));
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /test\/headless\.test\.ts/);
  assert.throws(() => smokeArgs('other-image', 'optchat-smoke-ab12'), /Invalid/);
});

test('container build stages only source and the offline acceptance tests, not checkout or auth data', () => {
  const root = mkdtempSync(join(tmpdir(), 'optchat-stage-'));
  const source = join(root, 'source'), target = join(root, 'target');
  try {
    for (const file of contextFiles) {
      mkdirSync(dirname(join(source, file)), { recursive: true });
      if (file === 'src') mkdirSync(join(source, file));
      else writeFileSync(join(source, file), 'fixture');
    }
    for (const name of ['auth.json', '.env', 'AGENTS.md']) writeFileSync(join(source, name), 'private sentinel');
    stageContext(source, target);
    for (const name of ['auth.json', '.env', 'AGENTS.md', '.git', 'node_modules']) assert.equal(existsSync(join(target, name)), false);
    assert.equal(existsSync(join(target, 'Dockerfile')), true);
    assert.equal(existsSync(join(target, 'test/headless.test.ts')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
