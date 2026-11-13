import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandBelongsTo, commandHead } from '../src/machine-attribution.ts';
import { MachineSense } from '../src/machine-sense.ts';
import { MachineLedger, costCentres, machineInsights, type LedgerRow } from '../src/machine-ledger.ts';
import type { ProcRow, Sample } from '../src/machine-sample.ts';
import { tempDir } from './support.ts';

const HOST = 100, HELPER = 101, THREADS = 16, T0 = Date.parse('2026-11-10T21:00:00Z');
const NORMAL = 0x20, IDLE = 0x40;

/** A fake machine: a process table whose clock the test moves. `burn` gives a process CPU for the next tick. */
class Sim {
  t = T0;
  procs = new Map<number, ProcRow>();
  cpu: number | null = null;
  idleS: number | null = 5;
  memUsedMb = 8_000;
  constructor() {
    this.spawn(HOST, 1, 'node.exe', -600_000);
    this.procs.get(HOST)!.workingSetKb = 800_000;
    this.spawn(HELPER, HOST, 'sampler.exe', -500_000, IDLE);
  }
  spawn(pid: number, ppid: number, name: string, ago = 0, prio = NORMAL, cmd?: string) {
    this.procs.set(pid, { pid, ppid, start: this.t + ago, name, cpuMs: 0, workingSetKb: 40_000, prio, ...cmd ? { cmd } : {} });
  }
  exit(pid: number) { this.procs.delete(pid); }
  burn(pid: number, cpuSeconds: number) { this.procs.get(pid)!.cpuMs += cpuSeconds * 1000; }
  /** One sample, `seconds` later. The machine's CPU is what the burns add up to, unless `cpu` is set. */
  sample(seconds = 5, burned = 0): Sample {
    this.t += seconds * 1000;
    return { t: this.t, cpu: this.cpu ?? Math.min(100, burned / (seconds * THREADS) * 100), memUsedMb: this.memUsedMb, memTotalMb: 32_000, idleS: this.idleS, helperPid: HELPER, procs: [...this.procs.values()].map(p => ({ ...p })) };
  }
}
const newSense = (dir: string, extra: Partial<ConstructorParameters<typeof MachineSense>[0]> = {}) => {
  const notes: string[] = [], priorities: [number, string][] = [];
  const sense = new MachineSense({ hostPid: HOST, dir, threads: THREADS, notify: text => notes.push(text), lowerOwn: () => true,
    setPriority: (pid, level) => { priorities.push([pid, level]); }, ...extra });
  return { sense, notes, priorities };
};
const owner = (sense: MachineSense, sim: Sim, pid: number) => sense.attributor.attribute(sim.sample(0)).get(pid);

test('a shell tree belongs to the call that started it, and descendants inherit it through the parent links', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense } = newSense(dir), sim = new Sim();
    sense.began({ id: 'tc-1', command: 'cd /repo && bash stress.sh 20', mode: 'foreground', agent: 'agent ed055130-aaaa' }, sim.t);
    sim.spawn(200, HOST, 'bash.exe', 400);
    sim.spawn(300, 200, 'bash.exe', 900);
    sim.spawn(400, 300, 'node.exe', 1200);
    const got = sense.attributor.attribute(sim.sample(2));
    for (const pid of [200, 300, 400]) assert.deepEqual([got.get(pid)?.kind, got.get(pid)?.group, got.get(pid)?.detail], ['worker', 'worker ed055130', 'bash stress.sh 20']);
    assert.equal(got.get(HOST)?.kind, 'host');
    assert.equal(got.get(HELPER)?.kind, 'machine');
  } finally { close(); }
});

test('a descendant whose parent already exited keeps the owner it was seen with', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense } = newSense(dir), sim = new Sim();
    sense.began({ id: 'sh1', command: 'npm test', mode: 'background' }, sim.t);
    sim.spawn(200, HOST, 'bash.exe', 100);
    sim.spawn(300, 200, 'node.exe', 500);
    sense.attributor.attribute(sim.sample(5));
    sim.exit(200); // Git Bash's launcher is gone; the test runner lives on
    sim.spawn(500, 300, 'node.exe', 0);
    const got = sense.attributor.attribute(sim.sample(5));
    assert.equal(got.get(300)?.group, 'shell sh1');
    assert.equal(got.get(500)?.group, 'shell sh1', 'a new child of a survivor joins the tree');
  } finally { close(); }
});

