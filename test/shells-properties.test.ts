import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShellJobs, innerExitFailures, plainText, readShell, type ShellJob } from '../src/shells.ts';

// Seeded generator: a failing case reproduces from its seed.
const rng = (seed: number) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const CASES = 200;
const pick = <T>(next: () => number, items: readonly T[]) => items[Math.floor(next() * items.length)];

const job = (output: string, state: ShellJob['state'] = 'running'): ShellJob =>
  ({ id: 'job', command: 'cmd', cwd: '/p', mode: 'background', owner: 'main', state, started: 0, output, notify: 'end' });

test('reading a growing shell again and again shows every byte it printed, once, in order', () => {
  // Short pieces from a small alphabet make the new output repeat the end of the old one, as logs and progress lines do.
  const pieces = ['ok\n', 'ok\n', '.', 'step 1\n', 'a', 'b', ''];
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed), reads = new Map<string, { output: string; at: number }>();
    let output = '', shown = '';
    for (let i = 0; i < 12; i++) {
      const added = Array.from({ length: 1 + Math.floor(next() * 4) }, () => pick(next, pieces)).join('');
      output += added;
      const text = readShell(job(output), reads, i * 1000).split('\n').slice(2).join('\n');
      if (i === 0) shown = text === '(No output yet)' ? '' : text;
      else if (!text.startsWith('No new output')) shown += text.replace(/^New output since the last read \d+ s ago:\n/, '');
      assert.equal(shown, output, `seed ${seed} read ${i}: shown output differs from what the shell printed (added ${JSON.stringify(added)})`);
    }
  }
});

test('the job inventory never evicts a running job, keeps at most 50 ended ones and lists running jobs first', () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed), jobs = new ShellJobs(), running = new Set<string>();
    let n = 0;
    for (let step = 0; step < 150; step++) {
      if (running.size === 0 || next() < 0.6) { const id = `job-${seed}-${n++}`; jobs.begin(id, 'cmd', '/p', pick(next, ['foreground', 'background'] as const)); running.add(id); }
      else { const id = pick(next, [...running]); jobs.end(id, 'out', next() < 0.3); running.delete(id); }
      const listed = jobs.list(), ids = new Set(listed.map(j => j.id));
      for (const id of running) assert.ok(ids.has(id), `seed ${seed} step ${step}: running ${id} evicted`);
      assert.ok(listed.filter(j => j.ended !== undefined).length <= 50, `seed ${seed} step ${step}: more than 50 ended jobs kept`);
      const firstEnded = listed.findIndex(j => j.ended !== undefined);
      assert.ok(firstEnded === -1 || listed.slice(firstEnded).every(j => j.ended !== undefined), `seed ${seed} step ${step}: a running job listed after an ended one`);
    }
  }
});

test('find by id prefix returns the one job it names, and nothing when the prefix is short or shared', () => {
  const hex = '0123456789abcdef';
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed), jobs = new ShellJobs(), ids: string[] = [];
    // Ids share their first characters often, as the short prefixes quoted in notices do.
    for (let i = 0; i < 6; i++) { const id = 'ab' + Array.from({ length: 8 }, () => pick(next, [...hex.slice(0, 3)])).join(''); if (!ids.includes(id)) { ids.push(id); jobs.begin(id, 'cmd', '/p', 'background'); } }
    for (const id of ids) {
      assert.equal(jobs.find(id)?.id, id, `seed ${seed}: full id ${id} not found`);
      for (let len = 1; len < id.length; len++) {
        const prefix = id.slice(0, len), owners = ids.filter(other => other.startsWith(prefix));
        const expected = len >= 6 && owners.length === 1 ? owners[0] : ids.includes(prefix) ? prefix : undefined;
        assert.equal(jobs.find(prefix)?.id, expected, `seed ${seed}: prefix ${prefix} of ${owners.length} ids`);
      }
    }
  }
});

test('plainText is idempotent and leaves text without escape sequences unchanged', () => {
  const parts = ['plain', ' ', '\n', '\u001b[31m', '\u001b[0m', '\u001b]8;;https://x\u0007', '\u001b]8;;\u001b\\', '\u001b(B', 'é', '[1m'];
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed), text = Array.from({ length: Math.floor(next() * 12) }, () => pick(next, parts)).join('');
    const once = plainText(text);
    assert.equal(plainText(once), once, `seed ${seed}: not idempotent on ${JSON.stringify(text)}`);
    assert.ok(!once.includes('\u001b'), `seed ${seed}: escape left in ${JSON.stringify(once)}`);
    const clean = text.replace(/\u001b/g, '');
    assert.equal(plainText(clean), clean, `seed ${seed}: changed text without escapes`);
  }
});

test('innerExitFailures reports exactly the nonzero echoed exit codes, each on its own line', () => {
  const lines = [['rc=0', null], ['rc=1', 'rc=1'], ['build_exit=2', 'build_exit=2'], ['  tsc.exit=7  ', 'tsc.exit=7'], ['rc=01', null], ['rc=1 more', null], ['echo rc=$?', null], ['done', null], ['RC=3', 'RC=3']] as const;
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed), chosen = Array.from({ length: Math.floor(next() * 8) }, () => pick(next, lines));
    const output = chosen.map(([line]) => line).join(pick(next, ['\n', '\r\n']));
    assert.deepEqual(innerExitFailures(output), chosen.flatMap(([, code]) => code === null ? [] : [code]), `seed ${seed}: ${JSON.stringify(output)}`);
  }
});
