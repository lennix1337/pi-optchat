import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

async function publishGraph(dotPath: string) {
  const graph = { nodes: [{ id: 'session', label: 'Sessão' }], edges: [] };
  const calls: { url: string; body: any }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const name = String(url);
    const body = typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : undefined;
    calls.push({ url: name, body });
    if (name.endsWith('files.getUploadURLExternal')) return new Response(JSON.stringify({ ok: true, upload_url: 'https://files.slack.com/upload/test', file_id: 'F123' }));
    return new Response(JSON.stringify({ ok: true }));
  };
  const poster = new SlackPoster({ botToken: 'xoxb-test', operator: 'U123', fetch: fetcher, dotPath });
  await poster.publishHome('Status', { team: ['worker'], graph });
  return calls;
}

test('Home publishes an uploaded graph', { skip: spawnSync('dot', ['-V']).status !== 0 }, async () => {
  const success = await publishGraph('dot');
  assert.deepEqual(success.map(c => c.url.split('/').pop()), ['files.getUploadURLExternal', 'test', 'files.completeUploadExternal', 'views.publish']);
  const image = success.at(-1)!.body.view.blocks.find((block: any) => block.type === 'image');
  assert.deepEqual(image.slack_file, { id: 'F123' });
});

test('Home keeps unchanged text when dot fails', async () => {
  const failed = await publishGraph('/no/such/dot');
  assert.equal(failed.length, 1);
  assert.deepEqual(failed[0]!.body.view.blocks, homeBlocks('Status', { team: ['worker'] }));
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