test('a restart or /reload keeps the owners of the processes it left running; a reused pid is still not taken for them', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const sim = new Sim(), first = newSense(dir).sense;
    first.began({ id: 'bench1', command: 'node bench.mjs --browser', mode: 'background' }, sim.t);
    sim.spawn(200, HOST, 'bash.exe', 100);
    sim.spawn(300, 200, 'msedge.exe', 500);
    sim.spawn(400, 200, 'msedge.exe', 600);
    first.ingest(sim.sample(5));
    first.ingest(sim.sample(5));
    first.flush();
    // The old Pi exits with its shell; the headless browsers it launched live on under a new Pi.
    sim.exit(HOST); sim.exit(200); sim.exit(400);
    sim.spawn(150, 1, 'node.exe', 0);
    sim.spawn(400, 1, 'msedge.exe', 0); // Windows handed pid 400 to an unrelated browser
    sim.t += 30_000;
    const second = newSense(dir, { hostPid: 150 }).sense;
    const got = second.attributor.attribute(sim.sample(5));
    assert.deepEqual([got.get(300)?.kind, got.get(300)?.group], ['shell', 'shell bench1']);
    assert.equal(got.get(400)?.kind, 'external');
    assert.equal(got.get(150)?.kind, 'host');
  } finally { close(); }
});

test('a reused pid is never taken for the process that had it before', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense } = newSense(dir), sim = new Sim();
    sense.began({ id: 'tc-2', command: 'node burn.js', mode: 'foreground' }, sim.t);
    sim.spawn(200, HOST, 'bash.exe', 200);
    sim.spawn(300, 200, 'node.exe', 400);
    assert.equal(sense.attributor.attribute(sim.sample(5)).get(300)?.group, 'bash');
    sim.exit(300);
    sense.attributor.attribute(sim.sample(5));
    // Windows hands pid 300 to an unrelated program, whose parent is not ours.
    sim.spawn(4242, 1, 'explorer.exe', -3_600_000);
    sim.spawn(300, 4242, 'chrome.exe', 0);
    const got = sense.attributor.attribute(sim.sample(5));
    assert.deepEqual([got.get(300)?.kind, got.get(300)?.group], ['external', 'external chrome.exe']);
    // Even when its parent is a process of ours that started earlier: the memo is keyed by start time, and a stranger under a stranger stays one.
    sim.exit(300); sim.spawn(300, 4242, 'chrome.exe', 0);
    assert.equal(sense.attributor.attribute(sim.sample(5)).get(300)?.kind, 'external');
  } finally { close(); }
});

test('programs outside the host tree are external, grouped by program name', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense } = newSense(dir), sim = new Sim();
    sim.spawn(700, 1, 'chrome.exe'); sim.spawn(701, 700, 'chrome.exe'); sim.spawn(800, 1, 'Code.exe');
    const got = sense.attributor.attribute(sim.sample(5));
    assert.deepEqual([700, 701, 800].map(pid => got.get(pid)?.group), ['external chrome.exe', 'external chrome.exe', 'external Code.exe']);
    assert.ok([700, 701, 800].every(pid => got.get(pid)?.kind === 'external'));
  } finally { close(); }
});

test('an MCP server the host launched is named after its mcp.json entry and the worker run it started with', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense } = newSense(dir, { mcp: () => [{ name: 'sentry', tokens: ['@sentry/mcp-server'] }], runs: () => [{ id: 'cc1ea692-1111', started: T0 - 1000 }] });
    const sim = new Sim();
    sim.spawn(600, HOST, 'cmd.exe', 0, NORMAL, 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "npx ^"-y^" ^"@sentry/mcp-server@0.49.0^""');
    sim.spawn(601, 600, 'node.exe', 100);
    sim.spawn(602, HOST, 'cmd.exe', 100 + 120_000, NORMAL, 'cmd.exe /c "npx -y @sentry/mcp-server@0.49.0"');
    const got = sense.attributor.attribute(sim.sample(5));
    assert.deepEqual([got.get(600)?.group, got.get(600)?.detail, got.get(601)?.group], ['mcp sentry', 'worker cc1ea692', 'mcp sentry']);
    assert.equal(got.get(602)?.detail, 'main session', 'a launch no worker run explains was the main session\'s');
  } finally { close(); }
});

