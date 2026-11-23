import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRipwireFirst, ripwireFirstGuard } from '../src/ripwire-first-guard.ts';

test('refuses the first source write once, then lets the retry through', () => {
  const guard = ripwireFirstGuard();
  assert.match(guard.check({ name: 'edit', arguments: { path: '/repo/src/a.ts' } }) ?? '', /^Não executado:.*ripwire/);
  assert.equal(guard.check({ name: 'edit', arguments: { path: '/repo/src/a.ts' } }), undefined);
});

test('a ripwire call first lifts the refusal', () => {
  const guard = ripwireFirstGuard();
  assert.equal(guard.check({ name: 'ripwire', arguments: { action: 'search' } }), undefined);
  assert.equal(guard.check({ name: 'write', arguments: { path: '/repo/src/a.ts' } }), undefined);
  const cli = ripwireFirstGuard();
  assert.equal(cli.check({ name: 'bash', arguments: { command: 'ripwire --impact foo' } }), undefined);
  assert.equal(cli.check({ name: 'bash', arguments: { command: 'sed -i s/a/b/ x.ts' } }), undefined);
});

test('reads, notes and scratch files never trigger it', () => {
  const guard = ripwireFirstGuard();
  for (const call of [{ name: 'read', arguments: { path: '/repo/a.ts' } }, { name: 'write', arguments: { path: '/tmp/x.ts' } }, { name: 'edit', arguments: { path: '/repo/NOTES.md' } }, { name: 'bash', arguments: { command: 'git status' } }])
    assert.equal(guard.check(call), undefined);
});

test('sed -i on a scratch file under /tmp is not a source write; on a repo file it is', () => {
  assert.equal(ripwireFirstGuard().check({ name: 'bash', arguments: { command: "sed -i 's/a/b/g' /tmp/apphome.ps1 && scp -q /tmp/apphome.ps1 pc:x" } }), undefined);
  assert.match(ripwireFirstGuard().check({ name: 'bash', arguments: { command: "sed -i 's/a/b/' src/a.ts" } }) ?? '', /^Não executado/);
  assert.match(ripwireFirstGuard().check({ name: 'bash', arguments: { command: "sed -i 's/a/b/' /tmp/x.ts src/a.ts" } }) ?? '', /^Não executado/);
});

test('scratch scripts in /tmp and system config are not source writes; repo files still are', () => {
  const pass = [
    "cd /tmp && python3 - <<'EOF'\ns=open('/tmp/tab.mjs').read()\nopen('/tmp/tab.mjs','w').write(s)\nEOF",
    "cd /tmp && cat > ga.py <<'EOF'\nprint(1)\nEOF\npython3 ga.py; rm -f ga.py",
    "sudo sed -i 's#a#b#' /etc/apparmor.d/playwright-chrome && sudo apparmor_parser -r /etc/apparmor.d/playwright-chrome",
  ];
  for (const command of pass) assert.equal(ripwireFirstGuard().check({ name: 'bash', arguments: { command } }), undefined, command);
  const block = [
    "python3 - <<'EOF'\np='src/a.json'\nopen(p,'w').write('x')\nEOF",
    "cd /tmp && cat > /home/u/repo/src/a.ts <<'EOF'\nx\nEOF",
    "cat > src/a.py <<'EOF'\nx\nEOF",
  ];
  for (const command of block) assert.match(ripwireFirstGuard().check({ name: 'bash', arguments: { command } }) ?? '', /^Não executado/, command);
});

test('the tool_call hook refuses the first edit of a run and a new input starts a new run', async () => {
  const hooks = new Map<string, (...args: any[]) => any>();
  registerRipwireFirst({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } }, { perInput: true });
  const edit = () => hooks.get('tool_call')!({ toolName: 'edit', input: { path: '/repo/src/a.ts' } }, { cwd: '/tmp' });
  assert.equal((await edit()).block, true);
  assert.equal(await edit(), undefined);
  hooks.get('input')!({ text: 'next', source: 'interactive' }, {});
  assert.equal((await edit()).block, true);
});

test('a heartbeat wake starts a new run: the first source write is refused again; a worker notice does not', () => {
  const hooks = new Map<string, (event: any, ctx?: any) => unknown>();
  registerRipwireFirst({ on: (name, handler) => { hooks.set(name, handler); } }, { perInput: true });
  const write = () => hooks.get('tool_call')!({ toolName: 'edit', input: { path: '/repo/src/a.ts' } }) as { block?: boolean } | undefined;
  hooks.get('tool_call')!({ toolName: 'ripwire', input: { action: 'search' } });
  hooks.get('before_agent_start')!({ messageType: 'custom', message: { customType: 'optchat-report', content: '[shell abc] completed' } });
  assert.equal(write(), undefined, 'a notice mid-run keeps the run');
  hooks.get('before_agent_start')!({ messageType: 'custom', message: { customType: 'optchat-report', content: '[OptChat heartbeat] You have been idle for 30 min' } });
  assert.equal(write()?.block, true, 'a wake is a new run and needs ripwire again');
});
