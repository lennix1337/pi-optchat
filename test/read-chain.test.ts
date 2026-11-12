import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onlyReads } from '../src/crew.ts';
import { BATCH_HINT, ReadChain, isReadOnlyCall, registerReadChainHint } from '../src/read-chain.ts';

const bash = (command: string) => ({ name: 'bash', input: { command } });

test('read-only calls: the named tools, the reading actions of crew, commitments, gitwatch and lsp', () => {
  for (const name of ['read', 'read_many', 'zoom', 'date', 'output_read', 'project_evidence', 'shell_status', 'ripwire'])
    assert.equal(isReadOnlyCall({ name, input: {} }), true, name);
  for (const action of ['list', 'read', 'view', 'zoom']) assert.equal(isReadOnlyCall({ name: 'crew', input: { action } }), true, `crew ${action}`);
  for (const action of ['write', 'audit', undefined]) assert.equal(isReadOnlyCall({ name: 'crew', input: { action } }), false, `crew ${action}`);
  assert.equal(isReadOnlyCall({ name: 'commitments', input: { action: 'list' } }), true);
  for (const action of ['add', 'update']) assert.equal(isReadOnlyCall({ name: 'commitments', input: { action } }), false, `commitments ${action}`);
  assert.equal(isReadOnlyCall({ name: 'gitwatch', input: {} }), true, 'gitwatch defaults to status');
  assert.equal(isReadOnlyCall({ name: 'gitwatch', input: { action: 'status' } }), true);
  assert.equal(isReadOnlyCall({ name: 'gitwatch', input: { action: 'watch', repo: 'a/b' } }), false);
  for (const action of ['references', 'definition', 'hover', 'diagnostics', 'symbols']) assert.equal(isReadOnlyCall({ name: 'lsp', input: { action } }), true, `lsp ${action}`);
  assert.equal(isReadOnlyCall({ name: 'lsp', input: { action: 'rename' } }), false);
  for (const name of ['edit', 'write', 'slack_send', 'spawn', 'shell_start', 'powershell', 'self_reload', 'unknown_tool']) assert.equal(isReadOnlyCall({ name, input: {} }), false, name);
  assert.equal(isReadOnlyCall({ name: 'crew' }), false, 'no input, no action');
});

test('bash is read-only only when every part of the command plainly reads', () => {
  const reads = ['ls -la', 'cat package.json', 'head -5 a | wc -l', 'tail -n 20 log', "sed -n '1,20p' a.ts", 'grep -rn foo src', 'rg bar && ls', 'git log --oneline -5', 'git status --short', 'git diff --stat 2>&1 | head',
    'git show HEAD:a.ts', 'git branch -a', 'git branch', 'git rev-parse --show-toplevel', 'git -C C:/x rev-parse HEAD', 'gh pr view 12', 'gh issue list', 'gh pr status', 'find . -name "*.ts"', 'date'];
  for (const command of reads) assert.equal(isReadOnlyCall(bash(command)), true, command);
  const writes = ['npm test', 'cat a > b', 'cat a >> b', 'ls > out.txt', 'sed -i s/a/b/ f', 'rm -rf x', 'git commit -m x', 'git push', 'git branch -D x', 'git branch new-feature', 'git checkout main', 'gh pr merge 3', 'gh pr create',
    'find . -delete', 'find . -name a -exec rm {} ;', 'find . -type f -execdir rm {} +', 'find . -fprint0 out', 'find . -fprintf out %p', 'ls && make clean', 'cat a; npm test', 'cat a | tee out', 'cat $(make)', 'echo `rm x`', 'node -e "1"', 'git diff --output=o.patch', 'xargs rm', ''];
  for (const command of writes) assert.equal(isReadOnlyCall(bash(command)), false, `write: ${command}`);
  assert.equal(isReadOnlyCall({ name: 'bash', input: {} }), false, 'no command');
  assert.equal(isReadOnlyCall({ name: 'bash', input: { command: 5 } }), false, 'a non-string command');
});

test('the hint classifies shell commands with onlyReads', () => {
  for (const command of ['find . -name x', 'git rev-parse HEAD', 'git branch -a', 'date', 'gh pr status', 'find . -delete', 'git branch -D x']) assert.equal(isReadOnlyCall(bash(command)), onlyReads(command), command);
});

