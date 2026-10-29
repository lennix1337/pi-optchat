import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'notification-mutation-'));
try {
  cpSync(resolve('assistant/src'), join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'));
  for (const name of ['notification-delivery.test.ts', 'runtime-support.ts']) cpSync(resolve('assistant/test', name), join(dir, 'test', name));
  const sourcePath = join(dir, 'src/notifications/center.ts');
  const original = readFileSync(sourcePath, 'utf8');
  const run = () => spawnSync(process.execPath, ['--test', join(dir, 'test/notification-delivery.test.ts')], { encoding: 'utf8', timeout: 30000 });
  const baseline = run();
  if (baseline.status !== 0) throw new Error(`baseline failed: ${baseline.stdout}\n${baseline.stderr}`);
  const mutations = [
    ["state = 'uncertain', reason = 'dispatch_in_flight'", "state = 'pending', reason = 'dispatch_in_flight'"],
    ["SET reason = 'transport_uncertain' WHERE", "SET state = 'pending', reason = 'transport_uncertain' WHERE"],
    ['.all(boundedInteger(limit, 50, 1, 500)).reverse()', '.all(500).reverse()'],
  ];
  for (const [before, after] of mutations) {
    if (!original.includes(before)) throw new Error(`missing mutation anchor: ${before}`);
    writeFileSync(sourcePath, original.replace(before, after));
    const mutant = run();
    if (mutant.status !== 1 || !/AssertionError|ERR_ASSERTION/.test(mutant.stdout + mutant.stderr)) throw new Error(`mutant did not fail an assertion: ${mutant.stdout}\n${mutant.stderr}`);
    console.log(`killed: ${before}`);
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
