import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { projectOf, projectOfRun } from '../src/projects.ts';
import { composeSummary, DailySummary, logSent, prChange, PrWatch, readDay } from '../src/slack-reports.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'slack-reports-'));
type Posted = { text: string; channel: string | null; topic?: string };
const recorder = () => { const posts: Posted[] = []; return { posts, post: async (text: string, channel: string | null, topic?: string) => { posts.push({ text, channel, topic }); } }; };

test('projects come from projetos/<repo> paths, most mentioned first', () => {
  assert.equal(projectOf('cd C:/projetos/dentai-mono && pnpm test'), 'dentai');
  assert.equal(projectOf('C:\\projetos\\Genexus18MCP'), 'genexus18mcp');
  assert.equal(projectOf('cd C:/projetos/pi-optchat; cat C:/projetos/dotfiles/x; C:/projetos/dentai-mono'), 'harness');
  assert.equal(projectOf('C:/projetos/other-thing'), undefined);
  const run = [{ role: 'assistant', content: [
    { type: 'toolCall', name: 'read', arguments: { path: 'C:/projetos/dentai-mono/a.ts' } },
    { type: 'toolCall', name: 'read', arguments: { path: 'C:/projetos/dentai-mono/b.ts' } },
    { type: 'toolCall', name: 'edit', arguments: { path: 'C:/projetos/pi-optchat/src/x.ts' } }] }] as unknown as AgentMessage[];
  assert.equal(projectOfRun(run), 'harness', 'where it delivered wins over where it read');
});

test('PR changes: CI green/red, merged, closed, and only freshly opened PRs announce themselves', () => {
  const now = 10 * 3_600_000;
  assert.equal(prChange('OPEN:PENDING', { state: 'OPEN', ci: 'SUCCESS', createdAt: 0 }, now), '✅ CI verde');
  assert.equal(prChange('OPEN:SUCCESS', { state: 'OPEN', ci: 'FAILURE', createdAt: 0 }, now), '❌ CI vermelho');
  assert.equal(prChange('OPEN:SUCCESS', { state: 'OPEN', ci: 'PENDING', createdAt: 0 }, now), undefined);
  assert.equal(prChange('OPEN:SUCCESS', { state: 'MERGED', ci: 'SUCCESS', createdAt: 0 }, now), '🟣 Mergeado');
  assert.equal(prChange('OPEN:SUCCESS', { state: 'CLOSED', ci: 'SUCCESS', createdAt: 0 }, now), '⚪ Fechado sem merge');
  assert.equal(prChange(undefined, { state: 'OPEN', ci: 'PENDING', createdAt: now - 3_600_000 }, now), '🆕 PR aberto');
  assert.equal(prChange(undefined, { state: 'OPEN', ci: 'SUCCESS', createdAt: 0 }, now), undefined, 'an old PR seen for the first time is not news');
  assert.equal(prChange('OPEN:SUCCESS', { state: 'OPEN', ci: 'SUCCESS', createdAt: 0 }, now), undefined);
});

