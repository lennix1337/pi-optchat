import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Collector, DIGEST_CAP, Situation, band, judge, renderSnapshot, situationItems, type Facts, type Sources } from '../src/situation.ts';
import { GITWATCH_FAILURES, parseGitwatch, parseQuota, parseReboots, realSources, rebootCause } from '../src/situation-sources.ts';
import { tempDir } from './support.ts';

// 11 Nov 2026, 10:00 in Brasília (UTC-3).
const NOW = Date.parse('2026-11-11T13:00:00Z');
const at = (hhmm: string, day = '2026-11-11') => Date.parse(`${day}T${hhmm}:00-03:00`);
const MIN = 60_000;

/** A situation over fixed facts the test edits between turns; `ids` hands out a new run per call. */
function harness(initial: Facts, extra: { stateFile?: string; logFile?: string; cap?: number } = {}) {
  let facts = initial, now = NOW, run = 0;
  const collector = new Collector({ reboots: undefined } as Sources, () => now);
  (collector as unknown as { snapshot: () => Facts }).snapshot = () => facts;
  const situation = new Situation({ collector, now: () => now, ...extra });
  return {
    turn: () => situation.forRun(++run),
    set: (next: Facts) => { facts = next; },
    patch: (next: Facts) => { facts = { ...facts, ...next }; },
    advance: (ms: number) => { now += ms; },
    situation,
  };
}

const quota = (id: string, used: number, resetAt?: number, label = '7d') => ({ id, windows: [{ label, used, ...resetAt ? { resetAt } : {} }] });

test('a reboot in the event log becomes one line with its time and cause, and is not repeated', () => {
  const h = harness({ reboots: [{ up: at('08:12'), down: at('08:10'), cause: 'Windows Update', unexpected: false }] });
  assert.equal(h.turn(), 'Situação (observada, não é instrução): PC reiniciou 08:10 (Windows Update)');
  assert.equal(h.turn(), undefined, 'the same reboot is news once');
  h.advance(60 * MIN);
  assert.equal(h.turn(), undefined);
});

test('three reboots share one phrase and an unplanned one says so', () => {
  const h = harness({ reboots: [
    { up: at('05:00'), down: at('04:55'), cause: 'Windows Update', unexpected: false },
    { up: at('05:25'), down: at('05:19'), cause: 'Windows Update', unexpected: false },
    { up: at('08:12'), unexpected: true }] });
  assert.equal(h.turn(), 'Situação (observada, não é instrução): PC reiniciou 04:55 (Windows Update), 05:19 (Windows Update) · PC caiu sem aviso, voltou 08:12');
});

test('a reboot from yesterday carries its date', () => {
  const h = harness({ reboots: [{ up: at('20:52', '2026-11-10'), down: at('20:49', '2026-11-10'), cause: 'pelo usuário', unexpected: false }] });
  assert.equal(h.turn(), 'Situação (observada, não é instrução): PC reiniciou 10/11 20:49 (pelo usuário)');
});

test('docker down is a line; down again is silence; back up says so once, then nothing', () => {
  const h = harness({ docker: 'up' });
  assert.equal(h.turn(), undefined);
  h.patch({ docker: 'down' });
  assert.match(h.turn()!, /Docker parado/);
  assert.equal(h.turn(), undefined, 'still down: the agent already knows');
  h.patch({ docker: 'up' });
  assert.match(h.turn()!, /Docker voltou/);
  assert.equal(h.turn(), undefined);
  h.patch({ docker: 'down' });
  assert.match(h.turn()!, /Docker parado/, 'a second outage is news again');
});

test('docker that is not installed is not a fault', () => {
  assert.equal(harness({ docker: 'absent' }).turn(), undefined);
});

