import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Text } from '@earendil-works/pi-tui';
import { groupedRenderers, ToolGroups } from '../src/tool-groups.ts';

const call = (id: string, name = 'bash') => ({ type: 'toolCall', id, name, arguments: {} });
const assistant = (...content: unknown[]) => ({ role: 'assistant', content });
const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t } as never;

/** Draws one tool row the way Pi's self shell does: call slot, then result slot, nothing when both are empty. */
function row(groups: ToolGroups, id: string, opts: { partial?: boolean; error?: boolean; expanded?: boolean; ms?: number; name?: string } = {}) {
  const renderers = groupedRenderers(opts.name ?? 'bash', {
    renderCall: (args: unknown) => new Text(`$ ${(args as { command?: string }).command ?? id}`, 0, 0),
    renderResult: () => new Text(`output of ${id}\nline 2`, 0, 0),
  }, groups);
  const ctx = { toolCallId: id, state: {}, isPartial: !!opts.partial, isError: !!opts.error, expanded: !!opts.expanded, outputPad: 1, durationMs: opts.partial ? undefined : opts.ms ?? 1000, keyText: () => 'ctrl+o' } as never;
  const callSlot = renderers.renderCall!({ command: `cmd ${id}` }, theme, ctx);
  const resultSlot = renderers.renderResult!({ content: [], details: undefined }, { expanded: !!opts.expanded, isPartial: !!opts.partial }, theme, ctx);
  return () => [...callSlot.render(60), ...resultSlot.render(60)].map(l => l.trim()).filter(Boolean);
}

test('back-to-back calls fold into the last one: a summary over its title, earlier rows draw nothing', () => {
  const groups = new ToolGroups();
  groups.load([{ type: 'message', message: assistant(call('a'), call('b'), call('c', 'read')) }]);
  const a = row(groups, 'a'), b = row(groups, 'b'), c = row(groups, 'c', { name: 'read', ms: 500 });
  assert.deepEqual(a(), []);
  assert.deepEqual(b(), []);
  assert.deepEqual(c(), ['▸ 3 chamadas · bash ×2 · read · 2,5 s (ctrl+o expande)', '└ $ cmd c']);
});

test('text the agent writes, or a user message, starts a new group', () => {
  const groups = new ToolGroups();
  groups.load([
    { type: 'message', message: assistant(call('a'), call('b')) },
    { type: 'message', message: { role: 'toolResult', content: [] } },
    { type: 'message', message: assistant({ type: 'text', text: 'Agora o teste' }, call('c')) },
    { type: 'message', message: { role: 'user', content: 'oi' } },
    { type: 'message', message: assistant(call('d')) },
  ]);
  for (const id of ['a', 'b', 'c', 'd']) groups.note(id, { finished: true, error: false });
  assert.deepEqual([groups.role('a'), groups.role('b'), groups.role('c'), groups.role('d')], ['hidden', 'summary', 'alone', 'alone']);
  groups.add(assistant({ type: 'thinking', thinking: 'x' }, call('e')));
  assert.equal(groups.role('d'), 'hidden', 'thinking alone does not break the run');
});

test('a running or failed call keeps its full row; ctrl+o shows every row as Pi draws it', () => {
  const groups = new ToolGroups();
  groups.load([{ type: 'message', message: assistant(call('a'), call('b'), call('c')) }]);
  const failed = row(groups, 'a', { error: true });
  const done = row(groups, 'b');
  const running = row(groups, 'c', { partial: true });
  assert.deepEqual(failed(), ['$ cmd a', 'output of a', 'line 2']);
  assert.deepEqual(done(), []);
  assert.deepEqual(running(), ['$ cmd c', 'output of c', 'line 2'], 'the last call shows its output while it runs');
  const folded = row(groups, 'c');
  assert.match(folded()[0]!, /3 chamadas .*1 com erro/);
  assert.deepEqual(row(groups, 'b', { expanded: true })(), ['$ cmd b', 'output of b', 'line 2']);
});

test('a call alone, or one the session does not know, draws as before', () => {
  const groups = new ToolGroups();
  groups.load([{ type: 'message', message: assistant(call('a')) }]);
  assert.deepEqual(row(groups, 'a')(), ['$ cmd a', 'output of a', 'line 2']);
  assert.deepEqual(row(groups, 'zz')(), ['$ cmd zz', 'output of zz', 'line 2']);
});