test('a profile without the assistant never asks GitHub: nothing could be posted', async () => {
  const dir = temp();
  try {
    const calls: string[][] = [];
    const watch = new PrWatch(() => ({ dir, name: 'p' }), recorder().post, async args => { calls.push(args); return '{}'; });
    assert.equal(await watch.poll(), 0);
    assert.deepEqual(calls, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the PR watch records silently on its first pass, then posts changes in each PR thread', async () => {
  const dir = temp();
  writeFileSync(join(dir, 'assistant.json'), '{}');
  try {
    const node = (state: string, ci: string, repo = 'pi-optchat') => ({ number: 13, title: 'Inbox', url: `https://github.com/lennix1337/${repo}/pull/13`, state, isDraft: false, createdAt: '2020-01-01T00:00:00Z',
      repository: { name: repo, nameWithOwner: `lennix1337/${repo}` }, commits: { nodes: [{ commit: { statusCheckRollup: { state: ci } } }] } });
    let nodes = [node('OPEN', 'PENDING'), node('OPEN', 'PENDING', 'elsewhere')];
    const calls: string[][] = [];
    const r = recorder();
    const watch = new PrWatch(() => ({ dir, name: 'p' }), r.post, async args => { calls.push(args); return JSON.stringify({ data: { search: { nodes } } }); }, () => Date.parse('2026-10-29T12:00:00Z'));
    assert.equal(await watch.poll(), 0);
    assert.match(calls[0]!.join(' '), /q=is:pr author:@me updated:>=2026-10-27/);
    nodes = [node('OPEN', 'FAILURE'), node('OPEN', 'FAILURE', 'elsewhere')];
    assert.equal(await watch.poll(), 1, 'a repo outside the three projects stays silent');
    assert.deepEqual(r.posts[0], { text: '❌ CI vermelho · <https://github.com/lennix1337/pi-optchat/pull/13|pi-optchat#13> Inbox', channel: 'harness', topic: 'pr:lennix1337/pi-optchat#13' });
    assert.equal(await watch.poll(), 0, 'no change, no post');
    nodes = [node('MERGED', 'SUCCESS')];
    assert.equal(await watch.poll(), 1);
    assert.match(r.posts[1]!.text, /^🟣 Mergeado/);
    assert.deepEqual(watch.open(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the morning summary posts once a day between 07:00 and noon, with work done, what waits and the agenda', async () => {
  const dir = temp();
  try {
    let now = new Date(2026, 9, 29, 6, 59).getTime();
    logSent(dir, 'harness', '*Wake* · Corrigi o EPERM do teste', now - 3_600_000);
    logSent(dir, null, '⏸ *Aprovação pendente* · push', now - 3_600_000);
    logSent(dir, 'dentai', 'muito antigo', now - 2 * 86_400_000);
    assert.deepEqual(readDay(dir, now - 86_400_000).map(e => e.line), ['Corrigi o EPERM do teste']);
    const r = recorder();
    const paths: string[] = [];
    const request = async (_o: unknown, path: string, body?: unknown) => {
      paths.push(`${path}${body ? ' POST' : ''}`);
      if (path === '/v1/briefing') return { localDate: body ? '2026-10-29' : '2026-10-28', sources: [{ sourceId: 'pessoal:mail', state: 'partial' }],
        items: [{ section: 'agenda', title: 'Reunião 10h', urgency: 'normal' }, { section: 'messages', title: 'VISITA 30/10', urgency: 'urgent' }, { section: 'messages', title: 'newsletter', urgency: 'low' }] };
      return { tasks: [{ status: 'needs_input', title: 'Qual conta usar?' }, { status: 'working', title: 'x' }] };
    };
    const prs = new PrWatch(() => ({ dir, name: 'p' }), r.post, async () => '{}');
    const daily = new DailySummary(() => ({ dir, name: 'p' }), r.post, prs, () => 1, { now: () => now, request });
    assert.equal(await daily.maybePost(), false, 'before 07:00');
    writeFileSync(join(dir, 'pr-watch.json'), JSON.stringify({ 'o/pi-optchat#9': { sig: 'OPEN:FAILURE', seen: now, since: now - 5 * 3_600_000, title: 'Quebrado', url: 'https://github.com/o/pi-optchat/pull/9', channel: 'harness' } }));
    now += 2 * 60_000;
    assert.equal(await daily.maybePost(), true);
    assert.equal(await daily.maybePost(), false, 'once a day');
    assert.deepEqual(paths, ['/v1/briefing', '/v1/briefing POST', '/v1/tasks?limit=50'], "yesterday's briefing is refreshed first");
    const text = r.posts[0]!.text;
    assert.equal(r.posts[0]!.channel, null);
    for (const part of ['#harness (1)', 'Corrigi o EPERM do teste', '1 aprovação(ões) pendente(s)', 'Pergunta minha: Qual conta usar?', 'Reunião 10h', 'VISITA 30/10', 'pessoal:mail partial', '*Pode dar problema hoje*', '❌ CI vermelha há 5 h: <https://github.com/o/pi-optchat/pull/9|pi-optchat#9> Quebrado'])
      assert.ok(text.includes(part), `missing ${part}`);
    assert.ok(!text.includes('newsletter') && !text.includes('Aprovação pendente'));
    now = new Date(2026, 9, 30, 12, 30).getTime();
    assert.equal(await daily.maybePost(), false, 'a start after noon skips the day');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an empty day still says so', () => {
  const text = composeSummary({ day: [], waiting: [], prs: [], approvals: 0 });
  assert.match(text, /Nada reportado nos canais/);
  assert.match(text, /Esperando você\*\n• Nada\./);
  assert.match(text, /Briefing do Google indisponível/);
});
