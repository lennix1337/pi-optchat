import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskProbe, maintenanceProbe, memoryProbe, pcProbes, REPORT_MAX_AGE_MS } from '../src/pc-health.ts';
import { forecast } from '../src/forecast.ts';
import { FAILURES_BEFORE_ALERT, healthLines, PC_FILE, ProdHealth, readHealth, registerProdHealth, tellTransitions, type Monitor, type Transition } from '../src/prod-health.ts';
import { composeSummary } from '../src/slack-reports.ts';

const GB = 1e9;
const T0 = Date.parse('2026-10-30T22:00:00Z'); // 19:00 in Brasília

test('disk, memory and the maintenance report are judged against their limits', async () => {
  assert.deepEqual(await diskProbe('C:\\', () => ({ free: 122 * GB, total: 1023 * GB })).check(), { ok: true, ms: 0, detail: '122 GB livres de 1023 GB' });
  assert.deepEqual(await diskProbe('C:\\', () => ({ free: 8.4 * GB, total: 1023 * GB })).check(), { ok: false, ms: 0, detail: '8.4 GB livres de 1023 GB', problem: 'só 8.4 GB livres (mínimo 30 GB)' });
  assert.equal(diskProbe('C:\\').name, 'PC: disco C:');
  assert.equal((await memoryProbe(() => ({ free: 8 * GB, total: 64 * GB })).check()).ok, true);
  assert.match((await memoryProbe(() => ({ free: 2 * GB, total: 64 * GB })).check()).problem!, /só 2\.0 GB disponíveis \(3%\)/);
  const reports = (ages: number[]) => () => ages.map((age, i) => ({ name: `report-${i}.json`, mtimeMs: T0 - age }));
  assert.deepEqual(await maintenanceProbe('d', () => T0, reports([3_600_000 * 15, 3_600_000 * 40])).check(), { ok: true, ms: 0, detail: 'último relatório 30/10 04:00' });
  assert.deepEqual(await maintenanceProbe('d', () => T0, reports([REPORT_MAX_AGE_MS + 60_000])).check(), { ok: false, ms: 0, detail: 'último relatório 29/10 06:59', problem: 'não roda desde 29/10 06:59' });
  assert.match((await maintenanceProbe('d', () => T0, () => []).check()).problem!, /nenhum relatório em d/);
  const { runProbe } = await import('../src/prod-health.ts');
  assert.deepEqual(await runProbe({ name: 'x', check: () => { throw new Error('EACCES'); } }, async () => ({ status: 0, body: '' })), { ok: false, ms: 0, problem: 'falha na checagem: EACCES' }, 'a throwing check is a failed probe, not a failed round');
  assert.deepEqual(pcProbes({ drive: '/', reportDir: undefined }).map(p => p.name).slice(0, 2), ['PC: disco /', 'PC: memória']);
});

test('a low disk alerts the DM once after two rounds, never wakes, and reaches the summary and the forecast', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-'));
  try {
    let free = 8 * GB;
    const health = new ProdHealth({ probes: [diskProbe('C:\\', () => ({ free, total: 1000 * GB }))], file: PC_FILE, now: () => T0 });
    const monitor: Monitor = { health, channel: null, wakes: false };
    const posts: [string, string | null][] = [], wakes: string[] = [];
    let transitions: Transition[] = [];
    for (let i = 0; i < FAILURES_BEFORE_ALERT; i++) transitions = [...transitions, ...await health.round(dir)];
    await tellTransitions(transitions, async (text, channel) => { posts.push([text, channel]); }, text => { wakes.push(text); }, false, monitor);
    assert.deepEqual(posts, [['🔴 PC: disco C: com problema às 19:00: só 8.0 GB livres (mínimo 30 GB) (2 checagens seguidas)', null]]);
    assert.deepEqual(wakes, [], 'the operator frees disk; no model turn');
    assert.deepEqual(readHealth(dir), {}, 'production state untouched');
    const pc = readHealth(dir, PC_FILE);
    assert.deepEqual(forecast({ commitments: [], prs: [], health: {}, pc, now: T0 }), ['💾 PC: disco C:: só 8.0 GB livres (mínimo 30 GB) (desde 19:00)']);
    free = 200 * GB;
    await health.round(dir);
    const lines = healthLines(readHealth(dir, PC_FILE));
    assert.deepEqual(lines, ['✅ PC: disco C: · 200 GB livres de 1000 GB']);
    assert.match(composeSummary({ day: [], waiting: [], prs: [], approvals: 0, pc: lines }), /\*Este PC\*\n• ✅ PC: disco C: · 200 GB livres de 1000 GB/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('registered: every monitor runs each round, one failing does not stop the others, and /optchat-health lists all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-'));
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = { on: () => {}, registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, c) };
  const broken = new ProdHealth({ probes: [{ name: 'x', check: () => ({ ok: true, ms: 0 }) }], file: 'broken/deeper/x.json' });
  broken.round = async () => { throw new Error('disk read failed'); };
  const pc = new ProdHealth({ probes: [diskProbe('C:\\', () => ({ free: 100 * GB, total: 500 * GB }))], file: PC_FILE });
  registerProdHealth(pi as never, () => ({ dir }), async () => undefined, () => undefined, [{ health: broken, channel: 'dentai', wakes: true }, { health: pc, channel: null, wakes: false }]);
  const notices: [string, string][] = [];
  try {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'assistant.json'), '{}');
    await commands.get('optchat-health')!.handler('', { ui: { notify: (m: string, level: string) => notices.push([m, level]) } });
    assert.deepEqual(notices, [['✅ PC: disco C: · 100 GB livres de 500 GB\nLast round failed: disk read failed', 'warning']]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
