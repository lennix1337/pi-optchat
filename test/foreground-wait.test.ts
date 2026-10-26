import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { foregroundWait, registerForegroundWaitGuard } from '../src/foreground-wait.ts';

// Commands taken from session 01a1704e, where 56 foreground waits cost 38 minutes.
test('long sleeps, polling loops and watch commands are foreground waits', () => {
  for (const command of [
    'sleep 240; tail -c 600 C:/tmp/gx-issues/gates-all/gateway-tests.log',
    'cd C:/projetos/pi-optchat && sleep 30; gh run list --repo lennix1337/pi-optchat --limit 2',
    'gh pr merge 673 --merge | tail -2; sleep 15; gh pr view 673',
    'sleep 10; gh run view 1; sleep 10; gh run view 1',
    'sleep 1m; ls',
    'for i in $(seq 1 40); do s=$(gh run view 40161102776 --json status -q .status); [ "$s" = completed ] && break; sleep 10; done',
    "timeout 1500 bash -c 'while :; do a=$(gh pr checks 676 | grep -c pending); [ $a = 0 ] && break; sleep 30; done'",
    'gh run watch 40194703121 --repo lennix1337/Genexus18MCP --exit-status --interval 20',
    'gh pr checks 685 --watch',
    'powershell -NoProfile -Command "Start-Sleep -Seconds 60; Get-Process"',
  ]) assert.ok(foregroundWait(command), command);
});

test('short readiness waits and ordinary commands are not', () => {
  for (const command of [
    'sleep 2 && curl -s localhost:3000/health',
    'cd C:/Projetos/Genexus18MCP && sleep 10 && gh run rerun 40161102776 --failed',
    'for i in $(seq 1 40); do docker info >/dev/null 2>&1 && break; sleep 1; done',
    'for i in $(seq 1 24); do docker info --format x && break; sleep 5; done',
    'for p in 685 686 687; do gh pr merge $p --merge; sleep 5; gh pr view $p --json state; done',
    'timeout 600 npm test > /c/tmp/t.txt 2>&1; echo rc=$?',
    'grep -n "sleep 30" src/prompts.ts',
    'for r in a b c; do git -C $r status --short; done',
    "cat > /c/tmp/x.sh <<'EOF'\nwhile true; do sleep 60; done\nEOF\nchmod +x /c/tmp/x.sh",
    'gh run view 123 --log | grep watch',
  ]) assert.equal(foregroundWait(command), undefined, command);
});

function harness(active: string[] = ['bash', 'shell_start']) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const pi = { on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, handler); }, getActiveTools: () => active } as unknown as ExtensionAPI;
  registerForegroundWaitGuard(pi);
  return (command: string, toolName = 'bash') => hooks.get('tool_call')!({ toolName, toolCallId: 'c', input: { command } }, {}) as { block: true; reason: string } | undefined;
}

test('the guard blocks a foreground wait before it runs and points to shell_start', () => {
  const call = harness();
  const blocked = call('sleep 45; gh pr checks 685');
  assert.equal(blocked?.block, true);
  assert.match(blocked!.reason, /shell_start/);
  assert.match(blocked!.reason, /45 s/);
  assert.equal(call('sleep 2 && ls'), undefined);
  assert.equal(call('sleep 45', 'shell_start'), undefined, 'a background shell may wait');
});

test('without shell_start there is no alternative, so the wait runs', () => {
  assert.equal(harness(['bash'])('sleep 45; gh pr checks 685'), undefined);
});
