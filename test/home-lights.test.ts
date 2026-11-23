import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dashboard from '../src/home-dashboard.ts';
import { homeBlocks } from '../assistant/src/channels/slack-relay.ts';
import { readHomeWork } from '../src/home-items.ts';

const now = 1_800_000_000_000;
const work = { prs: [], commitments: [], jobs: [] };
const render = (options: object) => JSON.stringify(homeBlocks('Livre', options));

test('sem PRs produz CI verde', () => {
  const state = dashboard.homeDashboard(work, [], 'idle', undefined, now);
  assert.match(render(state), /🟢 CI \(sem PRs abertos\)/);
});
test('watch ausente ou inválido não vira CI verde', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-watch-'));
  try {
    const state = () => dashboard.homeDashboard(readHomeWork(dir, [], now), [], 'idle', undefined, now);
    assert.match(render(state()), /🟡 CI \(sem leitura\)/);
    writeFileSync(join(dir, 'pr-watch.json'), '{');
    assert.match(render(state()), /🟡 CI \(sem leitura\)/);
    writeFileSync(join(dir, 'pr-watch.json'), '{}');
    assert.match(render(state()), /🟢 CI \(sem PRs abertos\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('checks vermelhos produzem CI vermelho', () => {
  const prs = [{ repo: 'example/repo', number: 1, title: 'test', url: 'https://example.invalid', checks: 'vermelhos' as const }];
  const state = dashboard.homeDashboard({ ...work, prs }, [], 'idle', undefined, now);
  assert.match(render(state), /🔴 CI/);
});
test('CI pendente fica amarelo mesmo com PR verde; vermelho tem prioridade', () => {
  const pr = { repo: 'example/repo', number: 1, title: 'test', url: 'https://example.invalid', checks: 'pendentes' as const };
  assert.match(render(dashboard.homeDashboard({ ...work, prs: [pr] }, [], 'idle', undefined, now)), /🟡 CI/);
  assert.match(render(dashboard.homeDashboard({ ...work, prs: [pr, { ...pr, checks: 'vermelhos' }] }, [], 'idle', undefined, now)), /🔴 CI/);
});
test('linha inválida antiga não esconde rodada recente saudável', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-health-'));
  try {
    writeFileSync(join(dir, 'prod-health.history.jsonl'), `malformed\n${JSON.stringify({ at: now, probe: 'api', ms: 120, ok: true })}\n`);
    assert.match(render({ production: dashboard.homeProduction(dir, now) }), /🟢 Produção \(1\/1 ok, p50 120 ms\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('histórico grande lê apenas o final', t => {
  const dir = mkdtempSync(join(tmpdir(), 'home-health-'));
  const file = join(dir, 'prod-health.history.jsonl');
  try {
    writeFileSync(file, `${'x'.repeat(200_000)}\n${JSON.stringify({ at: now, probe: 'api', ms: 120, ok: true })}\n`);
    const whole = t.mock.method(fs, 'readFileSync');
    const partial = t.mock.method(fs, 'readSync');
    syncBuiltinESMExports();
    assert.match(render({ production: dashboard.homeProduction(dir, now) }), /🟢 Produção \(1\/1 ok, p50 120 ms\)/);
    assert.equal(whole.mock.calls.filter(call => call.arguments[0] === file).length, 0);
    assert.ok(partial.mock.calls.length > 0);
    assert.ok(partial.mock.calls.reduce((sum, call) => sum + Number(call.result), 0) <= 16_384);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(dir, { recursive: true, force: true }); }
});
test('histórico fresco, falha, ausente e antigo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home-health-'));
  try {
    const read = (dashboard as any).homeProduction;
    assert.match(render({ production: read(dir, now) }), /🟡 Produção \(sem leitura/);
    const file = join(dir, 'prod-health.history.jsonl');
    const save = (rows: object[]) => writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    save([{ at: now, probe: 'site', ms: 100, ok: true }, { at: now, probe: 'api', ms: 200, ok: true }]);
    assert.match(render({ production: read(dir, now) }), /🟢 Produção \(2\/2 ok, p50 150 ms\)/);
    save([{ at: now, probe: 'site', ms: 100, ok: true }, { at: now, probe: 'api', ms: 200, ok: false }]);
    assert.match(render({ production: read(dir, now) }), /🔴 Produção \(api/);
    save([{ at: now - 1000, probe: 'site', ms: 100, ok: false }, { at: now, probe: 'api', ms: 200, ok: true }]);
    assert.match(render({ production: read(dir, now) }), /🟢 Produção \(1\/1 ok, p50 200 ms\)/);
    save([{ at: now, probe: 'site', ms: 100, ok: true }, { at: now, probe: 'api', ms: 200 }]);
    assert.match(render({ production: read(dir, now) }), /🟢 Produção \(1\/1 ok, p50 100 ms\)/);
    save([{ at: now - 16 * 60_000, probe: 'site', ms: 100, ok: true }]);
    assert.match(render({ production: read(dir, now) }), /🟡 Produção \(sem leitura há 16min\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
