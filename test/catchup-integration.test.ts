import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Entry } from '../src/memory.ts';
import { registerCatchup } from '../src/catchup-integration.ts';
import { CatchupView } from '../src/catchup-ui.ts';
import { visibleWidth } from '@earendil-works/pi-tui';
import { withTempDir } from './support.ts';

function fixture(dir: string) {
  const handlers = new Map<string, Function[]>(), commands = new Map<string, any>(), tools = new Map<string, any>();
  const notifications: string[] = [], widgets: (string[] | undefined)[] = [], entries: Entry[] = [];
  let flushes = 0;
  const pi = {
    on: (event: string, fn: Function) => handlers.set(event, [...handlers.get(event) ?? [], fn]),
    registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
    registerTool: (definition: any) => tools.set(definition.name, definition),
  } as unknown as ExtensionAPI;
  const context = { mode: 'tui', ui: { notify: (text: string) => notifications.push(text), setWidget: (_key: string, lines: string[] | undefined) => widgets.push(lines) } } as unknown as ExtensionContext;
  const catchup = registerCatchup(pi, () => ({ dir, entries, flush: () => { flushes++; }, attention: () => ({ approvals: 1, uncertain: 1, agents: 0, shells: 0 }) }));
  const add = (kind: Entry['kind'], text: string) => entries.push({ i: entries.length, kind, text, date: new Date().toISOString(), size: text.length });
  const input = (source: string, text = 'hello', mode = 'tui') => handlers.get('input')![0]({ source, text }, { ...context, mode });
  return { handlers, commands, tools, context, catchup, notifications, widgets, entries, add, input, flushes: () => flushes };
}

test('registered input → frozen report → command/tool → restart preserves the same interval and excludes extension/RPC/commands', async () => withTempDir('catchup-hooks-', async dir => {
  const f = fixture(dir), tool = f.tools.get('catchup_report');
  for (const [source, mode] of [['extension', 'tui'], ['rpc', 'rpc'], ['interactive', 'rpc']]) f.input(source, 'not a human boundary', mode);
  assert.match((await tool.execute('untracked', {})).content[0].text, /No completed recorded human interval/);
  f.input('interactive');
  f.add('user', 'human');
  for (let i = 0; i < 14; i++) { f.add('work', '[OptChat heartbeat] wake'); f.add('talk', `Work ${i}`); }
  f.input('extension'); f.input('interactive', '/catchup');
  assert.equal((await tool.execute('before-return', { view: 'history' })).content[0].text.includes('0-29'), false);
  f.input('interactive', 'back');
  const report = await tool.execute('report', {});
  assert.equal(report.details.wakes.length, 14);
  assert.equal(report.details.covered, 29);
  assert.match(report.content[0].text, /1 pending mechanical approvals/);
  assert.match(report.content[0].text, /operation_state/);
  assert.match(f.widgets.at(-1)![0], /14 wakes/);
  const saved = readFileSync(join(dir, 'catchup.json'), 'utf8');
  f.add('talk', 'this belongs to the next interval');
  assert.deepEqual((await tool.execute('again', {})).details, report.details);
  await f.commands.get('catchup').handler('', { ...f.context, mode: 'rpc' } as ExtensionCommandContext);
  assert.match(f.notifications.at(-1)!, /14 wakes/);
  assert.equal(readFileSync(join(dir, 'catchup.json'), 'utf8'), saved);
  const again = fixture(dir); again.entries.push(...f.entries);
  assert.deepEqual((await again.tools.get('catchup_report').execute('restart', {})).details, report.details);
  assert.ok(f.flushes() > 0);
}));

test('history is navigable after follow-up messages and raw event pages have exact continuation', async () => withTempDir('catchup-history-', async dir => {
  const f = fixture(dir), tool = f.tools.get('catchup_report');
  f.input('interactive');
  f.add('work', '[OptChat heartbeat] woke');
  f.add('talk', 'completed');
  f.input('interactive', 'hello again');
  f.add('user', 'hello again');
  f.input('interactive', 'one more question');
  assert.equal((await tool.execute('older', { window: 1 })).details.wakes.length, 1);
  const log = await tool.execute('log', { view: 'log', window: 1, offset: 0 });
  assert.deepEqual(log.details.items.map((e: any) => e.i), [0, 1]);
  assert.equal(log.details.nextOffset, null);
  assert.match(f.catchup.context(), /^$/, 'a follow-up without wakes has no ambient prompt addition');
  await assert.rejects(tool.execute('bad-window', { window: 99 }), /No such/);
  await f.commands.get('catchup').handler('range 0 2', { ...f.context, mode: 'rpc' });
  assert.match(f.notifications.at(-1)!, /explicit historical range/);
}));

test('narrow native receipt reflows, scrolls to all content and closes without mutations', () => {
  let closed = 0, redraws = 0;
  const view = new CatchupView(Array.from({ length: 40 }, (_, i) => `Activity ${i} with a moderately long description`).join('\n'), () => 15, () => closed++, () => redraws++);
  for (const width of [20, 40, 80]) {
    const lines = view.render(width);
    assert.ok(lines.length <= 15, 'header, body and wrapped footer must fit the viewport');
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
  }
  view.handleInput('G');
  assert.match(view.render(40).join('\n'), /Activity 39/);
  view.handleInput('g');
  assert.match(view.render(40).join('\n'), /Activity 0/);
  view.handleInput('q');
  assert.equal(closed, 1); assert.equal(redraws, 2);
});
