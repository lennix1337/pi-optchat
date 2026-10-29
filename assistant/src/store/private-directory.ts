import { mkdirSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Protect only a directory this call created; existing paths are left for the privacy precheck. */
export function createPrivateDirectory(path: string): void {
  if (!isAbsolute(path)) throw new TypeError('Private directory path must be absolute');
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return; throw error; }
  if (process.platform !== 'win32') return;
  const script = `$ErrorActionPreference='Stop'; $acl=[System.Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); foreach($sid in @([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')) { $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow')) }; [System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]::new($env:OPTCHAT_MEMORY_DIRECTORY),$acl)`;
  const result = spawnSync('C:/Program Files/PowerShell/7/pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, OPTCHAT_MEMORY_DIRECTORY: path }, timeout: 60_000, encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Could not initialize the new private directory. Existing permissions were not changed.');
}