test('the head of a command keeps no secret and no leading cd', () => {
  assert.equal(commandHead('cd C:/repo && npm test -- --watch'), 'npm test -- --watch');
  assert.equal(commandHead('# note\ncurl -H "Authorization: Bearer abc123" https://x'), 'curl -H "Authorization: …" https://x');
  assert.equal(commandHead('API_TOKEN=hunter2 node app.js'), 'API_TOKEN=… node app.js');
  assert.equal(commandHead('git clone https://me:pw@github.com/a/b'), 'git clone https://me:…@github.com/a/b');
  assert.equal([...commandHead('x'.repeat(200))].length, 50);
});

// ---- thresholds, dedupe, recovery ----

/** Runs `n` samples 5 s apart with `workers` busy processes under one worker's shell, each taking `share` of a thread. */
function saturate(sense: MachineSense, sim: Sim, pids: number[], n: number, share = 1, cpu?: number) {
  for (let i = 0; i < n; i++) {
    for (const pid of pids) sim.burn(pid, 5 * share);
    sim.cpu = cpu ?? null;
    sense.ingest(sim.sample(5, 5 * share * pids.length));
  }
}
function stressSetup(sense: MachineSense, sim: Sim, burners = 20) {
  sense.began({ id: 'tc-9', command: 'bash stress.sh', mode: 'foreground', agent: 'agent ed055130' }, sim.t);
  sim.spawn(200, HOST, 'bash.exe', 100);
  const pids = Array.from({ length: burners }, (_, i) => 1000 + i);
  for (const pid of pids) sim.spawn(pid, 200, 'node.exe', 300);
  sense.ingest(sim.sample(5)); // the first sample has no interval
  return pids;
}

test('CPU at 90% for a minute alerts once, names the heaviest owner with procs, share and duration, and a long saturation does not repeat', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense, notes } = newSense(dir), sim = new Sim();
    sim.idleS = 600;
    const pids = stressSetup(sense, sim);
    saturate(sense, sim, pids, 11, 0.8, 97); // 55 s: not yet a minute
    assert.deepEqual(notes, []);
    saturate(sense, sim, pids, 2, 0.8, 97);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /^\[machine\] CPU 97% for 60 s on 16 threads\. Top: worker ed055130 bash stress\.sh: 21 procs, 100% CPU, 60 s\.$/);
    saturate(sense, sim, pids, 60, 0.8, 97); // five more minutes
    assert.equal(notes.length, 1, 'one alert per culprit per 15 minutes');
  } finally { close(); }
});

test('a brief spike under a minute never alerts', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense, notes } = newSense(dir), sim = new Sim();
    const pids = stressSetup(sense, sim, 4);
    saturate(sense, sim, pids, 8, 1, 99);
    saturate(sense, sim, pids, 6, 0.1, 20);
    saturate(sense, sim, pids, 8, 1, 99);
    assert.deepEqual(notes, []);
  } finally { close(); }
});

test('when the load ends a recovery line follows, once, and only for an alert that was sent', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense, notes } = newSense(dir), sim = new Sim();
    const pids = stressSetup(sense, sim);
    saturate(sense, sim, pids, 13, 0.8, 97);
    assert.equal(notes.length, 1);
    for (const pid of pids) sim.exit(pid);
    saturate(sense, sim, [], 3, 1, 10);
    assert.equal(notes.length, 1, 'a few quiet samples are not yet a recovery');
    saturate(sense, sim, [], 4, 1, 10);
    assert.equal(notes.length, 2);
    assert.match(notes[1], /^\[machine\] CPU is back to normal \(10%, peak 97%, 2 min high\)\./);
    saturate(sense, sim, [], 20, 1, 10);
    assert.equal(notes.length, 2);
  } finally { close(); }
});

