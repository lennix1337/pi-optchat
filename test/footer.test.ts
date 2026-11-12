import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { dollars, familyLabel, GOAL_STATUS_EVENT, metaText, mountFooter, tokens } from '../src/footer.ts';

test('money and tokens are short and in Portuguese number format', () => {
  assert.deepEqual([44.93, 3.254, 10, 0].map(dollars), ['$44,9', '$3,25', '$10,0', '$0,00']);
  assert.deepEqual([512, 1_000, 197_432, 1_000_000, 1_450_000].map(tokens), ['512', '1k', '197k', '1M', '1,5M']);
});

test('the goal extension words its status in Portuguese already: it is shown as it came, never prefixed twice', () => {
  assert.equal(metaText('meta: 1 aberta · /goal-focus'), 'meta: 1 aberta · /goal-focus');
  assert.equal(metaText('meta: 3 abertas · /goal-focus'), 'meta: 3 abertas · /goal-focus');
  assert.equal(metaText('meta: Entregar o rodapé · em andamento 2/5'), 'meta: Entregar o rodapé · em andamento 2/5');
  assert.equal(metaText('  META:   x  '), 'META: x');
  assert.equal(metaText('  '), undefined);
  assert.equal(metaText(undefined), undefined);
});

test('the older English status is translated once, and any other goal text is prefixed once', () => {
  assert.equal(metaText('goal: unfocused [1 open] - /goal-focus'), 'meta: 1 aberta · /goal-focus');
  assert.equal(metaText('goal: unfocused [2 open] - /goal-focus'), 'meta: 2 abertas · /goal-focus');
  assert.equal(metaText('goal: ship the footer'), 'meta: ship the footer');
});

/** A Pi event bus and the footer data and TUI it hands the factory, enough to draw the footer once. */
function drawFooter(status: string | undefined, bus: { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void }) {
  let factory: ((tui: unknown, theme: unknown, data: unknown) => { render(width: number): string[]; dispose(): void }) | undefined;
  const ctx = { hasUI: true, getContextUsage: () => undefined, model: undefined, ui: { setFooter: (next: typeof factory) => { factory = next; } } } as unknown as ExtensionContext;
  const unmount = mountFooter(ctx, { spend: () => 2, quotaState: () => ({}), events: bus });
  const data = { onBranchChange: () => () => {}, getExtensionStatuses: () => new Map(status === undefined ? [] : [['goal', status]]) };
  const widget = factory!({ requestRender() {} }, { fg: (_tone: string, text: string) => text }, data);
  return { widget, unmount, last: (width = 100) => widget.render(width).at(-1)!.trim() };
}
function eventBus() {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  return {
    on: (channel: string, handler: (data: unknown) => void) => { handlers.set(channel, [...handlers.get(channel) ?? [], handler]); return () => handlers.set(channel, (handlers.get(channel) ?? []).filter(h => h !== handler)); },
    emit: (channel: string, data: unknown) => { for (const handler of handlers.get(channel) ?? []) handler(data); },
    count: (channel: string) => handlers.get(channel)?.length ?? 0,
  };
}

test('the footer shows the goal status once whether it comes from the status slot or from the event', () => {
  const slot = drawFooter('meta: 1 aberta · /goal-focus', eventBus());
  assert.equal(slot.last(), '$2,00 hoje · meta: 1 aberta · /goal-focus');
  assert.doesNotMatch(slot.last(), /meta: meta:/);
  const bus = eventBus(), live = drawFooter(undefined, bus);
  assert.equal(live.last(), '$2,00 hoje');
  bus.emit(GOAL_STATUS_EVENT, { text: 'meta: 3 abertas · /goal-focus', focused: false, open: 3 });
  assert.equal(live.last(), '$2,00 hoje · meta: 3 abertas · /goal-focus');
  bus.emit(GOAL_STATUS_EVENT, { text: '', focused: false, open: 0 });
  assert.equal(live.last(), '$2,00 hoje', 'an empty announcement clears the slot, even over an older status');
  bus.emit(GOAL_STATUS_EVENT, 'not a payload');
  assert.equal(live.last(), '$2,00 hoje', 'a malformed payload changes nothing');
  live.unmount();
  assert.equal(bus.count(GOAL_STATUS_EVENT), 0, 'unmounting stops listening');
});

// The producer itself: pi-goal-x's own payloads, when the sibling checkout is there, go through the event and the status slot untouched.
const GOAL_X = new URL('file:///C:/projetos/pi-goal-x/extensions/goal-status-line.ts');
const producer = await import(GOAL_X.href).catch(() => undefined) as undefined | { GOAL_STATUS_EVENT: string; goalStatusPayload(args: { goal: unknown; openCount: number }): { text: string } };

