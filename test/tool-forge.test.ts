import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { retroPrompt } from '../src/daily-retro.ts';
import { appendExecLog, readExecLog, registerExecLog, type ExecEntry } from '../src/exec-log.ts';
import { defaults, loadConfig, saveConfig } from '../src/profiles.ts';
import {
  analyzeToolForge,
  detectForgeCandidates,
  isMultiStepCommand,
  listForgedScripts,
  normalizeCommand,
  resolveToolDir,
  trackForgedReuse,
  type ForgedScript,
} from '../src/tool-forge.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-22T22:00:00Z');

const bashRow = (offsetMs: number, target: string, extra: Partial<ExecEntry> = {}): ExecEntry => ({
  at: new Date(NOW + offsetMs).toISOString(),
  source: 'tool',
  name: 'bash',
  target,
  class: 'ok',
  ...extra,
});

test('normalizeCommand strips paths, ids, numbers and quoted text while keeping structure', () => {
  assert.equal(
    normalizeCommand('gh pr view 123 --json state | jq -r ".state"'),
    normalizeCommand("gh pr view 987 --json state | jq -r '.mergeable'"),
  );
  assert.equal(
    normalizeCommand('gh pr view 123 --json state | jq -r ".state"'),
    'gh pr view <num> --json state | jq -r <str>',
  );
  assert.equal(
    normalizeCommand('cd /home/dev/repo-a && git diff origin/main -- src/foo.ts | head -n 20'),
    normalizeCommand('cd C:\\work\\repo-b && git diff origin/main -- src/bar.ts | head -n 50'),
  );
  assert.equal(
    normalizeCommand('docker logs a1b2c3d4e5f6 --tail=100 | grep -i "timeout"'),
    normalizeCommand('docker logs 9f8e7d6c5b4a --tail=250 | grep -i "refused"'),
  );
  assert.equal(
    normalizeCommand('curl -s https://api.example.com/jobs/550e8400-e29b-41d4-a716-446655440000 | jq ".id"'),
    'curl -s <path> | jq <str>',
  );
  assert.equal(
    normalizeCommand('gh issue view PROJ-42; gh pr list --limit=10'),
    'gh issue view <id>; gh pr list --limit=<num>',
  );
  assert.equal(
    normalizeCommand('python3 ./scripts/check.py --since=2026-11-20 | wc -l'),
    'python3 <path> --since=<num> | wc -l',
  );
  assert.equal(
    normalizeCommand('cat report.json | jq -r ".total"'),
    normalizeCommand('cat summary.json | jq -r ".count"'),
  );
  assert.equal(
    normalizeCommand('node ./run.mjs 2>&1 | tail -n 10'),
    'node <path> 2>&1 | tail -n <num>',
  );
});

test('isMultiStepCommand requires pipes or &&/; chains outside quotes', () => {
  assert.equal(isMultiStepCommand('git log -n 5 | grep fix'), true);
  assert.equal(isMultiStepCommand('npm run check && npm test'), true);
  assert.equal(isMultiStepCommand('git fetch; git status'), true);
  assert.equal(isMultiStepCommand('git status'), false);
  assert.equal(isMultiStepCommand('echo "a | b && c; d"'), false);
  assert.equal(isMultiStepCommand("rg 'foo|bar' src/index.ts"), false);
  assert.equal(isMultiStepCommand('git status;'), false);
  assert.equal(isMultiStepCommand('git status || echo fallback'), false);
  assert.equal(isMultiStepCommand("cat <<'EOF'\na | b && c\nEOF"), false);
});