test('the same culprit after a recovery waits out its 15 minutes; a different one speaks at once', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense, notes } = newSense(dir), sim = new Sim();
    const pids = stressSetup(sense, sim);
    saturate(sense, sim, pids, 13, 0.8, 97);
    saturate(sense, sim, pids, 1, 0, 10); saturate(sense, sim, pids, 7, 0, 10); // recovers
    assert.equal(notes.filter(n => n.includes('back to normal')).length, 1);
    saturate(sense, sim, pids, 14, 0.8, 97); // the same worker again, 2 minutes later
    assert.equal(notes.filter(n => n.includes('for 60 s on')).length, 1, 'deduped');
    // an outside program becomes the culprit
    for (const pid of pids) sim.exit(pid);
    sim.spawn(4242, 1, 'explorer.exe', -3_600_000);
    sim.spawn(900, 4242, 'ffmpeg.exe', 0);
    saturate(sense, sim, [], 7, 1, 10);
    saturate(sense, sim, [900], 14, 1, 95);
    const last = notes.at(-1)!;
    assert.match(last, /Top: external ffmpeg\.exe: 1 procs, \d+% CPU \(not ours\)/);
  } finally { close(); }
});

test('memory at 85% for 30 s names the largest owners; one owner above half the machine for 2 minutes is named even when the machine is not saturated', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const memory = newSense(dir), sim = new Sim();
    sim.spawn(700, 1, 'chrome.exe'); sim.procs.get(700)!.workingSetKb = 6_000_000;
    sim.memUsedMb = 28_000; memory.sense.ingest(sim.sample(5));
    for (let i = 0; i < 7; i++) memory.sense.ingest(sim.sample(5));
    assert.equal(memory.notes.length, 1);
    assert.match(memory.notes[0], /^\[machine\] Memory 88% in use for 30 s\. Largest: external chrome\.exe 5859 MB \(1 procs\)/);

    const owner = newSense(dir), busy = new Sim();
    const pids = stressSetup(owner.sense, busy, 10);
    saturate(owner.sense, busy, pids, 23, 1, 60); // 10 of 16 threads = 62% of the machine
    assert.deepEqual(owner.notes, []);
    saturate(owner.sense, busy, pids, 2, 1, 60);
    assert.equal(owner.notes.length, 1);
    assert.match(owner.notes[0], /^\[machine\] worker ed055130 bash stress\.sh alone uses 63% of the machine \(11 procs\) for 2 min\./);
  } finally { close(); }
});

// ---- priority ----

test('the operator at the keyboard and the CPU saturated: our heavy trees go to Idle, and the alert says so', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense, notes, priorities } = newSense(dir), sim = new Sim();
    sim.idleS = 5;
    const pids = stressSetup(sense, sim, 6);
    saturate(sense, sim, pids, 13, 1, 97);
    assert.deepEqual(priorities.map(p => p[1]), Array(7).fill('idle'), 'six burners and the shell');
    assert.deepEqual(priorities.map(p => p[0]).sort((a, b) => a - b), [200, ...pids].sort((a, b) => a - b));
    assert.match(notes[0], /Operator active: lowered 7 of our processes \(worker ed055130\) to Idle priority; nothing was stopped\.$/);
    saturate(sense, sim, pids, 4, 1, 97);
    assert.equal(priorities.length, 7, 'each process is lowered once');
  } finally { close(); }
});

test('nothing is lowered when the operator is away, the setting is off, or the process is not ours', () => {
  const away = tempDir('optchat-machine-'), off = tempDir('optchat-machine-');
  try {
    const a = newSense(away.dir), simA = new Sim(); simA.idleS = 900;
    saturate(a.sense, simA, stressSetup(a.sense, simA, 6), 14, 1, 97);
    assert.deepEqual(a.priorities, []);
    const b = newSense(off.dir, { lowerOwn: () => false }), simB = new Sim();
    saturate(b.sense, simB, stressSetup(b.sense, simB, 6), 14, 1, 97);
    assert.deepEqual(b.priorities, []);
    // an outside program saturating the machine is never touched
    const c = newSense(away.dir), simC = new Sim();
    simC.spawn(900, 1, 'ffmpeg.exe');
    c.sense.ingest(simC.sample(5)); saturate(c.sense, simC, [900], 14, 16, 99);
    assert.deepEqual(c.priorities, []);
  } finally { away.close(); off.close(); }
});

