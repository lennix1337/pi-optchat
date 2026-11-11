import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BarNavigation, BoardNavigation, inspectorShortcut } from '../src/navigation.ts';

test('agent-bar focus preserves typing, autocomplete, and ordinary history navigation', () => {
  const nav = new BarNavigation(), opened: string[] = [];
  const input = (data: string, empty = true, autocomplete = false) => nav.handle(data, empty, autocomplete, page => opened.push(page));
  assert.equal(input('\x1b[B', false), false, 'nonempty drafts retain Down');
  assert.equal(input('\x1b[B', true, true), false, 'autocomplete retains Down');
  assert.equal(input('\x1b[A'), false, 'Up retains input history');
  assert.equal(input('\x1b[B'), true);
  assert.equal(nav.selected, 'agents');
  input('\x1b[C'); input('\r');
  assert.deepEqual(opened, ['usage']); assert.equal(nav.selected, undefined);
  input('\x1b[B'); input('\x1b[D'); input('\r');
  assert.deepEqual(opened, ['usage', 'shells'], 'Left from Agents wraps to Shells');
  input('\x1b[B'); assert.equal(input('h'), false); assert.equal(nav.selected, undefined);
  input('\x1b[B'); assert.equal(input('\x1b'), true); assert.equal(nav.selected, undefined);
  assert.equal(inspectorShortcut('ctrl+shift+a'), 'ctrl+shift+a');
  assert.throws(() => inspectorShortcut('ctrl+ctrl+a'));
});

const ITEMS = ['aprovar o deploy', 'decidir X', 'responder o PR #12', 'liberar a cota'];
const fakeBoard = (items: string[]) => ({ expanded: () => ({ lines: items.map(text => ({ text, tone: 'wait' as const, at: 0, finished: false })), more: 0, pending: items.length, now: 0 }) });
const UP = '\x1b[A', DOWN = '\x1b[B';

test('Up on an empty editor focuses the waiting board; the cursor moves, stays at the first item and leaves past the last', () => {
  const nav = new BoardNavigation(fakeBoard(ITEMS)), keys = (data: string, empty = true, autocomplete = false) => nav.handle(data, empty, autocomplete);
  assert.equal(keys(UP, false), false, 'a draft keeps Up for the editor');
  assert.equal(keys(UP, true, true), false, 'autocomplete keeps Up');
  assert.equal(keys(DOWN), false, 'Down is not the board’s while unfocused');
  assert.equal(nav.focused, false);
  assert.equal(keys(UP), true); assert.equal(nav.focused, true); assert.equal(nav.cursor, 0);
  assert.equal(nav.items().length, 4, 'all four items are listed');
  assert.equal(keys(UP), true); assert.equal(nav.cursor, 0, 'Up at the first item stays');
  keys(DOWN); keys(DOWN); assert.equal(nav.cursor, 2);
  keys(DOWN); assert.equal(nav.cursor, 3);
  assert.equal(keys(DOWN), true, 'Down past the last item is consumed'); assert.equal(nav.focused, false, 'and gives focus back to the editor');
});

test('Esc and typing leave the board; typing still reaches the editor', () => {
  const nav = new BoardNavigation(fakeBoard(ITEMS));
  nav.handle(UP, true, false); assert.equal(nav.handle('\x1b', true, false), true); assert.equal(nav.focused, false);
  nav.handle(UP, true, false); assert.equal(nav.handle('h', true, false), false, 'the key goes on to the editor'); assert.equal(nav.focused, false);
  nav.handle(UP, true, false); nav.handle(DOWN, true, false); assert.equal(nav.cursor, 1);
  nav.handle(UP, true, false); assert.equal(nav.cursor, 0);
});

test('an empty board ignores Up, and focus ends by itself when the board empties', () => {
  const items = [...ITEMS], nav = new BoardNavigation(fakeBoard(items));
  items.length = 0;
  assert.equal(nav.handle(UP, true, false), false); assert.equal(nav.focused, false);
  items.push('decidir X'); nav.handle(UP, true, false); assert.equal(nav.focused, true);
  items.length = 0; assert.deepEqual(nav.items(), []); assert.equal(nav.focused, false);
  items.push('a', 'b', 'c'); nav.handle(UP, true, false); nav.handle(DOWN, true, false); nav.handle(DOWN, true, false); items.length = 1;
  assert.equal(nav.items().length, 1); assert.equal(nav.cursor, 0, 'the cursor stays inside a shrunken board');
});

test('the bar below keeps Down, and Up from the bar still returns to the editor', () => {
  const nav = new BoardNavigation(fakeBoard(ITEMS)), bar = new BarNavigation();
  const press = (data: string) => !bar.selected && nav.handle(data, true, false) || bar.handle(data, true, false, () => {});
  press(DOWN); assert.equal(bar.selected, 'agents'); assert.equal(nav.focused, false);
  press(UP); assert.equal(bar.selected, undefined); assert.equal(nav.focused, false, 'Up from the bar goes to the editor, not the board');
  press(UP); assert.equal(nav.focused, true);
  press(DOWN); press(DOWN); press(DOWN); press(DOWN); assert.equal(nav.focused, false); assert.equal(bar.selected, undefined, 'leaving the board does not select the bar');
  press(DOWN); assert.equal(bar.selected, 'agents');
});
