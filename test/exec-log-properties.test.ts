import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendExecLog, classify, isNoMatch, EXEC_LOG, type ExecEntry } from '../src/exec-log.ts';

// Seeded generator: a failing case reproduces from its seed.
const rng = (seed: number) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const CASES = 200;

const readLines = (file: string): ExecEntry[] => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

test('rotation keeps a contiguous, ordered tail of every entry, newest last, and bounds each file', () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed), dir = mkdtempSync(join(tmpdir(), 'execlog-prop-'));
    try {
      const maxBytes = 300 + Math.floor(next() * 1500), total = 1 + Math.floor(next() * 60);
      for (let i = 0; i < total; i++) {
        const detail = 'x'.repeat(Math.floor(next() * 400));
        appendExecLog(dir, { at: `2026-11-07T00:00:${String(i % 60).padStart(2, '0')}Z`, source: 'tool', name: `n${i}`, class: 'ok', detail }, maxBytes);
        const live = readLines(join(dir, EXEC_LOG)), old = readLines(join(dir, `${EXEC_LOG}.1`));
        const names = [...old, ...live].map(e => e.name);
        const first = Number(names[0].slice(1));
        assert.deepEqual(names, Array.from({ length: i - first + 1 }, (_, k) => `n${first + k}`), `seed ${seed} i ${i}: gap, duplicate or disorder`);
        assert.equal(live.at(-1)?.name, `n${i}`, `seed ${seed} i ${i}: newest entry not last in the live file`);
        const bytes = (file: string) => existsSync(file) ? readFileSync(file).length : 0;
        for (const file of [join(dir, EXEC_LOG), join(dir, `${EXEC_LOG}.1`)]) assert.ok(bytes(file) <= maxBytes || readLines(file).length === 1, `seed ${seed} i ${i}: file over budget`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('classify: a call that did not fail is ok; a failed one is never ok, whatever the text says', () => {
  const words = ['timeout', 'refused by', 'ENOENT', 'HTTP 429', 'ECONNRESET', 'aborted', 'Command exited with code 3', 'Command exited with code 0', 'Not run: x', 'plain'];
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed);
    const text = Array.from({ length: 1 + Math.floor(next() * 4) }, () => words[Math.floor(next() * words.length)]).join(next() < 0.5 ? ' ' : '\n');
    const code = [undefined, 0, 1, 2, 124, 137, 143][Math.floor(next() * 7)];
    assert.equal(classify(false, text, code), 'ok', `seed ${seed}`);
    const failed = classify(true, text, code);
    if (code === 0) continue; // exit 0 reported as an error falls through to the text
    assert.notEqual(failed, 'ok', `seed ${seed}: failed call classified ok for ${JSON.stringify({ text, code })}`);
    if (code !== undefined) assert.equal(failed, [124, 137, 143].includes(code) ? 'timeout' : 'exit_nonzero', `seed ${seed}: the exit code decides`);
  }
});

test('isNoMatch: a final grep/rg is a no-match when empty; with earlier output only if its exit code is surely grep\'s', () => {
  const heads = ['cd x', 'git status', 'echo hi', 'cat f', 'ls'], seps = [' && ', ' | ', '; ', '\n'];
  for (let seed = 1; seed <= CASES; seed++) {
    const next = rng(seed), head = heads[Math.floor(next() * heads.length)], sep = seps[Math.floor(next() * seps.length)];
    const grep = next() < 0.5 ? 'grep -n foo f' : 'rg foo';
    assert.equal(isNoMatch(`${head}${sep}${grep}`, '\n\nCommand exited with code 1'), true, `seed ${seed}`);
    // After `;`, a newline or a pipe the exit code is grep's, so exit 1 is a miss whatever printed before; after `&&` it may be the head's.
    assert.equal(isNoMatch(`${head}${sep}${grep}`, 'f:1: foo\nCommand exited with code 1'), sep !== ' && ', `seed ${seed}: output present after ${JSON.stringify(sep)}`);
    assert.equal(isNoMatch(`${grep}${sep}echo done`, '\nCommand exited with code 1'), false, `seed ${seed}: grep is not last`);
  }
});