test('lowerToIdle refuses a foreign pid, the host, the sampler and pids it has never seen; it never raises a lower class', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense, priorities } = newSense(dir), sim = new Sim();
    sense.began({ id: 'tc-3', command: 'npm test', mode: 'foreground' }, sim.t);
    sim.spawn(200, HOST, 'bash.exe', 100); sim.spawn(300, 200, 'node.exe', 200); sim.spawn(301, 200, 'node.exe', 200, 0x4000); sim.spawn(302, 200, 'node.exe', 200, IDLE);
    sim.spawn(4242, 1, 'explorer.exe', -3_600_000); sim.spawn(700, 4242, 'chrome.exe'); sim.spawn(701, 4242, 'node.exe');
    sense.ingest(sim.sample(5));
    assert.equal(sense.lowerToIdle(700), 'refused');
    assert.equal(sense.lowerToIdle(701), 'refused');
    assert.equal(sense.lowerToIdle(HOST), 'refused');
    assert.equal(sense.lowerToIdle(HELPER), 'refused');
    assert.equal(sense.lowerToIdle(9999), 'refused');
    assert.deepEqual(priorities, []);
    assert.equal(sense.lowerToIdle(302), 'already');
    assert.deepEqual(priorities, []);
    assert.equal(sense.lowerToIdle(300), 'lowered');
    assert.equal(sense.lowerToIdle(301), 'lowered');
    assert.deepEqual(priorities, [[300, 'idle'], [301, 'idle']]);
  } finally { close(); }
});

test('our own shells start below normal when the setting is on, and never the host itself', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const on = newSense(dir), off = newSense(dir, { lowerOwn: () => false });
    on.sense.spawned(555, 'npm test', T0); on.sense.spawned(HOST, 'x', T0); off.sense.spawned(556, 'npm test', T0);
    assert.deepEqual(on.priorities, [[555, 'below-normal']]);
    assert.deepEqual(off.priorities, []);
  } finally { close(); }
});

// ---- the ledger ----

test('each minute writes one row per owner with CPU seconds, peak memory, process count and wall time; idle outsiders stay out', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense } = newSense(dir), sim = new Sim();
    sim.idleS = 900;
    sim.spawn(700, 1, 'idle-tool.exe');
    const pids = stressSetup(sense, sim, 4);
    const start = sim.t;
    saturate(sense, sim, pids, 24, 1, 25); // two minutes at 4 burners
    sense.flush();
    const rows = new MachineLedger(dir).read(0);
    const minute = Math.floor((start + 5000) / 60_000) * 60_000;
    const mine = rows.filter(r => r.owner === 'worker ed055130');
    assert.ok(mine.length >= 2);
    const full = mine.find(r => r.wallS >= 55)!;
    assert.deepEqual([full.kind, full.detail, full.procs], ['worker', 'bash stress.sh', 5]);
    assert.ok(Math.abs(full.cpuS - 240) < 25, `4 burners for a minute ≈ 240 cpu-s, got ${full.cpuS}`);
    assert.ok(rows.some(r => r.owner === 'machine' && r.t >= minute && r.cpuS > 0));
    assert.ok(rows.some(r => r.owner === 'Pi host'));
    assert.ok(!rows.some(r => r.owner === 'external idle-tool.exe'), 'an idle outsider costs nothing worth a row');
    assert.ok(rows.every(r => r.host === HOST && typeof r.t === 'number'));
  } finally { close(); }
});

