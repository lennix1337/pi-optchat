import { closeSync, lstatSync, openSync, type Stats } from 'node:fs';
import { dirname, parse, resolve } from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

// This checks a quiescent, user-controlled directory, not concurrent path replacement.
// Paths arrive newline-separated (a Windows path cannot contain one); any failing path fails the whole inspection.
const windowsAclCheck = `$ErrorActionPreference='Stop'
$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted=@($current,'S-1-5-18','S-1-5-32-544')
foreach($path in ($env:ASSISTANT_PRIVACY_PATHS -split [char]10)) {
$acl=Get-Acl -LiteralPath $path
$sddl=$acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
if (-not $sddl.StartsWith('D:') -or $sddl.Contains('NO_ACCESS_CONTROL')) { throw 'Invalid DACL' }
$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($owner -notin $trusted) { throw 'Untrusted owner' }
foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
 if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) { throw 'Untrusted DACL grant' }
}
}
`;

function inspectPath(path: string, directory: boolean): Stats {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error('Privacy requires regular paths');
  return stat;
}

function rejectLinkedComponents(path: string): void {
  let current = resolve(path);
  const root = parse(current).root;
  while (current !== root) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('Privacy requires paths without links');
    current = dirname(current);
  }
}

// One inspection takes ~0.3 s idle but up to 9.5 s with the CPU saturated, and a vault open runs two to four of them at
// service startup, so a stuck PowerShell is cut off only well past a busy logon.
export const ACL_INSPECTION_TIMEOUT_MS = 60_000;

/** The ACL was never judged: the machine was too busy, so retrying is the remedy, not changing permissions. */
export class AclInspectionTimeout extends Error {}

export function aclInspectionFailure(result: Pick<SpawnSyncReturns<string>, 'status' | 'error'>): Error | null {
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    return new AclInspectionTimeout(`Privacy ACL inspection timed out after ${ACL_INSPECTION_TIMEOUT_MS / 1000} s; permissions were not judged`);
  }
  return result.error || result.status !== 0 ? new Error('Privacy ACL inspection failed or found an untrusted grant') : null;
}

/** One PowerShell for all `paths`: each costs ~0.3 s idle (seconds when busy), and startup prepares about ten databases. */
function checkAcl(paths: string[]): void {
  const result = spawnSync('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsAclCheck], {
    env: { ...process.env, ASSISTANT_PRIVACY_PATHS: paths.join('\n') }, encoding: 'utf8', timeout: ACL_INSPECTION_TIMEOUT_MS, maxBuffer: 16384, windowsHide: true,
  });
  const failure = aclInspectionFailure(result);
  if (failure) throw failure;
}

/** Owner-only checks: on Windows the ACLs of all `paths` in one inspection, elsewhere uid and mode per path. */
type Entry = { path: string; stat: Stats; directory: boolean; privateMode: boolean };
function checkOwnerOnly(entries: Entry[]): void {
  if (process.platform === 'win32') checkAcl(entries.map(entry => entry.path));
  else for (const entry of entries) checkPosixOwnerOnly(entry);
}
function checkPosixOwnerOnly({ stat, directory, privateMode }: Entry): void {
  const modeOk = directory ? (stat.mode & 0o7777) === 0o700 : !privateMode || (stat.mode & 0o7077) === 0;
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid() || !modeOk) throw new Error(`Privacy requires an owner-only ${directory ? 'directory' : 'file'}`);
}
function directoryEntry(path: string): Entry {
  rejectLinkedComponents(path);
  return { path, stat: inspectPath(path, true), directory: true, privateMode: true };
}
function fileEntry(path: string, privateMode: boolean): Entry {
  const stat = inspectPath(path, false);
  if (stat.nlink !== 1) throw new Error('Privacy requires a singly linked file');
  return { path, stat, directory: false, privateMode };
}

function checkDirectory(path: string): void { checkOwnerOnly([directoryEntry(path)]); }
export { checkDirectory as checkDirectoryPrivacy };

export function checkConfigPrivacy(path: string): void {
  checkOwnerOnly([directoryEntry(dirname(path)), fileEntry(path, false)]);
}

/** Creates the database file if absent (owner-only), then checks its directory, the file and any existing sidecar. */
export function prepareDatabase(path: string): void {
  const entries = [directoryEntry(dirname(path))];
  for (const candidate of [path, path + '-journal', path + '-wal', path + '-shm']) {
    try { entries.push(fileEntry(candidate, true)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (candidate === path) {
        // The directory is judged before anything is created in it.
        checkOwnerOnly(entries);
        closeSync(openSync(path, 'wx', 0o600));
        entries.splice(0, entries.length, fileEntry(path, true));
      }
    }
  }
  checkOwnerOnly(entries);
}
