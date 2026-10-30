import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const fixtureAcl = `$ErrorActionPreference='Stop'
$p=$env:PRIVACY_FIXTURE
$acl=[System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true,$false)
$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
foreach($sid in @($identity.Value,'S-1-5-18','S-1-5-32-544')) {
 $rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule)
}
if ($env:PRIVACY_UNSAFE -eq '1') {
 $rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow')
 $acl.AddAccessRule($rule)
}
[System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]::new($p),$acl)`;
function acl(path: string, unsafe = false) {
  if (process.platform !== 'win32') { chmodSync(path, unsafe ? 0o755 : 0o700); return; }
  const result = spawnSync('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', fixtureAcl], { env: { ...process.env, PRIVACY_FIXTURE: path, PRIVACY_UNSAFE: unsafe ? '1' : '0' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, `Could not set disposable fixture ACL: ${result.stderr.replaceAll(path, '[fixture]')}`);
}
function run(config: string) {
  return spawnSync(process.execPath, [main, '--config', config], { encoding: 'utf8', timeout: 15000 });
}

test('entry refuses insecure runtime before creating SQLite, and does not change existing files', { timeout: 60000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-entry-'));
  try {
    acl(root);
    const config = join(root, 'config.json'), db = join(root, 'store.db');
    const value = { version: 1, profileId: 'privacy', databasePath: db, endpoint: 'http://127.0.0.1:45671', token: 'privacy-secret' };
    writeFileSync(config, JSON.stringify(value));
    acl(root, true);
    const result = run(config);
    assert.equal(result.status, 1); assert.match(result.stderr, /privac|private/i);
    assert.doesNotMatch(result.stderr, /privacy-secret/); assert.equal(existsSync(db), false);
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')), value);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native boundary accepts private fixture and refuses unsafe existing SQLite sidecars', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-files-'));
  try {
    acl(root);
    const { checkConfigPrivacy, prepareDatabase } = await import('../src/store/privacy.ts');
    const config = join(root, 'config.json'), db = join(root, 'store.db');
    writeFileSync(config, '{}');
    checkConfigPrivacy(config);
    prepareDatabase(db);
    assert.equal(existsSync(db), true);
    const sidecar = db + '-wal'; writeFileSync(sidecar, 'existing');
    if (process.platform === 'win32') {
      const result = spawnSync('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $a=[System.Security.AccessControl.FileSecurity]::new(); $a.SetAccessRuleProtection($true,$false); foreach($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544','S-1-1-0')) { $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid),'Read','Allow')) }; [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.FileInfo]::new($env:PRIVACY_FIXTURE),$a)`], { env: { ...process.env, PRIVACY_FIXTURE: sidecar }, timeout: 10000 });
      assert.equal(result.status, 0);
    } else chmodSync(sidecar, 0o644);
    assert.throws(() => prepareDatabase(db));
    assert.equal(readFileSync(sidecar, 'utf8'), 'existing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows ACL owner guard refuses an untrusted owner independently of DACL grants', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-owner-'));
  try {
    acl(root);
    const config = join(root, 'config'), copy = join(root, 'privacy.ts');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(config, '{}');
    const source = readFileSync(fileURLToPath(new URL('../src/store/privacy.ts', import.meta.url)), 'utf8');
    const owner = '$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value';
    assert.ok(source.includes(owner));
    writeFileSync(copy, source.replace(owner, "$owner='S-1-1-0'"));
    const { checkConfigPrivacy } = await import(pathToFileURL(copy).href);
    assert.throws(() => checkConfigPrivacy(config), /ACL inspection/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native boundary refuses hard-linked configuration, database, and sidecar', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-links-'));
  try {
    acl(root);
    const { checkConfigPrivacy, prepareDatabase } = await import('../src/store/privacy.ts');
    const config = join(root, 'config'), db = join(root, 'db'), alias = join(root, 'alias');
    writeFileSync(config, JSON.stringify({ version: 1, profileId: 'privacy', databasePath: db, endpoint: 'http://127.0.0.1:45671', token: 'privacy-secret' })); linkSync(config, alias);
    assert.throws(() => checkConfigPrivacy(config));
    const result = run(config); assert.equal(result.status, 1); assert.match(result.stderr, /privacy/i); assert.equal(existsSync(db), false);
    unlinkSync(alias);
    writeFileSync(db, '', { mode: 0o600 }); linkSync(db, alias);
    assert.throws(() => prepareDatabase(db)); unlinkSync(alias);
    const sidecar = db + '-journal'; writeFileSync(sidecar, '', { mode: 0o600 }); linkSync(sidecar, alias);
    assert.throws(() => prepareDatabase(db));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('POSIX boundary rejects symlink config and unsafe database mode', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-posix-'));
  try {
    const { checkConfigPrivacy, prepareDatabase } = await import('../src/store/privacy.ts');
    const file = join(root, 'config'), link = join(root, 'link'), db = join(root, 'db');
    writeFileSync(file, '{}'); symlinkSync(file, link); assert.throws(() => checkConfigPrivacy(link));
    writeFileSync(db, 'existing', { mode: 0o644 }); chmodSync(db, 0o644);
    assert.throws(() => prepareDatabase(db)); assert.equal(readFileSync(db, 'utf8'), 'existing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Service startup prepares about ten databases; one PowerShell per path (directory, file, -wal, -shm) made a cold start
// take 9-15 s and miss start.mjs's 15 s readiness window (2026-10-29). Every path is still inspected, in one process.
test('preparing a WAL database inspects its directory and every file in one ACL process', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-batch-'));
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const original = childProcess.spawnSync;
  try {
    acl(root);
    const { prepareDatabase } = await import('../src/store/privacy.ts');
    const db = join(root, 'store.db');
    for (const path of [db, db + '-wal', db + '-shm']) writeFileSync(path, '');
    const inspected: string[][] = [];
    childProcess.spawnSync = ((command: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      inspected.push((options.env?.ASSISTANT_PRIVACY_PATHS ?? '').split('\n'));
      return original(command, args, options as never);
    }) as typeof original;
    syncBuiltinESMExports();
    prepareDatabase(db);
    assert.deepEqual(inspected, [[root, db, db + '-wal', db + '-shm']]);
  } finally {
    childProcess.spawnSync = original; syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows ACL batch rejects an unsafe later sidecar and detects skipping it', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-batch-unsafe-'));
  try {
    acl(root);
    const { prepareDatabase } = await import('../src/store/privacy.ts');
    const db = join(root, 'store.db'), sidecar = db + '-shm', copy = join(root, 'privacy.ts');
    for (const path of [db, db + '-wal', sidecar]) writeFileSync(path, 'existing');
    prepareDatabase(db);
    const result = spawnSync('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $a=[System.Security.AccessControl.FileSecurity]::new(); $a.SetAccessRuleProtection($true,$false); foreach($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544','S-1-1-0')) { $a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid),'Read','Allow')) }; [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.FileInfo]::new($env:PRIVACY_FIXTURE),$a)`], { env: { ...process.env, PRIVACY_FIXTURE: sidecar }, timeout: 10000 });
    assert.equal(result.status, 0, 'Could not set disposable sidecar ACL');
    const refusal = (prepare: (path: string) => void) => assert.throws(() => prepare(db), /ACL inspection/);
    refusal(prepareDatabase);
    const source = readFileSync(fileURLToPath(new URL('../src/store/privacy.ts', import.meta.url)), 'utf8');
    const loop = 'foreach($path in ($env:ASSISTANT_PRIVACY_PATHS -split [char]10)) {';
    assert.equal(source.split(loop).length, 2);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    writeFileSync(copy, source.replace(loop, `${loop}\nif ($path.EndsWith('-shm')) { continue }`));
    const mutant = await import(pathToFileURL(copy).href);
    assert.throws(() => refusal(mutant.prepareDatabase), { code: 'ERR_ASSERTION', message: /Missing expected exception/ });
    assert.equal(readFileSync(sidecar, 'utf8'), 'existing');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// One ACL inspection took 0.3 s idle but 5.6-9.5 s with the CPU saturated by 48 busy processes (2026-10-29), and opening the