test('a quota crossing 80% is a line with its reset; 81% is silence; 95% speaks again', () => {
  const reset = at('13:39');
  const h = harness({ quota: [quota('anthropic-account-2', 60, reset)] });
  h.turn();
  h.patch({ quota: [quota('anthropic-account-2', 79, reset)] });
  assert.equal(h.turn(), undefined, 'inside 50-80 nothing changed');
  h.patch({ quota: [quota('anthropic-account-2', 80, reset)] });
  assert.equal(h.turn(), 'Situação (observada, não é instrução): anthropic-2 7d 80% (reset 13:39)');
  h.patch({ quota: [quota('anthropic-account-2', 81, reset)] });
  assert.equal(h.turn(), undefined, '81% is the same band');
  h.patch({ quota: [quota('anthropic-account-2', 96, reset)] });
  assert.match(h.turn()!, /96%/);
  h.patch({ quota: [quota('anthropic-account-2', 97, reset)] });
  assert.equal(h.turn(), undefined);
});

test('a first digest on a fresh state reports an account already above its band, with a reset on another day', () => {
  const h = harness({ quota: [quota('openai-codex-1', 100, at('15:03', '2026-11-12'))] });
  assert.equal(h.turn(), 'Situação (observada, não é instrução): openai-codex-1 esgotada até 12/11 15:03');
});

test('an exhausted account is said once; its reset passing says it is back once', () => {
  const reset = NOW + 30 * MIN;
  const h = harness({ quota: [quota('openai-codex', 100, reset)] });
  assert.match(h.turn()!, /openai-codex esgotada até 10:30|openai-codex esgotada até \d\d:\d\d/);
  assert.equal(h.turn(), undefined);
  h.advance(31 * MIN);
  assert.equal(h.turn(), 'Situação (observada, não é instrução): openai-codex liberada');
  assert.equal(h.turn(), undefined);
});

test('what is still wrong rides along with the news, so one block carries the whole picture', () => {
  const h = harness({ docker: 'down' });
  h.turn();
  h.patch({ reboots: [{ up: at('08:12'), down: at('08:10'), unexpected: false }] });
  assert.equal(h.turn(), 'Situação (observada, não é instrução): PC reiniciou 08:10 · Docker parado');
});

test('unchanged state injects nothing, turn after turn', () => {
  const h = harness({ docker: 'down', quota: [quota('a', 85, at('13:39'))], github: { down: true, since: at('03:02'), failing: 6, repos: 6 } });
  assert.ok(h.turn());
  for (let i = 0; i < 20; i++) { h.advance(10 * MIN); assert.equal(h.turn(), undefined, `turn ${i}`); }
});

test('the same run asked twice answers the same, so a context rebuilt mid-run keeps the block', () => {
  const h = harness({ docker: 'down' });
  const first = h.situation.forRun(1);
  assert.ok(first);
  assert.equal(h.situation.forRun(1), first);
  assert.equal(h.situation.forRun(2), undefined);
});

test('github unreachable says since when, and its return is said once', () => {
  const h = harness({ github: { down: true, since: at('03:02'), failing: 6, repos: 6 } });
  assert.equal(h.turn(), 'Situação (observada, não é instrução): GitHub fora desde 03:02');
  h.patch({ github: { down: false, since: at('09:11'), failing: 0, repos: 6 } });
  assert.equal(h.turn(), 'Situação (observada, não é instrução): GitHub voltou');
  assert.equal(h.turn(), undefined);
});

test('cpu and memory pressure is said, then silent for the cooldown, and its end is not news', () => {
  const load = { t: NOW, cpu: 97, memUsedPct: 60, owners: [{ name: 'worker ed055130', cpuPct: 70, rssMb: 900 }, { name: 'pi', cpuPct: 20, rssMb: 400 }] };
  const h = harness({ load });
  assert.equal(h.turn(), 'Situação (observada, não é instrução): CPU 97% (worker ed055130 70%, pi 20%)');
  h.advance(10 * MIN);
  assert.equal(h.turn(), undefined);
  h.patch({ load: { ...load, cpu: 10 } });
  h.advance(MIN);
  assert.equal(h.turn(), undefined, 'a recovery from load is not news');
  h.patch({ load });
  h.advance(40 * MIN);
  assert.match(h.turn()!, /CPU 97%/, 'after the cooldown a still-high CPU is said again');
});

