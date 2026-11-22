import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeBlocks, SlackPoster } from '../src/channels/slack-relay.ts';

test('Home shows a bounded team with escaped text and no image', () => {
  const team = Array.from({ length: 200 }, (_, i) => `worker ${i} · model · <repo> · ${'x'.repeat(4000)}`);
  const blocks = homeBlocks('Status', { team }) as any[];
  assert.ok(blocks.length <= 100);
  assert.ok(blocks.some(b => b.type === 'header' && b.text.text === 'Equipe'));
  assert.ok(blocks.some(b => b.type === 'section' && b.text.text.includes('&lt;repo&gt;')));
  assert.ok(!blocks.some(b => b.type === 'image'));
  for (const block of blocks) if (block.type === 'section') assert.ok(block.text.text.length <= 3000);
});

test('Home stays readable without workers', () => {
  const blocks = homeBlocks('Status', { team: [] }) as any[];
  assert.ok(blocks.some(b => b.type === 'section' && b.text.text.includes('Nenhum worker')));
});

test('publishing a team uses views.publish only', async () => {
  const calls: any[] = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify({ ok: true })); };
  const poster = new SlackPoster({ botToken: 'xoxb-test', operator: 'U123', fetch: fetcher });
  await poster.publishHome('Status', { team: ['agy · Neon · GX18MCP → GX18MCP#42 · há 6 min'] });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith('views.publish'));
  assert.ok(calls[0].body.view.blocks.some((b: any) => b.type === 'section' && b.text.text.includes('GX18MCP#42')));
});