// vault runs two to four of them in a row at service startup; the old 10 s kill failed a full unit run as an "untrusted grant".
test('a slow ACL inspection on a busy machine gets time and, if it still times out, is not reported as an untrusted grant', async () => {
  const { ACL_INSPECTION_TIMEOUT_MS, AclInspectionTimeout, aclInspectionFailure } = await import('../src/store/privacy.ts');
  assert.ok(ACL_INSPECTION_TIMEOUT_MS >= 30_000, `a 9.5 s inspection needs headroom, got ${ACL_INSPECTION_TIMEOUT_MS} ms`);
  const timedOut = aclInspectionFailure({ status: null, error: Object.assign(new Error('spawnSync pwsh.exe ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
  assert.ok(timedOut instanceof AclInspectionTimeout, String(timedOut));
  assert.doesNotMatch(timedOut.message, /untrusted/i);
  assert.match(aclInspectionFailure({ status: 1, error: undefined })?.message ?? '', /untrusted/i);
  assert.equal(aclInspectionFailure({ status: 0, error: undefined }), null);
});

test('a new private directory gets the protected owner, SYSTEM and Administrators DACL the privacy check accepts', { timeout: 60000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'privacy-create-'));
  try {
    const { createPrivateDirectory } = await import('../src/store/private-directory.ts');
    const { checkDirectoryPrivacy } = await import('../src/store/privacy.ts');
    const created = join(root, 'created'), fixture = join(root, 'fixture');
    createPrivateDirectory(created);
    checkDirectoryPrivacy(created);
    if (process.platform !== 'win32') return;
    mkdirSync(fixture); acl(fixture);
    const sddl = (path: string) => spawnSync('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Acl -LiteralPath $env:PRIVACY_FIXTURE).GetSecurityDescriptorSddlForm('Access')`], { env: { ...process.env, PRIVACY_FIXTURE: path }, encoding: 'utf8', windowsHide: true }).stdout.trim();
    assert.match(sddl(created), /^D:PAI(\(A;OICI;FA;;;[^)]+\)){3}$/);
    assert.equal(sddl(created), sddl(fixture));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
