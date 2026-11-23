import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homeBlocks, SlackPoster } from '../src/channels/slack-relay.ts';

test('Home shows a bounded team with escaped text and no image', () => {
  const team = Array.from({ length: 200 }, (_, i) => `worker ${i} · model · <repo> · ${'x'.repeat(4000)}`);
  const blocks = homeBlocks('Status', { team }) as any[];
  assert.ok(blocks.length <= 100);
  assert.ok(blocks.some(b => b.type === 'header' && b.text.text === 'Rodando agora'));
  assert.ok(blocks.some(b => b.type === 'section' && b.text.text.includes('&lt;repo&gt;')));
  assert.ok(!blocks.some(b => b.type === 'image'));
  for (const block of blocks) if (block.type === 'section') assert.ok(block.text.text.length <= 3000);
});

test('Home visualiza status, pendências e trabalhos sem expor prompts', () => {
  const text = '*Trabalhando*\n\n🔀 *PRs abertas* (1)\n• projeto · 🔴 checks vermelhos\n\n🔋 *Cota* (cache):\n• Conta A `▰▰▱▱▱▱▱▱▱▱` 7d 20%';
  const blocks = homeBlocks(text, { working: true, team: ['code · modelo A · You are a subagent. Do not write memory pages. Analisar testes · há 3 min'] }) as any[];
  const rendered = JSON.stringify(blocks);
  assert.match(rendered, /🟢.*Pi.*🔴.*CI.*🟡.*produ[cç][aã]o/i);
  assert.match(rendered, /Nada esperando você/);
  assert.match(rendered, /Rodando agora/);
  assert.doesNotMatch(rendered, /You are a subagent/);
  assert.ok(blocks.length <= 100);
});

test('Home limita blocos mesmo com muitas escolhas e trabalhos', () => {
  const blocks = homeBlocks('Status', { team: Array(200).fill('worker'), choices: Array.from({ length: 200 }, (_, i) => ({ label: `Questão ${i}`, options: ['Sim', 'Não'] })) }) as any[];
  assert.ok(blocks.length <= 100);
  assert.match(JSON.stringify(blocks), /Precisa de você/);
});

test('Home preserva PRs e alertas e não repete a pergunta com botões', () => {
  const text = '*Trabalhando*\n\n*Esperando você*\n• Autorizar atualização?\n\n🔀 *PRs abertas*\n• projeto #42: corrigir testes\n\n⚠️ Alerta importante';
  const blocks = homeBlocks(text, { choices: [{ label: 'Autorizar atualização?', options: ['Sim', 'Não'] }], fold: 'less' }) as any[];
  const sections = blocks.filter(b => b.type === 'section').map(b => b.text.text).join('\n');
  assert.match(sections, /projeto #42: corrigir testes/);
  assert.match(sections, /Alerta importante/);
});

test('Home não duplica a pergunta e distingue processo ativo de saúde', () => {
  const blocks = homeBlocks('*Esperando você*\n• Autorizar atualização?', { choices: [{ label: 'Autorizar atualização?', options: ['Sim', 'Não'] }] }) as any[];
  const sections = blocks.filter(b => b.type === 'section').map(b => b.text.text).join('\n');
  assert.equal(sections.split('Autorizar atualização?').length - 1, 1);
  assert.match(sections, /Pi \(processo ativo\)/);
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

test('a new Home graph deletes the previous upload once the new view is published', { skip: spawnSync('dot', ['-V']).status !== 0 }, async () => {
  const calls: { name: string; body: any }[] = [];
  let uploads = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const name = String(url).split('/').pop()!;
    calls.push({ name, body: typeof init?.body === 'string' && init.body.startsWith('{') ? JSON.parse(init.body) : undefined });
    if (name === 'files.getUploadURLExternal') return new Response(JSON.stringify({ ok: true, upload_url: 'https://files.slack.com/upload/test', file_id: `F${++uploads}` }));
    return new Response(JSON.stringify({ ok: true }));
  };
  const poster = new SlackPoster({ botToken: 'xoxb-test', operator: 'U123', fetch: fetcher, dotPath: 'dot' });
  await poster.publishHome('Status', { graph: { nodes: [{ id: 'session', label: 'A' }], edges: [] } });
  await poster.publishHome('Status', { graph: { nodes: [{ id: 'session', label: 'A' }], edges: [] } });
  assert.ok(!calls.some(c => c.name === 'files.delete'));
  await poster.publishHome('Status', { graph: { nodes: [{ id: 'session', label: 'B' }], edges: [] } });
  const names = calls.map(c => c.name);
  assert.equal(names.filter(n => n === 'files.getUploadURLExternal').length, 2);
  assert.ok(names.lastIndexOf('views.publish') < names.indexOf('files.delete'));
  assert.deepEqual(calls.find(c => c.name === 'files.delete')!.body, { file: 'F1' });
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

test('Home waits for Slack to accept a just-uploaded image instead of losing the whole view', { skip: spawnSync('dot', ['-V']).status !== 0 }, async () => {
  const publishes: boolean[] = [];
  let refusals = 2;
  const fetcher: typeof fetch = async (url, init) => {
    const name = String(url).split('/').pop()!;
    if (name === 'files.getUploadURLExternal') return new Response(JSON.stringify({ ok: true, upload_url: 'https://files.slack.com/upload/test', file_id: 'F1' }));
    if (name !== 'views.publish') return new Response(JSON.stringify({ ok: true }));
    const image = JSON.parse(String(init?.body)).view.blocks.some((b: any) => b.type === 'image');
    publishes.push(image);
    return new Response(JSON.stringify(image && refusals-- > 0 ? { ok: false, error: 'invalid_arguments' } : { ok: true }));
  };
  const poster = new SlackPoster({ botToken: 'xoxb-test', operator: 'U123', fetch: fetcher, dotPath: 'dot', imageRetryMs: 0 });
  await poster.publishHome('Status', { graph: { nodes: [{ id: 'session', label: 'A' }], edges: [] } });
  assert.deepEqual(publishes, [true, true, true]);
});

test('Home falls back to the text view when Slack never accepts the image', { skip: spawnSync('dot', ['-V']).status !== 0 }, async () => {
  const publishes: boolean[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const name = String(url).split('/').pop()!;
    if (name === 'files.getUploadURLExternal') return new Response(JSON.stringify({ ok: true, upload_url: 'https://files.slack.com/upload/test', file_id: 'F1' }));
    if (name !== 'views.publish') return new Response(JSON.stringify({ ok: true }));
    const image = JSON.parse(String(init?.body)).view.blocks.some((b: any) => b.type === 'image');
    publishes.push(image);
    return new Response(JSON.stringify(image ? { ok: false, error: 'invalid_arguments' } : { ok: true }));
  };
  const poster = new SlackPoster({ botToken: 'xoxb-test', operator: 'U123', fetch: fetcher, dotPath: 'dot', imageRetryMs: 0 });
  await poster.publishHome('Status', { graph: { nodes: [{ id: 'session', label: 'A' }], edges: [] } });
  assert.equal(publishes.at(-1), false);
});

test('Home publish log line carries a timestamp so a restart can be told apart from an old publish', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'info', (line: string) => { lines.push(String(line)); });
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ ok: true }));
  const poster = new SlackPoster({ botToken: 'xoxb-test', operator: 'U123', fetch: fetcher, dotPath: 'dot', imageRetryMs: 0 });
  await poster.publishHome('Status', { graph: { nodes: [{ id: 'session', label: 'A' }], edges: [] } });
  assert.match(lines.join('\n'), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z App Home published/m);
});
