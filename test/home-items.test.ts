import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Commitment } from '../src/commitments.ts';
import { backgroundSummary, commitmentItems, headline, idleLine, pendingCi, readPrItems, readWatch, renderWork, renderWorkParts, runningItem, stillWaiting, watchReadBytes, type HomeWork } from '../src/home-items.ts';
import { PRS } from '../src/slack-reports.ts';

const NOW = Date.parse('2026-11-02T15:00:00Z');
const commitment = (over: Partial<Commitment>): Commitment => ({
  id: 'c_1', text: 'Fechar o PR', owner: 'optchat', source: '12', createdAt: '2026-11-02T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z',
  progressAt: '2026-11-02T10:00:00Z', status: 'open', notes: [], ...over,
});

test('readPrItems: only the open PRs of the watch, with their CI verdict and a link', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-items-'));
  try {
    writeFileSync(join(dir, 'pr-watch.json'), JSON.stringify({
      'lennix1337/pi-optchat#13': { sig: 'OPEN:SUCCESS', seen: 1, title: 'Assistente pessoal', url: 'https://github.com/lennix1337/pi-optchat/pull/13', channel: 'harness' },
      'tecnologia-ai/dentai#97': { sig: 'OPEN:FAILURE', seen: 2, title: 'auth', url: 'https://github.com/tecnologia-ai/dentai/pull/97', channel: 'dentai' },
      'lennix1337/dotfiles#10': { sig: 'OPEN:NONE', seen: 3, title: 'sem checks', url: 'https://github.com/lennix1337/dotfiles/pull/10', channel: 'harness' },
      'lennix1337/x#1': { sig: 'MERGED:SUCCESS', seen: 4, title: 'feita', url: 'https://github.com/lennix1337/x/pull/1', channel: 'harness' },
    }));
    const prs = readPrItems(dir);
    assert.deepEqual(prs.map(p => `${p.repo}#${p.number}`), ['tecnologia-ai/dentai#97', 'lennix1337/pi-optchat#13', 'lennix1337/dotfiles#10'], 'failing CI first');
    assert.deepEqual(prs.map(p => p.checks), ['vermelhos', 'verdes', 'sem checks']);
    assert.equal(prs[1]!.url, 'https://github.com/lennix1337/pi-optchat/pull/13');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readPrItems: a missing or damaged watch file lists nothing and does not throw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-items-'));
  try {
    assert.deepEqual(readPrItems(dir), []);
    writeFileSync(join(dir, 'pr-watch.json'), '{ not json');
    assert.deepEqual(readPrItems(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('commitmentItems: open work of OptChat, not the items already waiting on the operator, with a link when the item names one', () => {
  const items = [
    commitment({ id: 'c_1', text: 'Revisar o PR https://github.com/lennix1337/pi-optchat/pull/9', status: 'blocked', next: 'esperar CI' }),
    commitment({ id: 'c_2', text: 'Decidir o deploy', owner: 'operator' }),
    commitment({ id: 'c_3', text: 'Aguardar o Stripe', status: 'waiting_operator' }),
    commitment({ id: 'c_4', text: 'Já feito', status: 'done' }),
    commitment({ id: 'c_5', text: 'Abrir issue' }),
  ];
  const got = commitmentItems(items, NOW);
  assert.deepEqual(got.map(c => c.text), ['Revisar o PR https://github.com/lennix1337/pi-optchat/pull/9', 'Abrir issue'], 'the operator-owned and waiting ones are listed in "Esperando você"');
  assert.equal(got[0]!.status, 'bloqueado');
  assert.equal(got[0]!.url, 'https://github.com/lennix1337/pi-optchat/pull/9');
  assert.equal(got[1]!.url, undefined);
});

const work = (over: Partial<HomeWork> = {}): HomeWork => ({ prs: [], commitments: [], jobs: [], ...over });
const pr = (n: number, title = 'um PR') => ({ repo: 'lennix1337/pi-optchat', number: n, title, url: `https://github.com/lennix1337/pi-optchat/pull/${n}`, checks: 'verdes' as const });

test('renderWork: sections of open PRs (linked), commitments and running jobs; empty sections are not shown', () => {
  const text = renderWork(work({ prs: [pr(13, 'Assistente pessoal')], commitments: [{ text: 'Revisar', status: 'em aberto' }], jobs: ['bash-3 · npm test'] }));
  assert.match(text, /\*PRs abertas\* \(1\)/);
  assert.match(text, /• <https:\/\/github\.com\/lennix1337\/pi-optchat\/pull\/13\|pi-optchat#13 Assistente pessoal> · 🟢 checks verdes/);
  assert.ok(text.indexOf('Rodando agora') < text.indexOf('PRs abertas'), 'what runs now comes first');
  assert.match(text, /\*Compromissos abertos\* \(1\)\n• Revisar · em aberto/);
  assert.match(text, /\*Rodando agora\* \(1\)\n• bash-3 · npm test/);
  assert.equal(renderWork(work()), '', 'nothing open: nothing shown');
  assert.doesNotMatch(renderWork(work({ prs: [pr(1)] })), /Rodando agora/);
});

test('renderWork: item text is escaped for Slack (a stray < or & cannot break the links)', () => {
  const text = renderWork(work({ prs: [pr(2, 'fix <script> & cia')], jobs: ['cmd a<b && c>d'] }));
  assert.match(text, /fix &lt;script&gt; &amp; cia/);
  assert.match(text, /cmd a&lt;b &amp;&amp; c&gt;d/);
});

test('renderWork: a section keeps whole items within its budget and says how many more there are', () => {
  const prs = Array.from({ length: 9 }, (_, i) => pr(i + 1, 'x'.repeat(300)));
  const text = renderWork(work({ prs }));
  const kept = (text.match(/^• /gm) ?? []).length;
  assert.ok(kept >= 1 && kept <= 4, `kept ${kept}`);
  assert.ok(text.endsWith(`… mais ${9 - kept} (toque em *Ver tudo*)`), text.slice(-60));
});

test('renderWork: at most 4 items per section, however short, and the rest is counted', () => {
  const prs = Array.from({ length: 9 }, (_, i) => pr(i + 1, 'x'));
  const text = renderWork(work({ prs }));
  const kept = (text.match(/^• /gm) ?? []).length;
  assert.ok(kept <= 4, `kept ${kept}`);
  assert.ok(text.endsWith(`… mais ${9 - kept} (toque em *Ver tudo*)`), text.slice(-60));
});

test('renderWorkParts: Ver tudo lists every item and says nothing was hidden; subagents count as running', () => {
  const prs = Array.from({ length: 9 }, (_, i) => pr(i + 1, 'x'));
  const folded = renderWorkParts(work({ prs }));
  assert.equal(folded.hidden, 9 - (folded.text.match(/^\u2022 /gm) ?? []).length);
  assert.ok(folded.hidden > 0);
  const open = renderWorkParts(work({ prs }), true);
  assert.equal(open.hidden, 0);
  assert.equal((open.text.match(/^• /gm) ?? []).length, 9);
  const running = work({ jobs: ['bash-1 · npm test'], agents: ['subagente a1 · revisar'] });
  assert.match(renderWork(running), /\*Rodando agora\* \(2\)\n• subagente a1 · revisar\n• bash-1 · npm test/);
  assert.equal(backgroundSummary(running), '1 subagente e 1 comando');
  assert.equal(backgroundSummary(work({ agents: ['a', 'b'] })), '2 subagentes');
  assert.equal(backgroundSummary(work()), '');
});

test('idleLine: running work and pending CI are named; nothing awaited is empty', () => {
  const pr = (number: number, checks: 'pendentes' | 'verdes') => ({ repo: 'o/r', number, title: 't', url: 'https://x/1', checks });
  assert.equal(pendingCi(work({ prs: [pr(1, 'verdes')] })), '');
  assert.equal(pendingCi(work({ prs: [pr(1, 'pendentes'), pr(2, 'pendentes')] })), 'CI de r#1 e r#2');
  assert.equal(pendingCi(work({ prs: [pr(1, 'pendentes'), pr(2, 'pendentes'), pr(3, 'pendentes')] })), 'CI de 3 PRs');
  assert.equal(idleLine(work({ prs: [pr(7, 'pendentes')] })), '\u23f3 *Parado, esperando CI de r#7*');
  assert.equal(idleLine(work({ jobs: ['j'], prs: [pr(7, 'pendentes')] })), '\u23f3 *Em segundo plano* (1 comando rodando; esperando CI de r#7)');
  assert.equal(idleLine(work({ prs: [pr(7, 'verdes')] })), '');
});

test('renderWork: the whole block stays under its character budget, and a line is never cut inside its link', () => {
  const long = 'y'.repeat(200);
  const text = renderWork(work({
    prs: Array.from({ length: 4 }, (_, i) => pr(i + 1, long)),
    commitments: Array.from({ length: 4 }, () => ({ text: long, status: 'bloqueado', url: 'https://github.com/a/b/pull/1' })),
    jobs: Array.from({ length: 4 }, () => long),
  }));
  assert.ok(text.length <= 900, `text has ${text.length} chars`);
  assert.match(text, /\*Rodando agora\*/, 'a later section still shows, with what fits');
  for (const line of text.split('\n').filter(l => l.startsWith('• '))) assert.equal((line.match(/</g) ?? []).length, (line.match(/>/g) ?? []).length, `unbalanced link: ${line.slice(-60)}`);
});

test('headline: a PR title or commitment reads in about 8 words, without its aside (03/11 Home cut them mid-sentence)', () => {
  assert.equal(headline('Gitwatch acorda sozinho em merge por auto-merge (operador 03/11: só recebia junto com msg dele): PR no pi-gitwatch'), 'Gitwatch acorda sozinho em merge por auto-merge');
  assert.equal(headline('Release mais segura: preflight antes de criar estado remoto'), 'Release mais segura');
  assert.equal(headline('um dois três quatro cinco seis sete oito nove dez'), 'um dois três quatro cinco seis sete oito\u2026');
  assert.equal(headline('Fix: x'), 'Fix: x', 'a short head is not a title on its own');
});

test('stillWaiting: an item whose named PRs all merged or closed leaves the Home; open or unknown ones stay', () => {
  const watch = { 'o/Genexus18MCP#843': { sig: 'MERGED:SUCCESS' }, 'o/pi-optchat#92': { sig: 'OPEN:PENDING' }, 'o/r#5': { sig: 'CLOSED:NONE' } };
  const items = [
    { text: 'Home mostra Esperando', ask: 'Confirme Esperando CI de Genexus18MCP#843 (GX18MCP #843)' },
    { text: 'Ver r#5 e pi-optchat #92' },
    { text: 'Confirmar o resumo das 07:00' },
    { text: 'Ver x#1, que o watch não conhece' },
  ];
  assert.deepEqual(stillWaiting(items, watch).map(i => i.text), ['Ver r#5 e pi-optchat #92', 'Confirmar o resumo das 07:00', 'Ver x#1, que o watch não conhece']);
});

test('readWatch and readPrItems cache by stat and do not re-read unchanged slack-prs.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-watch-'));
  try {
    const file = join(dir, PRS);
    writeFileSync(file, JSON.stringify({ 'o/r#1': { sig: 'OPEN:SUCCESS', url: 'https://github.com/o/r/pull/1', title: 'One' } }));
    assert.equal(Object.keys(readWatch(dir)).length, 1);
    const before = watchReadBytes;
    assert.equal(Object.keys(readWatch(dir)).length, 1);
    assert.equal(readPrItems(dir).length, 1);
    assert.equal(watchReadBytes - before, 0, 'unchanged slack-prs.json must not be re-read');
    writeFileSync(file, JSON.stringify({ 'o/r#1': { sig: 'OPEN:SUCCESS', url: 'https://github.com/o/r/pull/1', title: 'One' }, 'o/r#2': { sig: 'OPEN:PENDING', url: 'https://github.com/o/r/pull/2', title: 'Two' } }));
    assert.equal(readPrItems(dir).length, 2);
    assert.ok(watchReadBytes > before, 'updated slack-prs.json must be re-read');
    rmSync(file);
    assert.deepEqual(readWatch(dir), {});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runningItem: a worker shows what it does and for how long', () => {
  const t0 = Date.parse('2026-11-21T23:00:00Z');
  assert.equal(runningItem('agy Neon: 3 candidatos', t0, t0 + 12 * 60_000), 'agy Neon: 3 candidatos \u00b7 h\u00e1 12 min');
  assert.equal(runningItem('build', t0, t0 + 3 * 3_600_000), 'build \u00b7 h\u00e1 3 h');
});

test('a running worker shows its worktree and goal, not the brief boilerplate', async () => {
  const { workerHome } = await import('../src/home-dashboard.ts');
  assert.deepEqual(workerHome("You are a subagent. Don't write memory pages.\nImplement the Slack task thread.\nMore.", '/home/u/projetos/pi-optchat/worktrees/task-thread'),
    { label: 'task-thread: Implement the Slack task thread.', target: { repo: 'pi-optchat' } });
  assert.deepEqual(workerHome('Goal: radar reply deadlines\nAcceptance: x', 'C:\\Projetos\\dotfiles'), { label: 'dotfiles: radar reply deadlines', target: { repo: 'dotfiles' } });
  assert.deepEqual(workerHome('You are a subagent.'), { label: 'Trabalho em andamento' });
  assert.deepEqual(workerHome('You are a subagent.', '/p/x/worktrees/fix-a'), { label: 'fix-a: tarefa sem descrição', target: { repo: 'x' } });
  assert.equal(workerHome('Edit src/home.ts and a.b.c now. then more.', '/p/x/worktrees/w').label, 'w: Edit src/home.ts and a.b.c now.');
  assert.deepEqual(workerHome('You are a subagent.', '/p/x'), { label: 'x: tarefa sem descrição', target: { repo: 'x' } });
  assert.deepEqual(workerHome('Fix it.', '/p/x/worktrees'), { label: 'x: Fix it.', target: { repo: 'x' } });
  assert.equal(workerHome(`Goal: ${'a'.repeat(300)}`, '/p/x').label.length, 'x: '.length + 120);
});