test('the ledger keeps 14 days: older day files are deleted, newer ones kept, and torn lines are skipped', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const ledger = new MachineLedger(dir);
    const row = (t: number): LedgerRow => ({ t, owner: 'mcp sentry', kind: 'mcp', cpuS: 1, rssMb: 100, procs: 2, wallS: 60, host: HOST });
    const day = 24 * 3_600_000;
    ledger.append([row(T0 - 20 * day), row(T0 - 15 * day), row(T0 - 13 * day), row(T0 - day), row(T0)]);
    assert.equal(readdirSync(dir).length, 5);
    const removed = ledger.prune(T0);
    assert.equal(removed.length, 2);
    assert.equal(readdirSync(dir).length, 3);
    const file = join(dir, readdirSync(dir).sort().at(-1)!);
    assert.ok(readFileSync(file, 'utf8').length > 0);
    assert.deepEqual(ledger.read(T0 - 2 * day).map(r => r.t), [T0 - day, T0]);
  } finally { close(); }
});

test('the sense prunes by itself when the first minute of a new day is written', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const ledger = new MachineLedger(dir);
    ledger.append([{ t: T0 - 30 * 24 * 3_600_000, owner: 'old', kind: 'own', cpuS: 1, rssMb: 1, procs: 1, wallS: 1, host: 1 }]);
    const { sense } = newSense(dir), sim = new Sim();
    sense.ingest(sim.sample(5)); sense.ingest(sim.sample(5)); sense.flush();
    assert.ok(!ledger.read(0).some(r => r.owner === 'old'));
  } finally { close(); }
});

test('a row never holds more than a command head: no arguments past the cap, no secrets', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense } = newSense(dir), sim = new Sim();
    sense.began({ id: 'tc-4', command: `GITHUB_TOKEN=ghp_secret123 node deploy.js ${'--flag value '.repeat(40)}`, mode: 'foreground' }, sim.t);
    sim.spawn(200, HOST, 'bash.exe', 100);
    sense.ingest(sim.sample(5)); sim.burn(200, 3); sense.ingest(sim.sample(5)); sense.flush();
    const text = readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8')).join('');
    assert.doesNotMatch(text, /ghp_secret123/);
    assert.ok(text.split('\n').every(line => line.length < 400));
  } finally { close(); }
});

// ---- insights and the tool's reads ----

test('cost centres rank by CPU and the insights state what each cost, marking outsiders', () => {
  const day = 24 * 3_600_000, rows: LedgerRow[] = [];
  const add = (owner: string, kind: string, minutes: number, cpuS: number, rssMb: number, detail?: string) => {
    for (let i = 0; i < minutes; i++) rows.push({ t: T0 - day / 2 + i * 60_000, owner, kind, ...detail ? { detail } : {}, cpuS, rssMb, procs: 2, wallS: 60, host: HOST });
  };
  add('worker ed055130', 'worker', 3, 900, 800, 'bash stress.sh');
  add('mcp sentry', 'mcp', 600, 0.2, 380);
  add('external chrome.exe', 'external', 30, 40, 2000);
  add('machine', 'machine', 30, 1500, 15000);
  const centres = costCentres(rows);
  assert.deepEqual(centres.slice(0, 2).map(c => c.owner), ['worker ed055130', 'external chrome.exe']);
  assert.ok(centres.every(c => c.owner !== 'machine'));
  const lines = machineInsights(rows, T0, day);
  assert.equal(lines[0], 'cpu: worker ed055130 (bash stress.sh): 45 cpu-min over 3 min alive, up to 2 procs');
  assert.ok(lines.includes('cpu: external chrome.exe: 20 cpu-min over 30 min alive, up to 2 procs [not ours]'));
  assert.ok(lines.some(l => l.startsWith('memory: mcp sentry: ~380 MB resident for 10 h')));
  assert.deepEqual(machineInsights([], T0, day), []);
});

test('history reads the minute still in progress as well as the written ones', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense } = newSense(dir), sim = new Sim();
    sense.began({ id: 'tc-5', command: 'make', mode: 'foreground' }, sim.t);
    sim.spawn(200, HOST, 'bash.exe', 100);
    sense.ingest(sim.sample(5)); sim.burn(200, 4); sense.ingest(sim.sample(5));
    assert.equal(readdirSync(dir).length, 0, 'nothing written before the minute ends');
    const row = sense.history(0).find(r => r.owner === 'bash')!;
    assert.deepEqual([row.cpuS, row.detail], [4, 'make']);
    assert.equal(sense.now()?.owners.find(o => o.group === 'bash')?.procs, 1);
  } finally { close(); }
});