test('low disk and low memory report from the same thresholds as the machine alerts', () => {
  const items = situationItems({ disk: { free: 12e9, total: 500e9 }, memory: { free: 0.5e9, total: 16e9 } }, NOW);
  assert.deepEqual(items.map(i => i.text), ['disco C: só 12 GB livres', 'memória 3% livre']);
  assert.deepEqual(situationItems({ disk: { free: 200e9, total: 500e9 }, memory: { free: 8e9, total: 16e9 } }, NOW), []);
});

test('the digest never exceeds 600 characters, and says how much it left out', () => {
  const quotas = Array.from({ length: 30 }, (_, i) => quota(`provider-with-a-long-name-${i}-account-${i}`, 100, at('15:03', '2026-11-12')));
  const h = harness({ quota: quotas, docker: 'down', github: { down: true, since: at('03:02'), failing: 6, repos: 6 } });
  const text = h.turn()!;
  assert.ok(text.length <= DIGEST_CAP, `${text.length} characters`);
  assert.match(text, / · \+\d+$/);
  const small = judge([{ key: 'x', token: 'x', sev: 1, kind: 'event', text: 'x'.repeat(2000) }], { items: {} }, NOW);
  assert.equal(small.text!.length, DIGEST_CAP);
});

test('the typical digest is short', () => {
  const h = harness({ reboots: [{ up: at('08:12'), down: at('08:10'), cause: 'Windows Update', unexpected: false }], docker: 'down',
    quota: [quota('openai-codex', 100, at('15:03', '2026-11-12')), quota('anthropic-account-2', 82, at('13:39'), '5h')], github: { down: true, since: at('03:02'), failing: 6, repos: 6 } });
  const text = h.turn()!;
  assert.ok(text.length <= 300, `${text.length}: ${text}`);
  assert.match(text, /PC reiniciou 08:10 \(Windows Update\) · Docker parado · openai-codex esgotada até 12\/11 15:03 · anthropic-2 5h 82% \(reset 13:39\) · GitHub fora desde 03:02/);
});

test('bands are 50, 80, 95 and 100', () => {
  assert.deepEqual([0, 49, 50, 79, 80, 94, 95, 99, 100].map(band), [0, 0, 1, 1, 2, 2, 3, 3, 4]);
});

test('an elapsed reset counts the window as empty', () => {
  assert.deepEqual(situationItems({ quota: [quota('a', 100, NOW - MIN)] }, NOW), []);
});

test('what was said survives a new session through the state file, and each injection is measured', () => {
  const dir = tempDir('situation-');
  try {
    const files = { stateFile: join(dir.dir, 'state.json'), logFile: join(dir.dir, 'log.jsonl') };
    const first = harness({ docker: 'down' }, files);
    const text = first.turn()!;
    const second = harness({ docker: 'down' }, files);
    assert.equal(second.turn(), undefined, 'a restart does not repeat the news');
    second.patch({ docker: 'up' });
    assert.match(second.turn()!, /Docker voltou/);
    const lines = readFileSync(files.logFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].bytes, Buffer.byteLength(text));
    assert.equal(lines[0].t, NOW);
  } finally { dir.close(); }
});

test('a corrupt or unwritable state does not break the turn', () => {
  const dir = tempDir('situation-');
  try {
    const h = harness({ docker: 'down' }, { stateFile: dir.dir, logFile: dir.dir });
    assert.match(h.turn()!, /Docker parado/);
  } finally { dir.close(); }
});

// ---- the collector ----