test('detectForgeCandidates enforces >= 5 repeats, 7-day window, >= 2 runs and multi-step', () => {
  const qualified: ExecEntry[] = [
    bashRow(-6 * DAY, 'gh pr view 10 --json state | jq -r ".state"', { run: 'r1' }),
    bashRow(-5 * DAY, 'gh pr view 11 --json state | jq -r ".state"', { run: 'r1' }),
    bashRow(-4 * DAY, 'gh pr view 12 --json state | jq -r ".state"', { run: 'r2' }),
    bashRow(-3 * DAY, 'gh pr view 13 --json state | jq -r ".state"', { run: 'r2' }),
    bashRow(-1 * DAY, 'gh pr view 14 --json state | jq -r ".state"', { run: 'r3' }),
  ];
  const tooFew: ExecEntry[] = Array.from({ length: 4 }, (_, i) =>
    bashRow(-i * DAY, `npm run build && node ./tool${i}.mjs`, { run: `f${i}` }),
  );
  const singleRun: ExecEntry[] = Array.from({ length: 6 }, (_, i) =>
    bashRow(-i * 1000, `git diff src/a${i}.ts | wc -l`, { run: 'only-one' }),
  );
  const singleStep: ExecEntry[] = Array.from({ length: 8 }, (_, i) =>
    bashRow(-i * DAY, `git status -sb`, { run: `s${i}` }),
  );
  const expired: ExecEntry[] = [
    bashRow(-9 * DAY, 'cat /tmp/a.log | grep err', { run: 'old1' }),
    bashRow(-8 * DAY, 'cat /tmp/b.log | grep err', { run: 'old2' }),
    bashRow(-2 * DAY, 'cat /tmp/c.log | grep err', { run: 'new1' }),
    bashRow(-1 * DAY, 'cat /tmp/d.log | grep err', { run: 'new2' }),
    bashRow(-1000, 'cat /tmp/e.log | grep err', { run: 'new3' }),
  ];
  const nonBash: ExecEntry[] = Array.from({ length: 6 }, (_, i) => ({
    at: new Date(NOW - i * DAY).toISOString(),
    source: 'tool' as const,
    name: 'read',
    target: 'a | b && c',
    class: 'ok' as const,
    run: `read${i}`,
  }));

  const found = detectForgeCandidates([...qualified, ...tooFew, ...singleRun, ...singleStep, ...expired, ...nonBash], { now: NOW });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], {
    shape: 'gh pr view <num> --json state | jq -r <str>',
    count: 5,
    runs: 3,
    example: 'gh pr view 14 --json state | jq -r ".state"',
  });
});

test('detectForgeCandidates infers distinct runs from idle gaps when entries lack run ids', () => {
  const oneBurst = Array.from({ length: 5 }, (_, i) =>
    bashRow(-3600_000 + i * 30_000, `cat /tmp/a${i}.log | grep warn`),
  );
  assert.deepEqual(detectForgeCandidates(oneBurst, { now: NOW }), []);

  const twoBursts = [
    bashRow(-3 * 3600_000, 'cat /tmp/a1.log | grep warn'),
    bashRow(-3 * 3600_000 + 20_000, 'cat /tmp/a2.log | grep warn'),
    bashRow(-3 * 3600_000 + 40_000, 'cat /tmp/a3.log | grep warn'),
    bashRow(-1 * 3600_000, 'cat /tmp/a4.log | grep warn'),
    bashRow(-1 * 3600_000 + 20_000, 'cat /tmp/a5.log | grep warn'),
  ];
  const found = detectForgeCandidates(twoBursts, { now: NOW });
  assert.equal(found.length, 1);
  assert.equal(found[0].runs, 2);
  assert.equal(found[0].count, 5);

  const protoEntries = Array.from({ length: 5 }, (_, i) => bashRow(-i * 3600_000, 'constructor | toString', { run: `p${i}` }));
  assert.equal(detectForgeCandidates(protoEntries, { now: NOW })[0]?.shape, 'constructor | toString');
});

test('detectForgeCandidates ranks candidates by count descending, then runs descending', () => {
  const entries: ExecEntry[] = [
    ...Array.from({ length: 5 }, (_, i) => bashRow(-i * 3600_000, `git log -n ${i + 1} | grep fix`, { run: `a${i}` })),
    ...Array.from({ length: 9 }, (_, i) => bashRow(-i * 3600_000, `gh pr view ${i} | jq ".state"`, { run: `b${i % 3}` })),
    ...Array.from({ length: 7 }, (_, i) => bashRow(-i * 3600_000, `npm run lint && node ./check${i}.mjs`, { run: `c${i % 2}` })),
    ...Array.from({ length: 7 }, (_, i) => bashRow(-i * 3600_000, `git fetch; git diff src/f${i}.ts`, { run: `d${i}` })),
  ];
  const ranked = detectForgeCandidates(entries, { now: NOW });
  assert.deepEqual(
    ranked.map(c => [c.shape, c.count, c.runs]),
    [
      ['gh pr view <num> | jq <str>', 9, 3],
      ['git fetch; git diff <path>', 7, 7],
      ['npm run lint && node <path>', 7, 2],
      ['git log -n <num> | grep fix', 5, 5],
    ],
  );
});

