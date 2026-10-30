import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { initTheme, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Entry } from '../src/memory.ts';
import { registerCatchup } from '../src/catchup-integration.ts';
import { CatchupWindows } from '../src/catchup.ts';
import { CatchupView, catchupJson, showCatchup } from '../src/catchup-ui.ts';
import { getCapabilities, setCapabilities, visibleWidth } from '@earendil-works/pi-tui';
import { withTempDir } from './support.ts';

initTheme('dark', false);

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
  // The receipt reaches the operator through Slack and /catchup; no widget stays pinned above the editor.
  assert.deepEqual(f.widgets, []);
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

test('receipt, history and event commands show Brasília dates without changing UTC evidence or journals', async () => withTempDir('catchup-time-', async dir => {
  const start = '2026-10-30T01:30:00.000Z', end = '2026-10-30T03:15:00.000Z';
  const windows = new CatchupWindows(dir);
  windows.arrive(0, start); windows.arrive(1, end);
  const f = fixture(dir);
  f.entries.push({ i: 0, kind: 'work', text: '[OptChat heartbeat] wake', size: 1, date: start });
  const saved = readFileSync(join(dir, 'catchup.json'), 'utf8');
  const receipt = await f.tools.get('catchup_report').execute('time', {});
  assert.match(receipt.content[0].text, /29\/10\/2026, 22:30:00/);
  assert.match(receipt.content[0].text, /30\/10\/2026, 00:15:00/);
  assert.match(receipt.content[0].text, /Brasília, UTC-3/);
  assert.doesNotMatch(receipt.content[0].text, /2026-10-30T/);
  assert.equal(receipt.details.span.start, start);
  for (const args of ['history', 'log 0', 'range 0 1 0']) {
    await f.commands.get('catchup').handler(args, { ...f.context, mode: 'rpc' });
    const text = f.notifications.at(-1)!;
    assert.match(text, /29\/10\/2026, 22:30:00/);
    assert.match(text, /Brasília, UTC-3/);
    assert.doesNotMatch(text, /2026-10-30T/);
  }
  const raw = await f.tools.get('catchup_report').execute('events', { view: 'log' });
  assert.equal(raw.details.items[0].at, start);
  assert.equal(JSON.parse(raw.content[0].text).items[0].at, start);
  let rendered = '';
  await f.commands.get('catchup').handler('range 0 1', { ...f.context, ui: { custom: async (factory: Function) => {
    const view = factory({ terminal: { rows: 80 }, requestRender() {} }, undefined, undefined, () => {});
    rendered = view.render(120).join('\n');
  } } } as unknown as ExtensionCommandContext);
  assert.match(rendered, /29\/10\/2026, 22:30:00/);
  assert.match(rendered, /Brasília, UTC-3/);
  assert.equal(readFileSync(join(dir, 'catchup.json'), 'utf8'), saved);
}));

test('native catchup command renders Markdown, code colors and terminal hyperlinks with a visible URL fallback', async () => withTempDir('catchup-ui-', async dir => {
  const f = fixture(dir);
  f.input('interactive');
  f.add('echo', 'bash: {"url":"https://github.com/owner/repo/pull/7","state":"OPEN"}');
  f.add('talk', '[untrusted](javascript:alert(1)) ````');
  f.input('interactive', 'return');
  const caps = getCapabilities();
  try {
    for (const hyperlinks of [true, false]) {
      setCapabilities({ ...caps, hyperlinks });
      let shown = false;
      const ctx = { ...f.context, ui: { ...f.context.ui, custom: async (factory: Function) => {
        const view = factory({ terminal: { rows: 70 }, requestRender() {} }, undefined, undefined, () => {});
        const rendered = view.render(160).join('\n');
        assert.doesNotMatch(rendered, /^## /m, 'section markers must render, not display raw');
        assert.match(rendered, /\x1b\[/, 'native theme styles must reach the screen');
        assert.match(rendered, /https:\/\/github.com\/owner\/repo\/pull\/7/);
        assert.equal(rendered.includes('\x1b]8;;https://github.com/owner/repo/pull/7'), hyperlinks);
        assert.doesNotMatch(rendered, /\x1b\]8;;javascript:/, 'reported text cannot inject a Markdown action');
        for (const width of [32, 80]) {
          view.handleInput('g');
          const narrow = view.render(width);
          assert.ok(narrow.length <= 70);
          assert.ok(narrow.every((line: string) => visibleWidth(line) <= width));
          view.handleInput('G');
          assert.match(view.render(width).join('\n'), /Current work|exhaustive machine/);
        }
        shown = true;
      } } } as unknown as ExtensionCommandContext;
      await f.commands.get('catchup').handler('', ctx);
      assert.equal(shown, true);
    }
    let rendered = '';
    await showCatchup({ ...f.context, ui: { custom: async (factory: Function) => {
      rendered = factory({ terminal: { rows: 30 }, requestRender() {} }, undefined, undefined, () => {}).render(80).join('\n');
    } } } as unknown as ExtensionContext, '```json\n{"status": true, "count": 3}\n```');
    // Pi intentionally displays dim code fences; token colors distinguish a rendered block from raw text.
    assert.match(rendered, /\x1b\[[0-9;]+m"status"\x1b\[39m/);
    assert.match(rendered, /\x1b\[[0-9;]+mtrue\x1b\[39m/);
    await f.commands.get('catchup').handler('json', { ...f.context, ui: { custom: async (factory: Function) => {
      rendered = factory({ terminal: { rows: 100 }, requestRender() {} }, undefined, undefined, () => {}).render(160).join('\n');
    } } } as unknown as ExtensionCommandContext);
    assert.match(catchupJson({ text: '````' }), /^`````json\n/, 'fences in transcript data cannot end the JSON block');
    assert.match(rendered, /javascript:alert/, 'untrusted text stays visible inside JSON, not a link');
    assert.doesNotMatch(rendered, /\x1b\]8;;javascript:/);
    assert.match(rendered, /\x1b\[[0-9;]+m"covered"\x1b\[39m/);
  } finally { setCapabilities(caps); }
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
