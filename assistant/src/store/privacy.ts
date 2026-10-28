import { closeSync, lstatSync, openSync, type Stats } from 'node:fs';
import { dirname, parse, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// This checks a quiescent, user-controlled directory, not concurrent path replacement.
const windowsAclCheck = `$ErrorActionPreference='Stop'
$acl=Get-Acl -LiteralPath $env:ASSISTANT_PRIVACY_PATH
$sddl=$acl.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
if (-not $sddl.StartsWith('D:') -or $sddl.Contains('NO_ACCESS_CONTROL')) { throw 'Invalid DACL' }
$current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted=@($current,'S-1-5-18','S-1-5-32-544')
$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($owner -notin $trusted) { throw 'Untrusted owner' }
foreach($rule in $acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
 if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) { throw 'Untrusted DACL grant' }
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

function checkAcl(path: string): void {
  const result = spawnSync('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsAclCheck], {
    env: { ...process.env, ASSISTANT_PRIVACY_PATH: path }, encoding: 'utf8', timeout: 10000, maxBuffer: 16384, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('Privacy ACL inspection failed or found an untrusted grant');
}

function checkDirectory(path: string): void {
  rejectLinkedComponents(path);
  const stat = inspectPath(path, true);
  if (process.platform === 'win32') { checkAcl(path); return; }
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) throw new Error('Privacy requires an owner-only directory');
}

function checkFile(path: string, privateMode: boolean): void {
  const stat = inspectPath(path, false);
  if (stat.nlink !== 1) throw new Error('Privacy requires a singly linked file');
  if (process.platform === 'win32') { checkAcl(path); return; }
  if (typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (privateMode && (stat.mode & 0o7077) !== 0)) throw new Error('Privacy requires an owner-only file');
}

export function checkConfigPrivacy(path: string): void {
  checkDirectory(dirname(path));
  checkFile(path, false);
}

export function prepareDatabase(path: string): void {
  checkDirectory(dirname(path));
  for (const candidate of [path, path + '-journal', path + '-wal', path + '-shm']) {
    try { checkFile(candidate, true); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (candidate === path) {
        const fd = openSync(path, 'wx', 0o600);
        closeSync(fd);
        checkFile(path, true);
      }
    }
  }
}
