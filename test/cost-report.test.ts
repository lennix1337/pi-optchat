import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { UsageLedger } from '../src/usage.ts';

const at = (time: string) => `2026-11-20T${time}:00.000Z`;
const pr = (number: number) => `https://github.com/example/widget/pull/${number}`;
const merged = [
  { url: pr(1), at: Date.parse(at('12:06')), branch: 'feat/widget', title: 'Widget pronto' },
  { url: pr(2), at: Date.parse(at('12:22')), branch: 'agy/widget', title: 'Widget revisto' },
];

test('report uses the real ledger index, exact turns, worker run IDs and missing agy data', t => {
  const dir = mkdtempSync(join(tmpdir(), 'cost-delivery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new UsageLedger(dir);
  const usage = (role: 'main' | 'subagent' | 'compactor', id: string, time: string, total: number, runId?: string) => ledger.add({
    id, role, date: at(time), session: 'session', runId,
    provider: role === 'subagent' ? 'openai-codex-account-2' : 'anthropic', model: role === 'subagent' ? 'gpt-test' : 'claude-test',
    usage: { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6, totalTokens: 4e6,
      cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } },
  });
  usage('main', `entry:m1:${at('12:01')}`, '12:01', 4);
  usage('subagent', 'worker', '12:02', 0, 'widget-run');
  usage('main', `entry:m2:${at('12:11')}`, '12:11', 7);
  usage('compactor', 'compress', '12:12', 3);
  usage('main', `entry:m3:${at('12:21')}`, '12:21', 2);
  ledger.summary('All time', 'session');
  ledger.close();

  const sessions = join(dir, 'sessions');
  mkdirSync(sessions);
  mkdirSync(join(dir, 'runs'));
  writeFileSync(join(dir, 'runs', 'widget-run.optchat.json'), JSON.stringify({ id: 'widget-run', cwd: join(dir, 'widget'), started: Date.parse(at('12:00')), report: 'Branch: `feat/widget`' }));
  const mark = (time: string, state: string) => ({ type: 'custom', customType: 'optchat.run', timestamp: at(time), data: { state } });
  const message = (id: string, time: string, role: string, content: unknown, more = {}) => ({ id, type: 'message', timestamp: at(time), message: { role, content, ...more } });
  const call = (id: string, command: string) => ({ type: 'toolCall', id, name: 'bash', arguments: { command } });
  const result = (id: string, time: string, toolCallId: string, content: string) => message(id, time, 'toolResult', [{ type: 'text', text: content }], { toolCallId });
  writeFileSync(join(sessions, 'session.jsonl'), [
    { type: 'session', id: 'session' },
    mark('12:00', 'start'), message('m1', '12:01', 'assistant', [call('ship1', 'node scripts/ship.mjs')]),
    result('r1', '12:06', 'ship1', `url: "${pr(1)}"\nauto_merge: queued\nrc: 0`),
    result('d1', '12:07', 'deploy', 'RESUMO: abc12345 no ar às 09:07; merge —, deploy 2 min, total 2 min.'), mark('12:08', 'end'),
    mark('12:10', 'start'), message('m2', '12:11', 'assistant', []), mark('12:13', 'end'),
    mark('12:20', 'start'), message('m3', '12:21', 'assistant', [call('ship2', 'node scripts/ship.mjs')]),
    result('agy', '12:21', 'agy', '(agy model: gemini-fixture; quota left: 87%; conversation fixture)\n==== worktree /checkout/widget/worktrees/agy-widget branch agy/widget'),
    result('r2', '12:22', 'ship2', `url: "${pr(2)}"\nstatus: merged\nrc: 0`), mark('12:23', 'end'),
    result('d2', '12:24', 'later', 'RESUMO: abc12345 no ar às 09:07; merge —, deploy 2 min, total 2 min.'),
  ].map(e => JSON.stringify(e)).join('\n') + '\n');
  const config = join(dir, 'report.json');
  writeFileSync(config, JSON.stringify({ deployRepo: 'example/widget', prices: [{ provider: 'openai-codex', modelPrefix: 'gpt-', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reference: 'lista de teste' }] }));
  const gh = join(dir, 'merges.json');
  writeFileSync(gh, JSON.stringify(merged));
  const out = spawnSync(process.execPath, ['scripts/cost-report.mjs', '--profile-dir', dir, '--sessions-dir', sessions, '--config', config, '--merges', gh, '--week', '2026-11-16', '--json'], { encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
  assert.equal(out.status, 0, out.stderr);
  const report = JSON.parse(out.stdout);
  assert.deepEqual(report.deliveries.map(({ kind, cost, known, source }: Record<string, unknown>) => ({ kind, cost, known, source })), [
    { kind: 'pr', cost: 12, known: 12, source: 'estimado (preço de tabela)' },
    { kind: 'deploy', cost: 2, known: 2, source: 'medido' },
    { kind: 'pr', cost: null, known: 2, source: 'sem estimativa' },
  ]);
  assert.equal(report.overhead['sem entrega'].known, 7);
  assert.equal(report.overhead.compactor.known, 3);
  assert.equal(report.byProvider['openai-codex-account-2'].known, 10);
  assert.equal(report.byRepo['example/widget'].known, 16);
  assert.deepEqual(report.stats, { count: 2, omitted: 1, median: 7, p25: 4.5, p75: 9.5 });
  assert.equal(report.rolling.length, 7);
  assert.equal(report.rolling.at(-1).median, 7);
  assert.match(report.deliveries.at(-1).reasons.join(' '), /agy.*tokens/);
  assert.equal(report.agyUnpriced, 1);
  assert.equal(report.top[0].workers, 1);
  assert.deepEqual(report.top[0].models, ['gpt-test', 'claude-test']);
});