test('what pi-goal-x really announces is shown once, by event and by status', { skip: producer ? false : 'pi-goal-x checkout not found' }, () => {
  assert.equal(producer!.GOAL_STATUS_EVENT, GOAL_STATUS_EVENT, 'the channel is the one the producer announces on');
  for (const open of [1, 2, 7]) {
    const payload = producer!.goalStatusPayload({ goal: null, openCount: open });
    const bus = eventBus(), byEvent = drawFooter(undefined, bus);
    bus.emit(producer!.GOAL_STATUS_EVENT, payload);
    const byStatus = drawFooter(payload.text, eventBus());
    assert.equal(byEvent.last(), byStatus.last());
    assert.equal(byEvent.last(), `$2,00 hoje · ${payload.text}`);
    assert.equal(byEvent.last().match(/meta:/g)?.length, 1);
  }
});

test('the quota label is the account\'s family', () => {
  assert.equal(familyLabel('claude-sonnet-5-5', 'anthropic-account-2'), 'Claude');
  assert.equal(familyLabel('gpt-6.1-sol', 'openai-codex'), 'GPT');
  assert.equal(familyLabel('mystery-1', 'acme'), 'acme');
});

test('without a UI the footer is left to Pi; with one it replaces it and unmounting gives it back', () => {
  const calls: unknown[] = [];
  const ctx = (hasUI: boolean) => ({ hasUI, getContextUsage: () => undefined, model: undefined, ui: { setFooter: (factory: unknown) => calls.push(factory) } }) as unknown as ExtensionContext;
  const sources = { spend: () => 1, quotaState: () => ({}) };
  mountFooter(ctx(false), sources)();
  assert.deepEqual(calls, [], 'no UI, no footer call');
  const unmount = mountFooter(ctx(true), sources);
  assert.equal(typeof calls[0], 'function');
  unmount();
  assert.equal(calls[1], undefined);
  assert.equal(calls.length, 2);
});

test('the footer leads with the model and its thinking level, then the cache hit of the last reply', async () => {
  const { lastCacheHit, modelText, FooterState, footerLine } = await import('../src/footer.ts');
  assert.equal(modelText('claude-opus-5-5', 'high'), 'opus-5-5 high');
  assert.equal(modelText('openai-codex/gpt-6.1-sol', 'xhigh'), 'gpt-6.1-sol xhigh');
  assert.equal(modelText('gpt-6.1-terra'), 'gpt-6.1-terra');
  const entries: Record<string, { id: string; type: string; parentId: string | null; message?: unknown }> = {
    a: { id: 'a', type: 'message', parentId: null, message: { role: 'assistant', usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 5 } } },
    b: { id: 'b', type: 'message', parentId: 'a', message: { role: 'assistant', usage: { input: 2_000, cacheRead: 6_000, cacheWrite: 2_000, output: 5 } } },
    c: { id: 'c', type: 'message', parentId: 'b', message: { role: 'user', content: 'oi' } },
    d: { id: 'd', type: 'thinking_level_change', parentId: 'c' },
  };
  const sm = (leaf: string | undefined) => ({ getLeafEntry: () => leaf ? entries[leaf] : undefined, getEntry: (id: string) => entries[id] }) as never;
  assert.equal(lastCacheHit(sm('d')), 0.6, 'the newest assistant reply counts, past user and settings entries');
  assert.equal(lastCacheHit(sm('a')), 0.9);
  assert.equal(lastCacheHit(sm(undefined)), undefined, 'an empty session has no hit to show');
  const ctx = { getContextUsage: () => ({ tokens: 50_000, contextWindow: 500_000 }), model: { id: 'claude-opus-5-5', provider: 'anthropic', contextWindow: 500_000 }, sessionManager: sm('d') } as never;
  const input = new FooterState(ctx, { spend: () => 3, quotaState: () => ({}), thinking: () => 'high', now: () => 0 }).input(undefined);
  assert.equal(footerLine(input, 200, (_t, s) => s), 'opus-5-5 high · cache 60% · $3,00 hoje · contexto 50k/500k');
  assert.equal(footerLine(input, 14, (_t, s) => s), 'opus-5-5 high', 'the model is the last part to go on a narrow terminal');
  const broken = new FooterState({ ...ctx as object, sessionManager: { getLeafEntry: () => { throw new Error('x'); } } } as never, { spend: () => 3, quotaState: () => ({}), thinking: () => { throw new Error('y'); }, now: () => 0 }).input(undefined);
  assert.equal(footerLine(broken, 200, (_t, s) => s), 'opus-5-5 · $3,00 hoje · contexto 50k/500k', 'a failing source only hides its part');
});