test('trackForgedReuse counts later shell invocations and flags scripts unused for 30+ days for pruning', () => {
  const home = '/home/tester';
  const toolDir = `${home}/.pi/agent/bin`;
  const scripts: ForgedScript[] = [
    { name: 'pr-status.mjs', path: `${toolDir}/pr-status.mjs`, createdAt: NOW - 40 * DAY },
    { name: 'stale-used.sh', path: `${toolDir}/stale-used.sh`, createdAt: NOW - 60 * DAY },
    { name: 'never-used.mjs', path: `${toolDir}/never-used.mjs`, createdAt: NOW - 35 * DAY },
    { name: 'fresh-script.mjs', path: `${toolDir}/fresh-script.mjs`, createdAt: NOW - 3 * DAY },
  ];
  const entries: ExecEntry[] = [
    bashRow(-45 * DAY, `node ${toolDir}/pr-status.mjs 1`),
    bashRow(-10 * DAY, 'node ~/.pi/agent/bin/pr-status.mjs 2'),
    bashRow(-2 * DAY, 'pr-status.mjs 3 | head -n 5'),
    { at: new Date(NOW - DAY).toISOString(), source: 'tool', name: 'read', target: `${toolDir}/pr-status.mjs`, class: 'ok' },
    bashRow(-1 * DAY, `cat ${toolDir}/pr-status.mjs`),
    bashRow(-1 * DAY, 'node /other/dir/pr-status.mjs 4'),
    bashRow(-32 * DAY, `bash ${toolDir}/stale-used.sh --all`),
    bashRow(-31 * DAY, `bash ${toolDir}/stale-used.sh --mine`),
  ];

  const { reuse, prune } = trackForgedReuse(entries, scripts, { now: NOW, home });
  assert.deepEqual(
    reuse.map(r => ({ name: r.name, uses: r.uses, prune: r.prune })),
    [
      { name: 'pr-status.mjs', uses: 2, prune: false },
      { name: 'stale-used.sh', uses: 2, prune: true },
      { name: 'fresh-script.mjs', uses: 0, prune: false },
      { name: 'never-used.mjs', uses: 0, prune: true },
    ],
  );
  assert.deepEqual(prune.map(p => p.name), ['never-used.mjs', 'stale-used.sh']);
});