// ---- orphans: a parent that died before the sampler saw it ----

const NPM_CALL = 'cd C:/projetos/pi-optchat/.worktrees/waiting-board && npm test > /tmp/waiting-board-test.log 2>&1';
/** The 11/11 incident: the worker's bash (33380) is a child of the host; Git Bash's intermediate (17308) exited within ms, so `npm test` (6300) has a parent that never appears in any sample. */
function incident(sense: MachineSense, sim: Sim) {
  sense.began({ id: 'tc-68131e9d', command: NPM_CALL, mode: 'foreground', agent: 'agent 68131e9d-aaaa' }, sim.t);
  sim.spawn(33380, HOST, 'bash.exe', 400, NORMAL, `C:\Program Files\Git\bin\bash.exe -c "${NPM_CALL}"`);
  sense.ingest(sim.sample(5));
  sim.spawn(6300, 17308, 'bash.exe', 100, NORMAL, '"/c/Program Files/nodejs/npm" test');
  sim.spawn(36664, 6300, 'bash.exe', 300);
  sim.spawn(27780, 36664, 'node.exe', 500, NORMAL, 'node C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js test');
  sim.spawn(8760, 27780, 'cmd.exe', 700);
  sim.spawn(35068, 8760, 'node.exe', 900, NORMAL, 'node --test test/*.test.ts');
  const children = Array.from({ length: 30 }, (_, i) => 40000 + i);
  for (const pid of children) sim.spawn(pid, 35068, 'node.exe', 1500);
  return { tree: [6300, 36664, 27780, 8760, 35068, ...children], children };
}

test('an orphan of the worker\'s npm test, whose parent exited before any sample, belongs to the worker that ran it', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense } = newSense(dir), sim = new Sim();
    const { tree } = incident(sense, sim);
    const got = sense.attributor.attribute(sim.sample(5));
    assert.equal(got.get(33380)?.group, 'worker 68131e9d');
    for (const pid of tree) assert.deepEqual([pid, got.get(pid)?.kind, got.get(pid)?.group], [pid, 'worker', 'worker 68131e9d']);
  } finally { close(); }
});

test('the alert for the incident tree names the worker and its call, never "not ours"', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense, notes } = newSense(dir), sim = new Sim();
    sim.idleS = 600;
    const { tree } = incident(sense, sim);
    sense.ingest(sim.sample(5));
    saturate(sense, sim, tree, 13, 0.8, 97);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Top: worker 68131e9d npm test > \/tmp\/waiting-board-test\.log 2>&1: 36 procs, \d+% CPU/);
    assert.doesNotMatch(notes[0], /not ours|external/);
  } finally { close(); }
});

test('an orphan no open call explains is unattributed, in the alert and the ledger, and never "not ours"', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense, notes } = newSense(dir), sim = new Sim();
    sim.idleS = 600;
    sense.began({ id: 'tc-1', command: 'npm test', mode: 'foreground', agent: 'agent 68131e9d-aaaa' }, sim.t);
    sim.spawn(200, HOST, 'bash.exe', 100);
    sense.ingest(sim.sample(5));
    sim.spawn(7000, 17308, 'node.exe', 100, NORMAL, 'node C:/tools/unrelated-job.js --watch');
    sim.spawn(7001, 7000, 'node.exe', 300);
    sim.spawn(7002, 17309, 'node.exe', 300); // no command line known at all
    const got = sense.attributor.attribute(sim.sample(5));
    for (const pid of [7000, 7001, 7002]) assert.deepEqual([pid, got.get(pid)?.kind, got.get(pid)?.group], [pid, 'unattributed', 'unattributed (parent gone) node.exe']);
    saturate(sense, sim, [7000, 7001, 7002], 13, 1, 97);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Top: unattributed \(parent gone\) node\.exe: 3 procs, \d+% CPU/);
    assert.doesNotMatch(notes[0], /not ours|external/);
    assert.ok(sense.history(0).some(r => r.owner === 'unattributed (parent gone) node.exe' && r.kind === 'unattributed'));
    assert.equal(sense.lowerToIdle(7000), 'refused', 'what OptChat cannot show it started is never lowered');
  } finally { close(); }
});

