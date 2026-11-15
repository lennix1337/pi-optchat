# Windows whole-process-tree sample (1 s), including fixture grandchildren.
# powershell -File scripts/bench-verify.ps1 baseline [-QueueSecond] | or: -SelfTest
param([string]$Label = 'verify', [switch]$QueueSecond, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OptchatSuiteArgs {
  [DllImport("shell32.dll", SetLastError=true)]
  static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  public static string[] Split(string command) {
    int count; var pointer = CommandLineToArgvW(command, out count);
    if (pointer == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    try {
      var args = new string[count];
      for (int i=0; i<count; i++) args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i*IntPtr.Size));
      return args;
    } finally { LocalFree(pointer); }
  }
}
'@
function Get-SuiteKind($row) {
  if ($row.Name -ne 'node.exe' -or !$row.CommandLine) { return $null }
  $argv = [OptchatSuiteArgs]::Split($row.CommandLine)
  for ($i=1; $i -lt $argv.Length; $i++) {
    $arg = $argv[$i]
    if ($arg -eq '--test') { return 'tests' }
    if ($arg -in @('-e','-p','--eval','--print','--') -or $arg -match '^--(eval|print)=') { return $null }
    if ($arg -in @('--import','--require','-r','--loader','--experimental-loader','--conditions','-C')) { $i++; continue }
    if ($arg.StartsWith('-')) { continue }
    if ($arg -match '(^|[\\/])npm-cli\.js$' -and $i+2 -lt $argv.Length -and $argv[$i+1] -eq 'run' -and $argv[$i+2] -eq 'verify') { return 'verify' }
    return $null # The first script ends Node's options; its source/arguments are not launch flags.
  }
  return $null
}
function Test-Owned($row, $known) {
  return $known.ContainsKey([int]$row.ProcessId) -and $known[[int]$row.ProcessId] -eq $row.CreationDate.ToUniversalTime().Ticks
}
if ($SelfTest) {
  $cases = @(
    @('"C:\Program Files\nodejs\node.exe" --import "./test/support.ts" --test test/*.test.ts', 'tests'),
    @('node -e "console.log(''node --test fake'')"', $null),
    @('node script.mjs --test fake', $null),
    @('node --test-isolation=process test/file.test.ts', $null),
    @('node "C:\npm\npm-cli.js" run verify', 'verify')
  )
  foreach ($case in $cases) {
    if ((Get-SuiteKind @{Name='node.exe';CommandLine=$case[0]}) -ne $case[1]) { throw "Suite argv classification failed: $($case[0])" }
  }
  $born = [DateTime]::UtcNow
  $known = @{7=$born.Ticks}
  if (!(Test-Owned @{ProcessId=7;CreationDate=$born} $known)) { throw 'Original process must belong to the tree' }
  if (Test-Owned @{ProcessId=7;CreationDate=$born.AddSeconds(1)} $known) { throw 'A reused PID must not belong to the tree' }
  Write-Output 'Sampler self-tests passed (argv boundary and PID/start identity)'
  exit 0
}
$busy = @(Get-CimInstance Win32_Process | Where-Object { Get-SuiteKind $_ })
if ($busy.Count) { throw "Another suite is running (PIDs $($busy.ProcessId -join ', ')); wait before measuring." }
$dir = Join-Path ([IO.Path]::GetTempPath()) ('pi-optchat-suite-' + $Label + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $dir | Out-Null
$env:OPTCHAT_SUITE_EVENTS = Join-Path $dir 'events.jsonl'
$oldOptions = $env:NODE_OPTIONS
$reportOptions = ($oldOptions + ' --test-reporter=' + ([Uri](Join-Path $PSScriptRoot 'bench-suite-reporter.mjs')).AbsoluteUri).Trim()
$env:NODE_OPTIONS = $reportOptions
$start = [DateTime]::UtcNow
$proc = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /s /c "npm run verify"' -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $dir 'stdout.log') -RedirectStandardError (Join-Path $dir 'stderr.log')
$null = $proc.Handle
$env:NODE_OPTIONS = $oldOptions
$pendingRoots = [Collections.Generic.HashSet[int]]::new()
$null = $pendingRoots.Add($proc.Id)
$known = @{} # PID -> creation time, never PID alone (Windows reuses PIDs within a suite).
$cpu = @{}
$peakCpu = 0.0; $peakRam = 0L
$last = $start
$samples = [Collections.Generic.List[object]]::new()
$foreign = @{}; $reused = @{}
$gameSeen = $false
$second = $null; $secondStart = $null; $firstWall = $null
$maxActiveRunners = 0
do {
  $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize,Name,CommandLine)
  $active = @{}
  foreach ($row in $rows) {
    $active[[int]$row.ProcessId] = $row.CreationDate.ToUniversalTime().Ticks
    if ($pendingRoots.Remove([int]$row.ProcessId)) { $known[[int]$row.ProcessId] = $active[[int]$row.ProcessId] }
    if ($known.ContainsKey([int]$row.ProcessId) -and !(Test-Owned $row $known)) { $reused["$($row.ProcessId):$($row.CreationDate.Ticks)"] = [int]$row.ProcessId }
  }
  do {
    $added = $false
    foreach ($row in $rows) {
      $parent = [int]$row.ParentProcessId
      $parentOwned = $known.ContainsKey($parent) -and $known[$parent] -le $row.CreationDate.ToUniversalTime().Ticks -and (!$active.ContainsKey($parent) -or $active[$parent] -eq $known[$parent])
      if ($row.CreationDate.ToUniversalTime() -ge $start -and $parentOwned -and !(Test-Owned $row $known)) {
        $known[[int]$row.ProcessId] = $active[[int]$row.ProcessId]; $added = $true
      }
    }
  } while ($added)
  $runnerPids = @()
  foreach ($row in $rows) {
    if ($row.Name -match 'PathOfExile') { $gameSeen = $true }
    $kind = Get-SuiteKind $row
    if (!$kind) { continue }
    if (Test-Owned $row $known) {
      if ($kind -eq 'tests') { $runnerPids += [int]$row.ProcessId }
    } else { $foreign["$($row.ProcessId):$($row.CreationDate.Ticks)"] = @{pid=[int]$row.ProcessId;parent=[int]$row.ParentProcessId;start=$row.CreationDate.ToUniversalTime().ToString('o');kind=$kind} }
  }
  $maxActiveRunners = [Math]::Max($maxActiveRunners, $runnerPids.Count)
  if ($QueueSecond -and !$second -and $runnerPids.Count -gt 0) {
    $env:NODE_OPTIONS = $reportOptions
    $secondStart = [DateTime]::UtcNow
    $second = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /s /c "npm run verify"' -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $dir 'second.stdout.log') -RedirectStandardError (Join-Path $dir 'second.stderr.log')
    $null = $second.Handle
    $env:NODE_OPTIONS = $oldOptions
    $null = $pendingRoots.Add($second.Id)
  }
  $now = [DateTime]::UtcNow
  $delta = 0.0; $ram = 0L; $count = 0
  foreach ($row in $rows) {
    if (!(Test-Owned $row $known)) { continue }
    $key = "$($row.ProcessId):$($row.CreationDate.Ticks)"
    $total = ([double]$row.KernelModeTime + [double]$row.UserModeTime) / 10000000
    if ($cpu.ContainsKey($key)) { $delta += $total - $cpu[$key] } else { $delta += $total }
    $cpu[$key] = $total
    $ram += [long]$row.WorkingSetSize; $count++
  }
  $percent = 100 * $delta / (($now - $last).TotalSeconds * [Environment]::ProcessorCount)
  $peakCpu = [Math]::Max($peakCpu, $percent); $peakRam = [Math]::Max($peakRam, $ram)
  $samples.Add(@{seconds=($now-$start).TotalSeconds;cpuPercent=$percent;workingSetBytes=$ram;processes=$count;activeRunnerPids=$runnerPids})
  $last = $now
  if ($proc.HasExited -and $null -eq $firstWall) { $firstWall = ($now - $start).TotalSeconds }
  if (!$proc.HasExited -or ($second -and !$second.HasExited)) { Start-Sleep -Seconds 1 }
} while (!$proc.HasExited -or ($second -and !$second.HasExited))
$proc.WaitForExit()
if ($null -eq $firstWall) { $firstWall = ([DateTime]::UtcNow - $start).TotalSeconds }
if ($second) { $second.WaitForExit() }
$result = @{command='npm run verify';label=$Label;wallSeconds=([DateTime]::UtcNow-$start).TotalSeconds;peakCpuPercent=$peakCpu;peakWorkingSetBytes=$peakRam;logicalProcessors=[Environment]::ProcessorCount;exitCode=$proc.ExitCode;samples=$samples;foreignSuites=@($foreign.Values);reusedPids=@($reused.Values);pathOfExileSeen=$gameSeen;maxActiveTestRunners=$maxActiveRunners;firstWallSeconds=$firstWall;secondWallSeconds=$(if ($secondStart) { ([DateTime]::UtcNow-$secondStart).TotalSeconds } else { $null });secondExitCode=$(if ($second) { $second.ExitCode } else { $null })}
$result | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $dir 'metrics.json')
$result.Remove('samples')
$result['reusedPidCount'] = $result.reusedPids.Count
$result.Remove('reusedPids')
$result | ConvertTo-Json
Write-Output "Evidence: $dir"
if ($second -and $second.ExitCode -ne 0) { exit $second.ExitCode }
exit $proc.ExitCode
