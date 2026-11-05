import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { bashMangledPowerShell, registerPowerShellQuotingGuard } from '../src/powershell-quoting.ts';

test('PowerShell variables inside bash double quotes are caught before bash expands them', () => {
  const mangled: [string, string][] = [
    // The two calls of 03/11 that returned nothing.
    [String.raw`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -match 'x' } | Select-Object ProcessId"`, '$_'],
    [String.raw`powershell -NoProfile -Command "Get-Process | ForEach-Object { $p = $_; $p.Id }"`, '$_'],
    ['pwsh -c "$env:PATH"', '$env:'],
    ['powershell.exe -Command "if ($true) { 1 }"', '$true'],
    ['powershell -Command "Write-Output $(Get-Date)"', '$('],
    ['powershell -Command "$proc.Kill()"', '$proc'],
    ['cd x && powershell -NoProfile -Command "$a[0]"', '$a'],
    ['powershell -Command "$PSItem"', '$PSItem'],
  ];
  for (const [command, variable] of mangled) assert.equal(bashMangledPowerShell(command), variable, command);
});

test('scripts bash leaves alone, and bash variables meant for bash, are not refused', () => {
  const fine = [
    'powershell -NoProfile -ExecutionPolicy Bypass -File "C:/Users/x/Temp/probe.ps1"; echo rc=$?',
    "powershell -NoProfile -Command 'Get-Process | Where-Object { $_.CPU -gt 10 }'",
    String.raw`powershell -NoProfile -Command "Get-Process | Where-Object { \$_.CPU -gt 10 }"`,
    'powershell -NoProfile -Command "Stop-Process -Id $PID_TO_STOP"',
    'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'NODE_OPTIONS\',\'User\')"',
    'echo "$_.x" ; ls',
    "cat > probe.ps1 <<'EOF'\nGet-Process | Where-Object { $_.CPU -gt 10 }\nEOF\npowershell -File probe.ps1",
    'echo "powershell" "$_.x"',
    // 05/11: the word inside a grep pattern is text, not a call; the later "$((...))" belongs to bash.
    'cd C:/projetos; s=$(date +%s%N); grep -rln "before PowerShell starts" pi-* | wc -l; echo "grep rc=$? $(( ($(date +%s%N)-s)/1000000 ))ms"; s=$(date +%s%N); rg -l "before PowerShell starts" pi-* | wc -l; echo "rg $(( ($(date +%s%N)-s)/1000000 ))ms"',
    "grep -n 'run pwsh -c here' notes.md; echo \"$(date)\"; echo \"$(whoami)\"",
  ];
  for (const command of fine) assert.equal(bashMangledPowerShell(command), undefined, command);
});

test('the bash hook refuses a mangled call with the .ps1 route and ignores other tools', async () => {
  let hook: ((event: unknown) => unknown) | undefined;
  registerPowerShellQuotingGuard({ on(_name: string, handler: (event: unknown) => unknown) { hook = handler; } } as unknown as ExtensionAPI);
  const refused = await hook!({ toolName: 'bash', input: { command: 'powershell -Command "Get-Process | % { $_.Id }"' } }) as { block: boolean; reason: string };
  assert.equal(refused.block, true);
  assert.match(refused.reason, /bash expands \$_ .*-File/);
  assert.equal(await hook!({ toolName: 'bash', input: { command: "powershell -Command 'Get-Process | % { $_.Id }'" } }), undefined);
  assert.equal(await hook!({ toolName: 'write', input: { command: 'powershell -Command "$_"' } }), undefined);
});
