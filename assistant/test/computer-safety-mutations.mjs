import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const assistant = fileURLToPath(new URL('../', import.meta.url));
const cases = [
  ['removal-failure', 'removal.ts', "? 'removed' : 'failed'", "? 'removed' : 'removed'"],
  ['inspection-is-absence', 'removal.ts', "return names && !names.has(name) ? 'absent' : 'failed';", "return 'absent';"],
  ['foreign-owner', 'removal.ts', "if (actualOwner !== owner || (expectedId", "if (false || (expectedId"],
  ['erase-failed-record', 'removal.ts', "if (result === 'removed' || result === 'absent') cleared.push(name);", "if (result !== 'foreign') cleared.push(name);"],
  ['destroy-uncertain-record', 'manager.ts', "if (result === 'failed') fail('computer_remove_failed');", ''],
  ['reserved-ipv4', 'network.ts', 'return blockedIpv4.some(([prefix, bits]) => (value >>> (32 - bits)) === (prefix >>> (32 - bits)));', 'return false;'],
  ['ipv6-global-unicast', 'network.ts', 'if ((value >> 125n) !== 1n) return true;', ''],
  ['special-ipv6', 'network.ts', 'return blockedIpv6.some(([prefix, bits]) => (value >> BigInt(128 - bits)) === (prefix >> BigInt(128 - bits)));', 'return false;'],
  ['resolved-answer', 'network.ts', 'resolved.some(address => isIP(address) === 0 || isInternalHost(address))', 'false'],
  ['origin-grant', 'network.ts', "if (!grantedOrigins.includes(url.origin)) return { ok: false, reason: 'origin_not_granted' };", ''],
];
const dir = mkdtempSync(join(tmpdir(), 'computer-safety-mutants-'));
const source = join(dir, 'src', 'computer');
try {
  cpSync(join(assistant, 'src'), join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'));
  for (const name of ['computer-cleanup.test.ts', 'computer-network.test.ts']) cpSync(join(assistant, 'test', name), join(dir, 'test', name));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const run = () => spawnSync(process.execPath, ['--test', 'test/computer-cleanup.test.ts', 'test/computer-network.test.ts'], {
    cwd: dir, encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });
  const baseline = run();
  assert.ifError(baseline.error);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  for (const [name, file, from, to] of cases) {
    const path = join(source, file);
    const original = readFileSync(path, 'utf8');
    assert.equal(original.split(from).length - 1, 1, `mutation anchor: ${name}`);
    try {
      writeFileSync(path, original.replace(from, to));
      const result = run();
      assert.ifError(result.error);
      assert.equal(result.status, 1, `${name} survived or crashed: ${result.stdout}${result.stderr}`);
      assert.match(result.stdout + result.stderr, /ERR_ASSERTION/, `${name} did not fail an assertion`);
      console.log(`killed ${name}`);
    } finally { writeFileSync(path, original); }
  }
  console.log(`baseline passed; ${cases.length}/${cases.length} mutants killed`);
} finally { rmSync(dir, { recursive: true }); }