test('a long-running process whose parent is long gone, and a fresh one with a live parent, stay external', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense } = newSense(dir), sim = new Sim();
    sense.began({ id: 'tc-1', command: 'npm test', mode: 'foreground' }, sim.t);
    sim.spawn(500, 1, 'explorer.exe', -3_600_000); // parent long gone, started before the sampler looked
    sim.spawn(4242, 1, 'explorer.exe', -3_600_000);
    sense.ingest(sim.sample(5));
    sim.spawn(501, 4242, 'node.exe', 100, NORMAL, '"/c/Program Files/nodejs/npm" test'); // fresh, same command as the open call, but its parent chain is alive outside the host tree
    sim.spawn(502, 17308, 'node.exe', -3_600_000, NORMAL, 'npm test'); // old orphan
    const got = sense.attributor.attribute(sim.sample(5));
    assert.deepEqual([500, 501, 502].map(pid => got.get(pid)?.kind), ['external', 'external', 'external']);
  } finally { close(); }
});

test('a released call no longer claims new orphans', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    const { sense } = newSense(dir), sim = new Sim();
    const handle = sense.began({ id: 'tc-1', command: 'npm test', mode: 'foreground' }, sim.t);
    sense.ingest(sim.sample(5));
    sense.ended(handle);
    sim.spawn(7000, 17308, 'node.exe', 100, NORMAL, '"/c/Program Files/nodejs/npm" test');
    assert.equal(sense.attributor.attribute(sim.sample(5)).get(7000)?.kind, 'unattributed');
  } finally { close(); }
});

test('the ledger insights mark an unattributed centre as unknown, not as someone else\'s', () => {
  const rows: LedgerRow[] = [];
  for (let i = 0; i < 5; i++) rows.push({ t: T0 - 3_600_000 + i * 60_000, owner: 'unattributed (parent gone) node.exe', kind: 'unattributed', cpuS: 40, rssMb: 100, procs: 5, wallS: 60, host: HOST });
  const lines = machineInsights(rows, T0, 24 * 3_600_000);
  assert.equal(lines[0], 'cpu: unattributed (parent gone) node.exe: 3 cpu-min over 5 min alive, up to 5 procs [owner unknown]');
});

test('the command of an orphan belongs to a call when two of its words, not all generic, run in a row in the call', () => {
  assert.ok(commandBelongsTo('"/c/Program Files/nodejs/npm" test', NPM_CALL));
  assert.ok(commandBelongsTo('cat /dev/zero', 'cat /dev/zero | head -c 1 > /dev/null'));
  assert.ok(commandBelongsTo('grep -c reaperprobe123 file', 'sleep 1 & grep -c reaperprobe123 file; wait'));
  assert.ok(!commandBelongsTo('node.exe', NPM_CALL), 'one word is not enough');
  assert.ok(!commandBelongsTo('bash.exe -c', NPM_CALL), 'generic words say nothing');
  assert.ok(!commandBelongsTo('"/c/Program Files/nodejs/npm" install', NPM_CALL));
  assert.ok(!commandBelongsTo('node C:/tools/unrelated-job.js --watch', NPM_CALL));
});

test('sizes() counts what the sampler keeps, and a churn of short-lived processes leaves it bounded by the live table', () => {
  const { dir, close } = tempDir('machine-sizes-');
  try {
    const { sense } = newSense(dir), sim = new Sim();
    for (let round = 0; round < 400; round++) {
      sim.spawn(5000 + round, HOST, 'git.exe', 0, NORMAL, `git status ${round}`);
      if (round >= 3) sim.exit(5000 + round - 3);
      sense.ingest(sim.sample(5, 1));
    }
    const sizes = sense.sizes();
    assert.ok(sizes.machineProcs <= 8, JSON.stringify(sizes));
    assert.ok(sizes.machineOwners <= 8, JSON.stringify(sizes));
    assert.ok(sizes.machineFrames <= 400 && sizes.machineExternals <= 4 && sizes.machineUnattributed <= 4, JSON.stringify(sizes));
  } finally { close(); }
});