test('a chain hints at its second lone read, once, and a batch or a write starts it over', () => {
  const chain = new ReadChain();
  const read = (id: string) => ({ id, name: 'read', input: {} });
  const hints = (calls: { id: string; name: string; input?: unknown }[]) => { chain.turn(calls); return calls.filter(call => chain.claim(call.id, call.name)).map(call => call.id); };
  assert.deepEqual(hints([read('a')]), [], 'one read is not a chain');
  assert.deepEqual(hints([read('b')]), ['b'], 'the second lone read');
  assert.deepEqual(hints([read('c')]), [], 'not repeated in the same chain');
  assert.deepEqual(hints([read('d')]), []);
  assert.deepEqual(hints([read('e'), read('f')]), [], 'a batch resets');
  assert.deepEqual(hints([read('g')]), [], 'a new chain starts at one');
  assert.deepEqual(hints([read('h')]), ['h'], 'and hints again at its second');
  assert.deepEqual(hints([{ id: 'w', name: 'edit', input: {} }]), [], 'a write resets');
  assert.deepEqual(hints([read('i')]), []);
  assert.deepEqual(hints([{ id: 'p', ...bash('git push') }]), [], 'a bash write resets');
  assert.deepEqual(hints([read('j')]), []);
  assert.deepEqual(hints([read('k')]), ['k']);
  assert.deepEqual(hints([]), [], 'an answer without calls ends the chain');
  assert.deepEqual(hints([read('l')]), []);
  assert.deepEqual(hints([{ id: 'm', ...bash('git status') }]), ['m'], 'a read-only bash counts as a read');
});

test('the hint goes to the result of the call that closes the second lone read, never to another call', () => {
  const chain = new ReadChain();
  chain.turn([{ id: 'a', name: 'read' }]);
  chain.turn([{ id: 'b', name: 'zoom' }]);
  assert.equal(chain.claim('a', 'read'), false, 'an old call');
  assert.equal(chain.claim('b', 'zoom'), true);
  assert.equal(chain.claim('b', 'zoom'), false, 'taken once');
});

test('a failed second read keeps its error text exact and the next lone read carries the hint', () => {
  const chain = new ReadChain();
  chain.turn([{ id: 'a', name: 'read' }]);
  chain.turn([{ id: 'b', name: 'read' }]);
  assert.equal(chain.claim('b', 'read', true), false);
  chain.turn([{ id: 'c', name: 'read' }]);
  assert.equal(chain.claim('c', 'read'), true);
  chain.turn([{ id: 'd', name: 'read' }]);
  assert.equal(chain.claim('d', 'read'), false, 'still once per chain');
});

type Handler = (event: any) => any;
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = { on: (name: string, handler: Handler) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); } };
  const emit = (name: string, event: any = {}) => { let last: any; for (const handler of handlers.get(name) ?? []) last = handler(event) ?? last; return last; };
  return { pi, emit };
}

/** One turn as Pi runs it: the assistant message ends, then each call's result goes through the tool_result hooks. */
function session(register: (pi: never) => void = pi => registerReadChainHint(pi)) {
  const { pi, emit } = fakePi();
  register(pi as never);
  let n = 0;
  emit('agent_start');
  return {
    emit,
    turn(...calls: { name: string; input?: unknown }[]) {
      const withIds = calls.map(call => ({ ...call, id: `call${++n}` }));
      emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }, ...withIds.map(call => ({ type: 'toolCall', id: call.id, name: call.name, arguments: call.input ?? {} }))] } });
      return withIds.map(call => emit('tool_result', { toolName: call.name, toolCallId: call.id, input: call.input ?? {}, content: [{ type: 'text', text: 'ok' }] }));
    },
  };
}
const texts = (patched: any) => patched?.content?.map((block: { text: string }) => block.text);

test('through the tool_result hook the second lone read gets the hint after its own output', () => {
  const s = session();
  assert.equal(s.turn({ name: 'read' })[0], undefined);
  assert.deepEqual(texts(s.turn({ name: 'bash', input: { command: 'git status' } })[0]), ['ok', `\n${BATCH_HINT}`]);
  assert.equal(s.turn({ name: 'read' })[0], undefined, 'once per chain');
  assert.deepEqual(s.turn({ name: 'read' }, { name: 'zoom' }), [undefined, undefined], 'a batch gets nothing and resets');
  assert.equal(s.turn({ name: 'read' })[0], undefined);
  assert.equal(texts(s.turn({ name: 'read' })[0])?.[1], `\n${BATCH_HINT}`);
  assert.equal(s.turn({ name: 'edit' })[0], undefined);
  assert.equal(s.turn({ name: 'read' })[0], undefined, 'a write reset it');
  assert.ok(texts(s.turn({ name: 'ripwire' })[0]), 'and the second read after it hints');
});

test('a new run starts a new chain, and the hint is quiet while disabled', () => {
  const s = session();
  s.turn({ name: 'read' });
  s.emit('agent_start');
  assert.equal(s.turn({ name: 'read' })[0], undefined, 'the read before agent_start does not count');
  let on = false;
  const quiet = session(pi => registerReadChainHint(pi, () => on));
  quiet.turn({ name: 'read' });
  assert.equal(quiet.turn({ name: 'read' })[0], undefined, 'disabled');
  on = true;
  assert.equal(quiet.turn({ name: 'read' })[0], undefined, 'enabling mid-chain starts counting from the next turn');
  assert.ok(quiet.turn({ name: 'read' })[0]);
});
