import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { packagePiiGuard, registerPackagePiiGuard } from '../src/package-pii-guard.ts';

const number = '55' + '1'.repeat(11);
const projects = join(homedir(), 'projetos');
const cwd = join(projects, 'pi-demo');
const edit = (path: string, text: string) => ({ name: 'edit', arguments: { path, edits: [{ oldText: '', newText: text }] } });

test('refuses an edit once per identical call, and refuses a different call', () => {
  const guard = packagePiiGuard();
  const call = edit('src/a.ts', number + '@s.whatsapp.net');
  assert.match(guard.check(call, cwd) ?? '', /Não executado:.*(?:falso|config)/);
  assert.equal(guard.check(call, cwd), undefined);
  assert.ok(guard.check(edit('src/b.ts', number), cwd));
});

test('write and heredoc into a package are refused', () => {
  const guard = packagePiiGuard();
  assert.ok(guard.check({ name: 'write', arguments: { path: 'README.md', content: number } }, cwd));
  assert.ok(guard.check({ name: 'bash', arguments: { command: `cat > test/a.ts <<'EOF'\n${number}\nEOF` } }, cwd));
  assert.ok(guard.check({ name: 'bash', arguments: { command: `cat <<EOF > ${cwd}/a\n${number}\nEOF` } }, '/tmp'));
  assert.ok(guard.check({ name: 'bash', arguments: { command: `cd ${cwd} && cat > a <<EOF\n${number}\nEOF` } }, '/tmp'));
  assert.ok(guard.check({ name: 'bash', arguments: { command: `cat > ~/projetos/pi-demo/a <<EOF\n${number}\nEOF` } }, '/tmp'));
});

test('fake numbers, old text, non-writes and excluded destinations pass', () => {
  const guard = packagePiiGuard();
  assert.equal(guard.check(edit('a.ts', '5500000000000'), cwd), undefined);
  assert.equal(guard.check({ name: 'edit', arguments: { path: 'a.ts', edits: [{ oldText: number, newText: 'removed' }] } }, cwd), undefined);
  assert.equal(guard.check({ name: 'bash', arguments: { command: `echo ${number}` } }, cwd), undefined);
  assert.equal(guard.check(edit(join(projects, 'dotfiles/a'), number), cwd), undefined);
  assert.equal(guard.check(edit(join(projects, 'dentai-mono/a'), number), cwd), undefined);
  assert.equal(guard.check(edit('/tmp/a', number), cwd), undefined);
  assert.equal(guard.check(edit('/tmp/projetos/pi-demo/a', number), cwd), undefined);
});

test('registration uses session cwd and can be disabled', () => {
  const handlers: Record<string, (event: any, ctx: any) => any> = {};
  const pi = { on: (event: string, handler: (event: any, ctx: any) => unknown) => { handlers[event] = handler; } };
  const prior = process.env.OPTCHAT_PACKAGE_PII;
  try {
    process.env.OPTCHAT_PACKAGE_PII = 'off';
    registerPackagePiiGuard(pi);
    assert.equal(handlers.tool_call, undefined);
    delete process.env.OPTCHAT_PACKAGE_PII;
    registerPackagePiiGuard(pi);
    const handler = handlers['tool_call'] as (event: any, ctx: any) => any;
    assert.equal(handler({ toolName: 'write', input: { path: 'a.ts', content: number } }, { cwd }).block, true);
  } finally {
    if (prior === undefined) delete process.env.OPTCHAT_PACKAGE_PII; else process.env.OPTCHAT_PACKAGE_PII = prior;
  }
});
