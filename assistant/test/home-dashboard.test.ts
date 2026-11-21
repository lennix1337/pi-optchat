import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeBlocks, SlackPoster } from '../src/channels/slack-relay.ts';

test('Home shows a bounded team and a Slack-hosted diagram', () => {
  const team = Array.from({ length: 200 }, (_, i) => `worker ${i} · model · ${'x'.repeat(4000)}`);
  const blocks = homeBlocks('Status', { team, diagram: { file: 'F123' } }) as any[];
  assert.ok(blocks.length <= 100);
  assert.ok(blocks.some(b => b.type === 'header' && b.text.text === 'Equipe'));
  assert.ok(blocks.some(b => b.type === 'image' && b.slack_file?.id === 'F123'));
  for (const block of blocks) if (block.type === 'section') assert.ok(block.text.text.length <= 3000);
});

test('Home stays readable without workers and with a diagram fallback', () => {
  const blocks = homeBlocks('Status', { team: [], diagram: { source: 'flowchart LR\n  root["OptChat"]' } }) as any[];
  assert.ok(blocks.some(b => b.type === 'section' && b.text.text.includes('Nenhum worker')));
  assert.ok(blocks.some(b => b.type === 'section' && b.text.text.includes('```flowchart LR')));
});

test('a long Mermaid fallback preserves every character within Slack limits', () => {
  const source = `flowchart LR\n${'root --> item\n'.repeat(600)}`;
  const blocks = homeBlocks('Status', { team: [], diagram: { source } }) as any[];
  const parts = blocks.filter(b => b.type === 'section' && b.text.text.startsWith('```')).map(b => b.text.text.slice(3, -3));
  assert.equal(parts.join(''), source);
  assert.ok(blocks.length <= 100);
  assert.ok(blocks.filter(b => b.type === 'section').every(b => b.text.text.length <= 3000));
});

test('render failure publishes text and Mermaid without uploading', async () => {
  const calls: any[] = [];
  const fetcher: typeof fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return new Response(JSON.stringify({ ok: true })); };
  const poster = new SlackPoster({ botToken: 'xoxb-test', operator: 'U123', fetch: fetcher, renderDiagram: async () => { throw new Error('renderer unavailable'); } });
  await poster.publishHome('Status', { team: [], mermaid: 'flowchart LR\n root["OptChat"]' });
  assert.equal(calls.length, 1);
  const blocks = calls[0].body.view.blocks;
  assert.ok(blocks.some((b: any) => b.type === 'section' && b.text.text.includes('```flowchart LR')));
});

test('upload failure also publishes the Mermaid fallback', async () => {
  const views: any[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith('files.getUploadURLExternal')) return new Response(JSON.stringify({ ok: false, error: 'missing_scope' }));
    views.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true }));
  };
  const poster = new SlackPoster({ botToken: 'xoxb-test', operator: 'U123', fetch: fetcher, renderDiagram: async () => Buffer.from('png') });
  await poster.publishHome('Status', { team: [], mermaid: 'flowchart LR\n root["OptChat"]' });
  assert.ok(views[0].view.blocks.some((b: any) => b.type === 'section' && b.text.text.includes('```flowchart LR')));
});

test('uploads once and reuses the Slack file for unchanged diagrams', async () => {
  const calls: { url: string; body: any }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const name = String(url);
    const body = name.includes('/upload/') || name.endsWith('files.getUploadURLExternal') ? undefined : JSON.parse(String(init?.body));
    calls.push({ url: name, body });
    if (name.endsWith('files.getUploadURLExternal')) return new Response(JSON.stringify({ ok: true, upload_url: 'https://files.slack.com/upload/abc', file_id: 'F123' }));
    return new Response(JSON.stringify({ ok: true }));
  };
  const poster = new SlackPoster({ botToken: 'xoxb-test', operator: 'U123', fetch: fetcher, renderDiagram: async () => Buffer.from('png') });
  await poster.publishHome('Status', { team: [], mermaid: 'flowchart LR' });
  await poster.publishHome('Status', { team: [], mermaid: 'flowchart LR' });
  assert.equal(calls.filter(c => c.url.endsWith('files.getUploadURLExternal')).length, 1);
  assert.equal(calls.filter(c => c.url.endsWith('files.completeUploadExternal')).length, 1);
  assert.equal(calls.filter(c => c.url.endsWith('views.publish')).length, 2);
  assert.ok(calls.at(-1)!.body.view.blocks.some((b: any) => b.type === 'image' && b.slack_file.id === 'F123'));
});