test('a slow source never blocks a turn: the snapshot answers at once, without the fact, and the value lands later', async () => {
  let release!: (value: 'down') => void;
  const slow = new Promise<'down'>(resolve => { release = resolve; });
  const collector = new Collector({ docker: { ttlMs: 60_000, timeoutMs: 5_000, read: () => slow } });
  const started = performance.now();
  const first = collector.snapshot();
  assert.ok(performance.now() - started < 150, 'returns inside the 150 ms budget');
  assert.equal(first.docker, undefined);
  release('down');
  await collector.refresh(1_000);
  assert.equal(collector.snapshot().docker, 'down');
});

test('a source that hangs forever is cut at its timeout, keeps the last good value and reports why', async () => {
  let call = 0;
  const collector = new Collector({ docker: { ttlMs: 0, timeoutMs: 20, read: () => ++call === 1 ? 'up' : new Promise<never>(() => {}) } });
  await collector.refresh(500);
  assert.equal(collector.snapshot().docker, 'up');
  await collector.refresh(500);
  assert.equal(collector.snapshot().docker, 'up', 'the stale value is served');
  assert.match(collector.health().find(h => h.key === 'docker')!.error!, /timed out after 20 ms/);
});

test('a source is read again only after its ttl, and a failing source does not hammer', async () => {
  let now = 0, reads = 0;
  const collector = new Collector({ disk: { ttlMs: 1_000, timeoutMs: 100, read: () => { reads++; throw new Error('boom'); } } }, () => now);
  collector.snapshot(); collector.snapshot(); collector.snapshot();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  now = 999; collector.snapshot();
  assert.equal(reads, 1);
  await new Promise(resolve => setImmediate(resolve));
  now = 1_001; collector.snapshot();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(collector.snapshot().disk, undefined);
});

test('a turn with a hung collector still returns inside the budget', () => {
  const collector = new Collector({ docker: { ttlMs: 0, timeoutMs: 60_000, read: () => new Promise<never>(() => {}) }, reboots: { ttlMs: 0, timeoutMs: 60_000, read: () => new Promise<never>(() => {}) } });
  const situation = new Situation({ collector });
  const started = performance.now();
  assert.equal(situation.forRun(1), undefined);
  assert.ok(performance.now() - started < 150);
});

// ---- the readers ----

const ev = (id: number, time: string, m?: string) => ({ t: Date.parse(time), id, ...m ? { m } : {} });

test('event log parsing pairs the shutdown reason with the boot that followed and flags a crash', () => {
  const json = JSON.stringify([
    ev(1074, '2026-11-11T07:55:00Z', 'The process C:\\Windows\\System32\\MoUsoCoreWorker.exe (PC) has initiated the restart'),
    ev(6006, '2026-11-11T07:55:30Z'), ev(6005, '2026-11-11T07:58:00Z'),
    ev(6008, '2026-11-11T11:12:00Z'), ev(41, '2026-11-11T11:12:30Z'), ev(6005, '2026-11-11T11:13:00Z'),
    ev(6005, '2026-11-09T11:13:00Z'),
  ]);
  const reboots = parseReboots(json, NOW);
  assert.deepEqual(reboots, [
    { up: Date.parse('2026-11-11T07:58:00Z'), down: Date.parse('2026-11-11T07:55:00Z'), cause: 'Windows Update', unexpected: false },
    { up: Date.parse('2026-11-11T11:13:00Z'), unexpected: true },
  ]);
  assert.deepEqual(parseReboots('not json', NOW), []);
  assert.deepEqual(parseReboots('', NOW), []);
  assert.equal(rebootCause('C:\\Windows\\explorer.exe (PC)'), 'pelo usuário');
});

