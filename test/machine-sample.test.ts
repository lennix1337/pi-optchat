import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HELPER_SOURCE } from '../src/machine-helper-source.ts';
import { spawn } from 'node:child_process';
import { HelperSampler, parseSampleLine, type Sample } from '../src/machine-sample.ts';
import { tempDir } from './support.ts';

// Two lines the compiled helper printed on this PC (trimmed to a few processes; the second carries a command line like the helper adds for processes in Pi's tree).
const recorded = readFileSync(new URL('./fixtures/machine-helper.jsonl', import.meta.url), 'utf8').trim().split('\n');

test('a recorded helper line parses into machine numbers and process rows', () => {
  const sample = parseSampleLine(recorded[0])!;
  assert.equal(sample.cpu, 32.2);
  assert.equal(sample.t, 1794355672984);
  assert.deepEqual([sample.memUsedMb, sample.memTotalMb, sample.idleS, sample.helperPid], [15529, 31653, 44.6, 23108]);
  assert.equal(sample.procs.length, 8);
  assert.deepEqual(sample.procs[5], { pid: 9572, ppid: 21116, start: 1794355075886, name: 'node.exe', cpuMs: 87390, workingSetKb: 828264, prio: 32 });
  assert.equal(sample.procs[7].prio, 0x4000, 'a below-normal process shows its class');
});

test('a recorded command line survives with its quotes and backslashes', () => {
  const sample = parseSampleLine(recorded[1])!;
  const bash = sample.procs.find(p => p.pid === 4321)!;
  assert.equal(bash.cmd, 'C:\\Program Files\\Git\\bin\\bash.exe -c "node -e \\"x\\""');
  assert.equal(sample.procs.find(p => p.pid === 9572)!.cmd, undefined);
});

test('a null CPU or idle time is kept as null, not as zero', () => {
  const sample = parseSampleLine('{"t":1,"cpu":null,"mem":[1,2],"idle":null,"pid":3,"p":[]}')!;
  assert.equal(sample.cpu, null);
  assert.equal(sample.idleS, null);
});

test('torn lines, banners and malformed rows are skipped instead of throwing', () => {
  assert.equal(parseSampleLine(''), undefined);
  assert.equal(parseSampleLine('{"t":1,"cpu":5,"mem":[1,2],"pid":3,"p":[[1,2,3,"a.exe",4'), undefined);
  assert.equal(parseSampleLine('Unhandled Exception: System.Exception'), undefined);
  assert.equal(parseSampleLine('{"t":"now","cpu":5,"mem":[1,2],"pid":3,"p":[]}'), undefined);
  const sample = parseSampleLine('{"t":1,"cpu":5,"mem":[1,2],"idle":0,"pid":3,"p":[[1,2,3,"a.exe",4,5,6],[7,8],["x"],[9,9,9,9,9,9,9]]}')!;
  assert.deepEqual(sample.procs.map(p => p.pid), [1]);
});

test('the helper source emits what the parser reads and uses one snapshot loop, not a process per sample', () => {
  assert.match(HELPER_SOURCE, /CreateToolhelp32Snapshot/);
  assert.doesNotMatch(HELPER_SOURCE, /Process\.Start|powershell|Get-CimInstance/i);
});

test('off Windows the sampler says so and starts nothing', async t => {
  if (process.platform === 'win32') return t.skip('Windows has a helper');
  const statuses: string[] = [];
  const sampler = new HelperSampler({ dir: '/nonexistent', rootPid: process.pid, intervalMs: 5000, onSample: () => assert.fail('no sample off Windows'), onStatus: s => statuses.push(`${s.state}: ${s.detail}`) });
  await sampler.start();
  assert.match(statuses[0], /^unsupported: only Windows has a sampler/);
});

test('the real helper compiles, samples this process and sees a child of the root with its command line', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const { dir, close } = tempDir('optchat-machine-');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000) /* machine-probe */'], { stdio: 'ignore', windowsHide: true });
  const samples: Sample[] = [];
  let done: () => void; const enough = new Promise<void>(resolve => { done = resolve; });
  const sampler = new HelperSampler({ dir, rootPid: process.pid, intervalMs: 500, onSample: s => { samples.push(s); if (samples.length >= 3) done(); } });
  try {
    await sampler.start();
    await enough;
    const last = samples.at(-1)!;
    assert.equal(samples[0].cpu, null, 'the first sample has no interval to measure');
    assert.ok(last.cpu !== null && last.cpu >= 0 && last.cpu <= 100);
    assert.ok(last.memTotalMb > 1000 && last.memUsedMb > 0 && last.memUsedMb <= last.memTotalMb);
    assert.ok(last.procs.some(p => p.pid === process.pid && p.name.toLowerCase() === 'node.exe' && p.cpuMs > 0 && p.workingSetKb > 0));
    const mine = samples.flatMap(s => s.procs).find(p => p.pid === child.pid);
    assert.ok(mine?.cmd?.includes('machine-probe'), 'the first sample of a process in the root tree carries its command line');
    assert.notEqual(last.helperPid, process.pid);
    assert.equal(last.procs.find(p => p.pid === last.helperPid)?.prio, 0x40, 'the helper itself runs at idle priority');
  } finally { sampler.stop(); child.kill(); close(); }
});

test('the real helper gives the command line of a fresh process whose parent is already gone', { skip: process.platform !== 'win32', timeout: 60_000 }, async () => {
  const { dir, close } = tempDir('optchat-machine-');
  const samples: Sample[] = [];
  // A root nothing descends from: only the orphan rule can attach a command line.
  const sampler = new HelperSampler({ dir, rootPid: 99_999_999, intervalMs: 500, onSample: s => samples.push(s) });
  let orphan: number | undefined;
  try {
    await sampler.start();
    const launcher = spawn(process.execPath, ['-e', `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000) /* orphan-probe */'], { detached: true, stdio: 'ignore', windowsHide: true }); console.log(c.pid); c.unref();`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    orphan = await new Promise<number>(resolve => launcher.stdout!.once('data', d => resolve(Number(String(d).trim()))));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !samples.flatMap(s => s.procs).some(p => p.pid === orphan && p.cmd)) await new Promise(r => setTimeout(r, 250));
    const mine = samples.flatMap(s => s.procs).find(p => p.pid === orphan && p.cmd);
    assert.ok(mine?.cmd?.includes('orphan-probe'), 'an orphan carries its command line on its first sample');
    assert.ok(!samples.at(-1)!.procs.some(p => p.pid === launcher.pid), 'the launcher is gone, as in the incident');
  } finally { sampler.stop(); if (orphan) try { process.kill(orphan); } catch { /* already gone */ } close(); }
});
