import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEffects, runsDeploy } from '../src/effect-classifier.ts';

const noRepo = { slug: () => undefined, branch: () => undefined };

// The shape of a real call: the deploy script was written to the PC beforehand and started by a scheduled task over ssh.
const scheduled = `printf '%s' "$TOKEN" | ssh -o ConnectTimeout=10 pc "powershell -NoProfile -Command \\"[IO.File]::WriteAllText('x', 'y')\\"" && ssh pc "schtasks /create /f /tn PiDeploy-45c38dad /sc once /st 23:59 /it /rl LIMITED /tr \\"conhost.exe --headless cmd /c %TEMP%\\\\deploy-45c.cmd\\" && schtasks /run /tn PiDeploy-45c38dad" 2>&1 | tail -2; echo rc=\${PIPESTATUS[0]}`;

test('a deploy relayed through ssh, a scheduled task, conhost or cmd /c is still a deploy', () => {
  assert.equal(runsDeploy(scheduled), true, 'ssh -> schtasks /tr -> conhost -> cmd /c -> deploy-*.cmd');
  assert.equal(runsDeploy('ssh pc "pwsh -File C:\\\\projetos\\\\dentai-mono\\\\scripts\\\\release\\\\deploy-web.ps1 -Commit abc"'), true);
  assert.equal(runsDeploy('ssh -i key -p 22 pc "cmd /c %TEMP%\\\\deploy-45c.cmd"'), true);
  assert.equal(runsDeploy('schtasks /create /tn X /tr "pwsh -File scripts/release/deploy-changed.ps1 -PolicyFile p.json"'), true);
});

test('the same relays around harmless or plan-only commands stay free of deploy', () => {
  assert.equal(runsDeploy('ssh pc "type C:\\\\projetos\\\\dentai-mono\\\\scripts\\\\release\\\\deploy-web.ps1"'), false, 'reading the script');
  assert.equal(runsDeploy('ssh pc "pwsh -File scripts/release/deploy-web.ps1 -Commit abc -PlanOnly"'), false, 'plan only');
  assert.equal(runsDeploy('ssh pc "dir C:\\\\KBs"'), false);
  assert.equal(runsDeploy('schtasks /query /tn PiDeploy-45c38dad'), false);
  assert.equal(runsDeploy('cmd /c dir'), false);
});

test('a codemode script handing the relayed deploy to vault_run is classified as a deploy', () => {
  const code = `return await tools.vault_run({command: ${JSON.stringify(scheduled)}, secrets: ["CLOUDFLARE_DENTAI_TOKEN"], timeoutMs: 60000});`;
  const effects = classifyEffects({ tool: 'codemode', input: { code }, cwd: '/home/ubuntu' }, noRepo);
  assert.ok(effects.some(effect => effect.action === 'deploy'), JSON.stringify(effects));
});
