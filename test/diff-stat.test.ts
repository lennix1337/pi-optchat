import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { callDelta, deltaText, lineDelta } from '../src/diff-stat.ts';
import { wakeEffects } from '../src/wake-log.ts';

test('lineDelta counts only the lines that changed, not the ones both texts share', () => {
  assert.deepEqual(lineDelta('a\nb\nc', 'a\nB\nc'), { added: 1, removed: 1 });
  assert.deepEqual(lineDelta('a\nb', 'a\nb\nc\nd'), { added: 2, removed: 0 });
  assert.deepEqual(lineDelta('a\nb\nc\n', 'a\r\nb\r\nc\r\n'), { added: 0, removed: 0 }, 'line endings are not changes');
  assert.deepEqual(lineDelta('', 'um\ndois\n'), { added: 2, removed: 0 });
  assert.deepEqual(lineDelta('um\ndois', ''), { added: 0, removed: 2 });
});

test('callDelta reads edits and writes from their arguments and says nothing when they carry none', () => {
  assert.deepEqual(callDelta('edit', { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y\nz' }, { oldText: 'p\nq', newText: 'p' }] }), { added: 2, removed: 2 });
  assert.deepEqual(callDelta('edit', { path: 'a.ts', oldText: 'x', newText: 'y' }), { added: 1, removed: 1 }, 'the single-pair shape');
  assert.deepEqual(callDelta('write', { path: 'a.ts', content: 'um\ndois\ntres\n' }), { added: 3, removed: 0 });
  assert.equal(callDelta('edit', { path: 'a.ts' }), undefined);
  assert.equal(callDelta('write', { path: 'a.ts' }), undefined);
  assert.equal(callDelta('bash', { command: 'ls' }), undefined);
  assert.equal(deltaText({ added: 42, removed: 11 }), '+42 -11');
});

const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: 'toolCall', id, name, arguments: args });
const done = (...ids: string[]) => ids.map(toolCallId => ({ role: 'toolResult', toolCallId, content: 'ok' }));

test('wake effects sum the line changes of each file and name the blast radius', () => {
  const messages = [
    { role: 'assistant', content: [
      call('1', 'edit', { path: 'C:/projetos/pi-optchat/src/a.ts', edits: [{ oldText: 'um', newText: 'um\ndois\ntres' }] }),
      call('2', 'edit', { path: 'C:/projetos/pi-optchat/src/a.ts', edits: [{ oldText: 'x\ny', newText: 'z' }] }),
      call('3', 'write', { path: 'C:/projetos/pi-optchat/src/b.ts', content: 'a\nb\n' }),
      call('4', 'edit', { path: 'C:/projetos/outro/c.ts', edits: [{ oldText: 'q', newText: 'r' }] }),
    ] },
    ...done('1', '2', '3', '4'),
  ];
  assert.deepEqual(wakeEffects(messages), [
    'pi-optchat: *editou 2 arquivos* (`+5 -2`) \u2014 `a.ts` (`+3 -2`), `b.ts` (`+2 -0`)',
    'outro: editou `c.ts` (`+1 -1`)',
  ]);
});

test('wake effects list at most six files and keep the plain names when no count is known', () => {
  const edits = Array.from({ length: 8 }, (_, i) => call(`e${i}`, 'edit', { path: `C:/projetos/pi-optchat/f${i}.ts`, edits: [{ oldText: 'a', newText: 'b' }] }));
  const many = wakeEffects([{ role: 'assistant', content: edits }, ...done(...edits.map(e => e.id))]);
  assert.equal(many.length, 1);
  assert.match(many[0]!, /^pi-optchat: \*editou 8 arquivos\* \(`\+8 -8`\) \u2014 `f0\.ts` \(`\+1 -1`\)(, `f\d\.ts` \(`\+1 -1`\)){5}, e mais 2$/);
  const bare = wakeEffects([{ role: 'assistant', content: [call('1', 'edit', { path: 'C:/projetos/pi-optchat/a.ts' })] }, ...done('1')]);
  assert.deepEqual(bare, ['pi-optchat: editou a.ts']);
});
