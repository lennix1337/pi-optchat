import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 31, 12, minute, 5)).toISOString();
const usage = (minute: number, read: number, write: number) => JSON.stringify({
  date: at(minute), role: 'main', model: 'm', session: 's',
  usage: { cacheRead: read, cacheWrite: write, cost: { cacheWrite: write / 1e6, total: (write + read) / 1e6 } },
});

test('--diag also reads the rotated diagnostics file, where the older causes live', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-misses-script-'));
  try {
    writeFileSync(join(dir, 'usage.jsonl'), [usage(0, 90000, 90000), usage(1, 30000, 70000)].join('\n') + '\n');
    const diag = join(dir, 'cache-diagnostics.jsonl');
    writeFileSync(`${diag}.1`, JSON.stringify({ date: at(1), headChanged: true, headParts: ['model'] }) + '\n');
    writeFileSync(diag, JSON.stringify({ date: at(30), headChanged: true, headParts: ['tools'] }) + '\n');
    const out = execFileSync(process.execPath, ['scripts/cache-misses.mjs', '--usage', join(dir, 'usage.jsonl'), '--diag', diag], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30000,
    });
    const causes = JSON.parse(out).headChangeByCause;
    assert.deepEqual(Object.fromEntries(Object.entries(causes).map(([k, v]) => [k, (v as { turns: number }).turns])), { model: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--dir supplies usage.jsonl, and a bare --diag reads cache-diagnostics.jsonl from it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-misses-dir-'));
  try {
    writeFileSync(join(dir, 'usage.jsonl'), [usage(0, 90000, 90000), usage(1, 30000, 70000)].join('\n') + '\n');
    writeFileSync(join(dir, 'cache-diagnostics.jsonl'), JSON.stringify({ date: at(1), headChanged: true, headParts: ['tools'] }) + '\n');
    const out = execFileSync(process.execPath, ['scripts/cache-misses.mjs', '--dir', dir, '--diag'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30000,
    });
    const causes = JSON.parse(out).headChangeByCause;
    assert.deepEqual(Object.keys(causes), ['tools']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const run = (args: string[]) => spawnSync(process.execPath, ['scripts/cache-misses.mjs', ...args], {
  cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30000,
});

test('--help and an unknown option print the usage line, not a parseArgs stack trace', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node .*cache-misses\.mjs/);
  const bad = run(['--nope']);
  assert.equal(bad.status, 2);
  assert.doesNotMatch(bad.stderr, /at checkOptionUsage|ERR_PARSE_ARGS/);
  assert.match(bad.stderr, /unknown option --nope.*Usage:/s);
});

test('headChangeByDay keeps only the last --days days (default 14), 0 keeps all', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-misses-days-'));
  try {
    const day = (d: number, minute: number, read: number, write: number) => JSON.stringify({
      date: new Date(Date.UTC(2026, 9, d, 12, minute, 5)).toISOString(), role: 'main', model: 'm', session: 's',
      usage: { cacheRead: read, cacheWrite: write, cost: { cacheWrite: write / 1e6, total: (write + read) / 1e6 } },
    });
    writeFileSync(join(dir, 'usage.jsonl'), [day(1, 0, 90000, 90000), day(1, 1, 30000, 70000), day(30, 0, 90000, 90000), day(30, 1, 30000, 70000)].join('\n') + '\n');
    const days = (args: string[]) => Object.keys(JSON.parse(run(['--usage', join(dir, 'usage.jsonl'), ...args]).stdout).headChangeByDay);
    assert.deepEqual(days([]), ['2026-10-30']);
    assert.deepEqual(days(['--days', '0']), ['2026-10-01', '2026-10-30']);
    assert.deepEqual(days(['--days', '40']), ['2026-10-01', '2026-10-30']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a --diag path that does not exist is an error, not an all-unmatched report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-misses-nodiag-'));
  try {
    writeFileSync(join(dir, 'usage.jsonl'), [usage(0, 90000, 90000), usage(1, 30000, 70000)].join('\n') + '\n');
    const result = run(['--usage', join(dir, 'usage.jsonl'), '--diag', 'headCause']);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no diagnostics file at headCause.*Usage:/s);
    assert.equal(result.stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
