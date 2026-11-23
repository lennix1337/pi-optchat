import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerSelfBuildGuard } from '../src/self-build-guard.ts';

function fixture() {
  const hooks = new Map<string, (...args: any[]) => any>();
  registerSelfBuildGuard({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } }, { perInput: true });
  return {
    input: (text: string) => hooks.get('input')?.({ text }, {}),
    start: () => hooks.get('session_start')?.({}, {}),
    report: (content: string) => hooks.get('before_agent_start')?.({ messageType: 'custom', message: { customType: 'optchat-report', content } }, {}),
    call: (toolName: string, input: Record<string, unknown> = {}) => hooks.get('tool_call')?.({ toolName, input }, {}),
    hooks,
  };
}
const wake = '[OptChat heartbeat] check';
const write = (f: ReturnType<typeof fixture>) => f.call('edit', { path: '/repo/src/a.ts' });

test('third source write in wake is blocked once', () => {
  const f = fixture(); f.input(wake);
  assert.equal(write(f), undefined); assert.equal(write(f), undefined);
  assert.match(f.call('write', { path: '/repo/a.ts' })?.reason ?? '', /^Não executado:.*worker/);
  assert.equal(f.call('bash', { command: 'sed -i s/a/b/ a.ts' }), undefined);
  assert.equal(write(f), undefined);
});

test('handoffs reset the count without undoing a refusal', () => {
  for (const [name, input] of [['spawn', {}], ['tell', {}], ['bash', { command: 'node ~/.pi/agent/bin/agy-pc.mjs run' }], ['bash', { command: 'node /tmp/agy-worker.mjs run' }]] as const) {
    const f = fixture(); f.input(wake); write(f); write(f); f.call(name, input);
    assert.equal(write(f), undefined); assert.equal(write(f), undefined);
    assert.match(write(f)?.reason ?? '', /^Não executado:/);
    f.call(name, input); assert.equal(write(f), undefined); assert.equal(write(f), undefined); assert.equal(write(f), undefined);
  }
});

test('non-wake input and session start do not count', () => {
  const f = fixture(); f.input('operator'); for (let i = 0; i < 5; i++) assert.equal(write(f), undefined);
  f.input(wake); write(f); f.start(); for (let i = 0; i < 5; i++) assert.equal(write(f), undefined);
  f.input(wake); write(f); f.input('operator'); for (let i = 0; i < 5; i++) assert.equal(write(f), undefined);
});

test('heartbeat custom report starts a guarded run', () => {
  const f = fixture(); f.report(wake); write(f); write(f);
  assert.match(write(f)?.reason ?? '', /^Não executado:/);
  f.report('other report'); for (let i = 0; i < 4; i++) assert.equal(write(f), undefined);
});

test('environment switch disables hooks', () => {
  const previous = process.env.OPTCHAT_SELF_BUILD_GUARD;
  try { process.env.OPTCHAT_SELF_BUILD_GUARD = 'off'; assert.equal(fixture().hooks.size, 0); }
  finally { if (previous === undefined) delete process.env.OPTCHAT_SELF_BUILD_GUARD; else process.env.OPTCHAT_SELF_BUILD_GUARD = previous; }
});

test('non-source calls and agy help do not reset', () => {
  const f = fixture(); f.input(wake); write(f); write(f);
  f.call('write', { path: '/tmp/a.ts' }); f.call('bash', { command: 'node agy-pc.mjs --help' });
  assert.match(write(f)?.reason ?? '', /^Não executado:/);
});

test('a refusal is not repeatable once the source written passes a few lines', () => {
  const f = fixture(); f.input(wake); write(f); write(f);
  assert.match(f.call('write', { path: '/repo/a.ts', content: 'x' })?.reason ?? '', /poucas linhas/);
  assert.equal(write(f), undefined);
  const big = Array.from({ length: 70 }, (_, i) => `line ${i}`).join('\n');
  assert.match(f.call('write', { path: '/repo/b.ts', content: big })?.reason ?? '', /mais de 60 linhas/);
  assert.match(write(f)?.reason ?? '', /mais de 60 linhas/);
  f.call('spawn', {});
  assert.equal(write(f), undefined); assert.equal(write(f), undefined);
});