test('analyzeToolForge reads exec-log and tool dir end-to-end without any extra state file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-profile-'));
  const bin = mkdtempSync(join(tmpdir(), 'forge-bin-'));
  try {
    const activeScript = join(bin, 'summarize-diff.mjs');
    const oldScript = join(bin, 'legacy-check.sh');
    writeFileSync(activeScript, '#!/usr/bin/env node\nconsole.log("ok");\n');
    writeFileSync(oldScript, '#!/usr/bin/env bash\necho old\n');
    const launched = join(bin, 'crash-observer.js'), launcher = join(bin, 'launcher.js');
    writeFileSync(launched, 'console.log("observe");\n');
    writeFileSync(launcher, "require('./crash-observer.js');\n");
    const oldTime = new Date(NOW - 35 * DAY);
    for (const file of [activeScript, oldScript, launched, launcher]) utimesSync(file, oldTime, oldTime);

    for (let i = 0; i < 6; i++) {
      appendExecLog(dir, bashRow(-i * DAY, `git status -sb && git diff --stat src/f${i}.ts`, { run: `r${i}` }));
    }
    appendExecLog(dir, bashRow(-2 * DAY, `node "${activeScript}" --short`, { run: 'r9' }));
    appendExecLog(dir, bashRow(-1 * DAY, `node "${activeScript}" --full`, { run: 'r10' }));

    assert.equal(listForgedScripts(bin).length, 4);
    assert.equal(readExecLog(dir).length, 8);

    const report = analyzeToolForge(dir, { toolDir: bin, now: NOW });
    assert.equal(report.toolDir, bin);
    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].count, 6);
    assert.equal(report.reuse.find(s => s.name === 'summarize-diff.mjs')?.uses, 2);
    assert.deepEqual(report.prune.map(s => s.name), ['launcher.js', 'legacy-check.sh'], 'a script another one runs is not a prune candidate (25/11: pi-process-observer.js, run by pi-launcher.js, was listed)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('retroPrompt lists only the top 3 forge candidates with tool dir, skill instruction, reuse and prune items', () => {
  const plain = retroPrompt('2026-11-22');
  assert.doesNotMatch(plain, /forged script|Tool forging/i);

  const text = retroPrompt('2026-11-22', [], {
    candidates: [
      { shape: 'gh pr view <num> | jq <str>', count: 12, runs: 4, example: 'gh pr view 42 | jq ".state"' },
      { shape: 'npm run check && node <path>', count: 9, runs: 3, example: 'npm run check && node ./verify.mjs' },
      { shape: 'git fetch; git diff <path>', count: 7, runs: 3, example: 'git fetch; git diff src/a.ts' },
      { shape: 'cat <path> | grep err', count: 5, runs: 2, example: 'cat app.log | grep err' },
    ],
    reuse: [
      { name: 'pr-status.mjs', path: '/opt/tools/pr-status.mjs', createdAt: NOW - 20 * DAY, uses: 8, lastUsedAt: NOW - DAY, unusedDays: 1, prune: false },
    ],
    prune: [
      { name: 'old-tool.sh', path: '/opt/tools/old-tool.sh', createdAt: NOW - 45 * DAY, uses: 1, lastUsedAt: NOW - 33 * DAY, unusedDays: 33, prune: true },
    ],
    toolDir: '/opt/tools',
  });

  assert.match(text, /tested script under \/opt\/tools/i);
  assert.match(text, /skill/i);
  assert.match(text, /gh pr view <num> \| jq <str>.*12/);
  assert.match(text, /npm run check && node <path>.*9/);
  assert.match(text, /git fetch; git diff <path>.*7/);
  assert.doesNotMatch(text, /cat <path> \| grep err/);
  assert.match(text, /pr-status\.mjs.*8/);
  assert.match(text, /old-tool\.sh.*33/);
  assert.equal(text.match(/old-tool\.sh/g)?.length, 1);
  assert.ok(text.indexOf('gh pr view <num>') < text.indexOf('Finish with one short Slack DM'));

  const withDefaultDir = retroPrompt('2026-11-22', [], {
    candidates: [{ shape: 'a | b', count: 5, runs: 2, example: 'a | b' }],
  });
  assert.match(withDefaultDir, /~\/\.pi\/agent\/bin/);
});

test('registerExecLog tags tool entries with a run id that changes across agent_start runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'execlog-runs-'));
  try {
    const handlers: Record<string, (e: any) => void> = {};
    registerExecLog({ on: (name: string, fn: any) => { handlers[name] = fn; } } as any, () => dir);

    handlers.agent_start?.({});
    handlers.tool_execution_start({ toolCallId: '1', toolName: 'bash', args: { command: 'a | b' } });
    handlers.tool_execution_end({ toolCallId: '1', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });
    handlers.agent_settled?.({});

    handlers.agent_start?.({});
    handlers.tool_execution_start({ toolCallId: '2', toolName: 'bash', args: { command: 'a | b' } });
    handlers.tool_execution_end({ toolCallId: '2', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: 'ok' }] } });

    const rows = readExecLog(dir);
    assert.equal(rows.length, 2);
    assert.ok(typeof rows[0].run === 'string' && rows[0].run.length > 0);
    assert.ok(typeof rows[1].run === 'string' && rows[1].run.length > 0);
    assert.notEqual(rows[0].run, rows[1].run);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profile config accepts forgeToolDir and resolveToolDir defaults to ~/.pi/agent/bin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-cfg-'));
  try {
    saveConfig(dir, { ...defaults, forgeToolDir: '/custom/bin' });
    assert.equal(loadConfig(dir).forgeToolDir, '/custom/bin');
    saveConfig(dir, defaults);
    assert.equal(loadConfig(dir).forgeToolDir, undefined);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...defaults, forgeToolDir: '   ' }));
    assert.throws(() => loadConfig(dir), /Invalid profile config/);

    const fallback = resolveToolDir(undefined, '/home/u/.pi/agent', '/home/u');
    assert.equal(fallback.display, '~/.pi/agent/bin');
    assert.equal(fallback.path, join('/home/u/.pi/agent', 'bin'));
    const custom = resolveToolDir('~/my-bin', '/home/u/.pi/agent', '/home/u');
    assert.equal(custom.display, '~/my-bin');
    assert.equal(custom.path, join('/home/u', 'my-bin'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