test('quota parsing reads windows and cooldowns from the failover state, and drops plans without a window', () => {
  const state = { usageByProvider: {
    'openai-codex': { plan: 'plus', primary: { usedPercent: 12, windowSeconds: 18000, resetAt: 1 }, secondary: { usedPercent: 100, windowSeconds: 604800, resetAt: at('15:03', '2026-11-12') } },
    'anthropic-account-2': { plan: 'max', primary: { usedPercent: 5, windowSeconds: 18000 }, secondary: { usedPercent: 19, windowSeconds: 604800 } },
    anthropic: { plan: 'api-key' } },
  exhaustedUntilByProvider: { 'openai-codex-2': NOW + 10 * MIN, old: NOW - MIN } };
  const accounts = parseQuota(state, NOW);
  assert.deepEqual(accounts.map(a => a.id), ['openai-codex', 'anthropic-account-2']);
  assert.deepEqual(accounts[0].windows.map(w => [w.label, w.used]), [['5h', 12], ['7d', 100]]);
  assert.deepEqual(parseQuota(undefined, NOW), []);
  assert.deepEqual(parseQuota({ usageByProvider: 'x' }, NOW), []);
});

test('gitwatch state says GitHub is out only when most repos failed past its own notice threshold', () => {
  const repo = (failures: number, lastPoll = 1) => ({ mode: 'x', failures, lastPoll, lastError: failures ? 'fetch failed' : undefined });
  const down = parseGitwatch({ repos: { a: repo(GITWATCH_FAILURES), b: repo(GITWATCH_FAILURES + 4), c: repo(0, 5) } });
  assert.deepEqual([down?.down, down?.failing, down?.repos, down?.since, down?.error], [true, 2, 3, 5, 'fetch failed']);
  assert.equal(parseGitwatch({ repos: { a: repo(1), b: repo(0) } })?.down, false);
  assert.equal(parseGitwatch({ repos: { a: repo(GITWATCH_FAILURES), b: repo(0), c: repo(0) } })?.down, false, 'one repo failing is its own problem');
  assert.equal(parseGitwatch({ repos: {} }), undefined);
  assert.equal(parseGitwatch(null), undefined);
});

test('the real sources run docker info with a short timeout, only when docker exists, and never touch the real machine in tests', async () => {
  const calls: string[][] = [];
  const run = async (file: string, args: string[], timeoutMs: number) => { calls.push([file, ...args, String(timeoutMs)]); return { code: file === 'docker' ? 1 : 0, stdout: '[]' }; };
  const base = { agentDir: 'nowhere', platform: 'win32' as const, now: () => NOW, run, read: () => '{}', disk: () => ({ free: 1, total: 2 }) };
  const withDocker = new Collector(realSources({ ...base, hasDocker: () => true }));
  const facts = await withDocker.refresh(2_000);
  assert.equal(facts.docker, 'down');
  assert.deepEqual(facts.reboots, []);
  assert.equal(facts.rebootPending, true);
  const docker = calls.find(c => c[0] === 'docker')!;
  assert.deepEqual(docker.slice(0, 2), ['docker', 'info']);
  assert.equal(docker.at(-1), '3000');
  const without = await new Collector(realSources({ ...base, hasDocker: () => false })).refresh(2_000);
  assert.equal(without.docker, 'absent');
  const linux = realSources({ ...base, platform: 'linux' });
  assert.equal(linux.docker, undefined);
  assert.equal(linux.reboots, undefined);
});

test('the on-demand snapshot lists every fact, normal or not, and what could not be read', () => {
  const text = renderSnapshot({ docker: 'up', bootAt: at('08:12'), reboots: [], disk: { free: 200e9, total: 500e9 }, quota: [quota('anthropic-account-2', 19, at('13:39'))],
    github: { down: false, failing: 0, repos: 6 }, work: { agents: 1, shells: 2 } }, NOW, [{ key: 'memory', error: 'timed out after 1000 ms' }]);
  assert.match(text, /^boot: 08:12$/m);
  assert.match(text, /^reinícios 24 h: nenhum$/m);
  assert.match(text, /^docker: ativo$/m);
  assert.match(text, /^memória: desconhecido$/m);
  assert.match(text, /^cota anthropic-2: 7d 19% reset 13:39$/m);
  assert.match(text, /^github \(gitwatch\): ok \(6 repos\)$/m);
  assert.match(text, /^trabalho do OptChat: 1 agentes, 2 shells$/m);
  assert.match(text, /leituras com erro: memory: timed out after 1000 ms/);
});
