import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Commitment } from '../src/commitments.ts';
import { backgroundSummary, commitmentItems, idleLine, pendingCi, readPrItems, renderWork, renderWorkParts, type HomeWork } from '../src/home-items.ts';

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
  assert.match(text, /• <https:\/\/github\.com\/lennix1337\/pi-optchat\/pull\/13\|pi-optchat#13 Assistente pessoal> · checks verdes/);
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
  assert.equal(idleLine(work({ prs: [pr(7, 'pendentes')] })), '\u23f3 *Esperando CI de r#7* \u00b7 chat livre');
  assert.equal(idleLine(work({ jobs: ['j'], prs: [pr(7, 'pendentes')] })), '\u23f3 *Em segundo plano* (1 comando rodando; esperando CI de r#7) \u00b7 chat livre');
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
