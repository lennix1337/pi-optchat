import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pcProbes } from '../src/pc-health.ts';
import { ProdHealth, registerProdHealth, type Transition } from '../src/prod-health.ts';
import { applyRemedies, fixLines, readFixes, RETRY_AFTER_MS, type Remedy } from '../src/self-fix.ts';
import { composeSummary, localInputs } from '../src/slack-reports.ts';

const H = 3_600_000;
const down = (probe: string): Transition => ({ probe, kind: 'down', text: `🔴 ${probe} com problema` });
const up = (probe: string): Transition => ({ probe, kind: 'recovered', text: `✅ ${probe} voltou` });
const counting = (fail?: string) => { const r = { label: 'a manutenção do PC', runs: 0, run: async () => { r.runs++; if (fail) throw new Error(fail); } }; return r; };
/** A scratch directory removed when the test ends. */
const scratch = (t: TestContext) => { const dir = mkdtempSync(join(tmpdir(), 'selffix-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };

test('an outage with a remedy is fixed alone: it runs once, the alert says so, the recovery says solved alone', async t => { const dir = scratch(t);
  const disk = counting(), remedies = new Map<string, Remedy>([['PC: disco C:', disk]]);
  const [alert] = await applyRemedies([down('PC: disco C:')], remedies, dir, 10 * H);
  assert.equal(disk.runs, 1);
  assert.match(alert!.text, /já rodei a manutenção do PC sozinho; aviso se não resolver$/);
  const [back] = await applyRemedies([up('PC: disco C:')], remedies, dir, 11 * H);
  assert.match(back!.text, /resolvido sozinho \(a manutenção do PC\)$/);
  assert.equal(disk.runs, 1, 'a recovery runs nothing');
  assert.deepEqual(readFixes(dir).map(f => [f.outcome, f.resolvedAt]), [['resolved', 11 * H]]);
  assert.match(fixLines(readFixes(dir), 12 * H)[0]!, /^PC: disco C:: a manutenção do PC às \d\d:\d\d · resolvido$/);
  assert.deepEqual(fixLines(readFixes(dir), 40 * H), [], 'the summary keeps the last 24 hours');
});

test('a remedy that did not help is not repeated: the next alert asks for the operator, and retries after the window', async t => { const dir = scratch(t);
  const disk = counting(), remedies = new Map<string, Remedy>([['PC: disco C:', disk]]);
  await applyRemedies([down('PC: disco C:')], remedies, dir, 0);
  const [again] = await applyRemedies([down('PC: disco C:')], remedies, dir, 2 * H);
  assert.equal(disk.runs, 1);
  assert.match(again!.text, /já rodei a manutenção do PC às \d\d:\d\d e não resolveu: preciso de você$/);
  await applyRemedies([down('PC: disco C:')], remedies, dir, RETRY_AFTER_MS + 1);
  assert.equal(disk.runs, 2);
});

test('a failing remedy is reported as needing the operator; a probe without remedy is left as it was', async t => { const dir = scratch(t);
  const broken = counting('ERRO: a tarefa não existe'), remedies = new Map<string, Remedy>([['PC: disco C:', broken]]);
  const [failed, plain] = await applyRemedies([down('PC: disco C:'), down('PC: memória')], remedies, dir, 0);
  assert.match(failed!.text, /tentei a manutenção do PC e falhou \(ERRO: a tarefa não existe\): preciso de você$/);
  assert.equal(plain!.text, '🔴 PC: memória com problema');
  assert.equal(readFixes(dir)[0]!.outcome, 'failed');
});

test('the PC disk and maintenance probes carry the maintenance remedy; memory has none; null turns it off', () => {
  const remedy = counting();
  const probes = pcProbes({ drive: 'C:\\', reportDir: 'X', maintenance: remedy, reports: () => [] });
  assert.deepEqual(probes.map(p => [p.name, p.remedy === remedy]), [['PC: disco C:', true], ['PC: memória', false], ['PC: manutenção diária', true]]);
  assert.ok(pcProbes({ maintenance: null }).every(p => !p.remedy));
});

test('registered: a low disk runs the maintenance alone, tells the DM so, and the 07:00 summary leads with it', async t => { const dir = scratch(t);
  writeFileSync(join(dir, 'assistant.json'), '{}');
  let free = 5e9, now = 10 * H;
  const remedy = counting();
  const pc = new ProdHealth({ file: 'pc-health.json', now: () => now, probes: pcProbes({ drive: 'C:\\', maintenance: remedy, disk: () => ({ free, total: 1000e9 }), memory: () => ({ free: 20e9, total: 32e9 }) }).slice(0, 2) });
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const posts: [string, string | null][] = [], wakes: string[] = [];
  const pi = { on: () => {}, registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, c) };
  registerProdHealth(pi as never, () => ({ dir }), async (text, channel) => { posts.push([text, channel]); }, text => { wakes.push(text); }, [{ health: pc, channel: null, wakes: false }]);
  const status = () => commands.get('optchat-health')!.handler('', { ui: { notify: () => undefined } });
  await status(); await status();
  assert.equal(remedy.runs, 1);
  assert.deepEqual(posts.map(([t, c]) => [c, /disco C: com problema .* já rodei a manutenção do PC sozinho/.test(t)]), [[null, true]]);
  free = 120e9; now += H;
  await status();
  assert.match(posts[1]![0], /voltou .* resolvido sozinho/);
  assert.deepEqual(wakes, [], 'the PC never wakes the agent');
  const summary = composeSummary({ ...localInputs(dir, now, []), waiting: [], approvals: 0 });
  assert.match(summary, /^☀️ \*Bom dia! Resumo das últimas 24h\*\n\n\*Resolvi sozinho\*\n• PC: disco C:: a manutenção do PC às \d\d:\d\d · resolvido\n\n\*Feito\*/);
});
