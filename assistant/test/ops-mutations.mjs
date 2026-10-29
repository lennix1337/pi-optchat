// Disposable-source negative controls for T13 operations: each guard is removed in a copy of the package and the
// named test must then fail for the expected reason. The checkout itself is never modified.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const assistant = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'assistant-ops-mutations-'));
const assertion = /AssertionError|ERR_ASSERTION/;
const windowsOnly = process.platform === 'win32';
const mutations = [
  ['process ownership (pid + start time)', 'src/ops/service.ts', 'return processInfo(record.pid)?.startTime === record.processStartTime;', 'return processInfo(record.pid) !== null;',
    'shutdown.test.ts', 'never kill or trust', assertion],
  ['foreign port refusal', 'src/ops/service.ts', "if (await portInUse(portOf(config.endpoint))) throw new OpsError('port_in_use'", "if (false) throw new OpsError('port_in_use'",
    'install.test.ts', 'refuses a port', assertion],
  ['graceful drain request', 'src/main.ts', 'if (stopFile && isAbsolute(stopFile)) stopWatch = ', 'if (false) stopWatch = ',
    'shutdown.test.ts', 'stop drains the service', assertion],
  ['autostart dry run by default', 'src/ops/autostart.ts', "if (!options.yes) return { result: 'dry_run', launcher, plan };\n  writeFileSync", 'writeFileSync',
    'install.test.ts', 'autostart is explicit opt-in', assertion, windowsOnly],
  ['backup authentication (GCM tag)', 'src/ops/backup.ts', 'plain = Buffer.concat([decipher.update(sealed.subarray(headerEnd, sealed.length - 16)), decipher.final()]);',
    'plain = decipher.update(sealed.subarray(headerEnd, sealed.length - 16));', 'backup-restore.test.ts', 'tampered backup fails closed', /Missing expected rejection/],
  ['restore no-replay job fence', 'src/ops/backup.ts', "error = 'restored_unreconciled' WHERE state IN ('queued', 'running', 'dispatching')", "error = 'restored_unreconciled' WHERE 0",
    'backup-restore.test.ts', 'round trip', assertion],
  ['restore approval fence', 'src/ops/backup.ts', "sql: 'UPDATE grants SET revoked = 1 WHERE revoked = 0'", "sql: 'UPDATE grants SET revoked = 1 WHERE 0'",
    'backup-restore.test.ts', 'round trip', assertion],
  ['notification consent', 'src/notifications/center.ts', 'if (this.read<boolean>(`consent:${channel}`) !== true) {', 'if (false) {',
    'notifications.test.ts', 'without operator consent', assertion],
  ['notification quiet hours', 'src/notifications/center.ts', "if (quiet && inQuietHours(quiet, this.now())) return 'deferred';", '',
    'notifications.test.ts', 'quiet hours defer', assertion],
  ['notification free-text refusal', 'src/notifications/center.ts', "Object.keys(v).sort().join(',') !== 'category,channel,id,ref' || ", '',
    'notifications.test.ts', 'stable ids deduplicate', /Missing expected exception/],
];

function run(dir, file, name) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-timeout=180000', '--test-name-pattern', name, join(dir, 'test', file)], { encoding: 'utf8', env, timeout: 300_000 });
  if (result.error || result.signal) throw new Error(`Test process failed to run: ${result.error ?? result.signal}`);
  return { status: result.status, output: result.stdout + result.stderr };
}
try {
  const baseline = join(root, 'baseline');
  for (const part of ['src', 'scripts', 'test', 'package.json']) cpSync(join(assistant, part), join(baseline, part), { recursive: true });
  const active = mutations.filter(m => m[7] !== false);
  for (const [file, name] of new Set(active.map(m => `${m[4]}\u0000${m[5]}`)).values().map(key => key.split('\u0000'))) {
    const result = run(baseline, file, name);
    if (result.status !== 0 || !/^# pass [1-9]/m.test(result.output) || /^# fail [1-9]/m.test(result.output)) throw new Error(`Baseline ${file} "${name}" failed:\n${result.output}`);
    console.log(`baseline ${file} "${name}": passed`);
  }
  for (const [index, [name, file, before, after, testFile, testName, expected]] of active.entries()) {
    const dir = join(root, `mutation-${index}`);
    cpSync(baseline, dir, { recursive: true });
    const path = join(dir, file), source = readFileSync(path, 'utf8');
    if (source.split(before).length !== 2) throw new Error(`${name}: mutation anchor not unique`);
    writeFileSync(path, source.replace(before, after));
    const result = run(dir, testFile, testName);
    if (result.status === 0 || !expected.test(result.output)) throw new Error(`${name}: mutation not detected as intended:\n${result.output}`);
    console.log(`${name}: detected (${expected.source})`);
  }
  for (const [name] of mutations.filter(m => m[7] === false)) console.log(`${name}: skipped on ${process.platform}`);
} finally { rmSync(root, { recursive: true, force: true }); }
