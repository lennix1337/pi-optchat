import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { tempDir } from './support.ts';

const SHIP = fileURLToPath(new URL('../scripts/ship.mjs', import.meta.url));
const MANIFEST_CLI = fileURLToPath(new URL('../scripts/change-manifest.mjs', import.meta.url));
const FAKE_GH = fileURLToPath(new URL('./fixtures/fake-gh.mjs', import.meta.url));
const FAKE_REVISOR = fileURLToPath(new URL('./fixtures/fake-revisor.mjs', import.meta.url));
const IDENTITY = {
  GIT_AUTHOR_NAME: 'Manifest Test',
  GIT_AUTHOR_EMAIL: 'manifest@test.invalid',
  GIT_COMMITTER_NAME: 'Manifest Test',
  GIT_COMMITTER_EMAIL: 'manifest@test.invalid',
};
const BODY = ['-b', 'Problema: prefixo alto. Mudança: reduz payload. Evidência: bench.'];
const PENDING_CI = [{ __typename: 'CheckRun', name: 'ci', status: 'IN_PROGRESS', conclusion: null }];

type Fixture = {
  dir: string;
  work: string;
  origin: string;
  bin: string;
  statePath: string;
  logPath: string;
  optchatHome: string;
  manifestPath: string;
  close(): void;
};

type ShipResult = { code: number | null; out: Record<string, string>; raw: string; err: string };

function git(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function fixture(): Fixture {
  const { dir, close } = tempDir('manifest-');
  const seed = join(dir, 'seed');
  const origin = join(dir, 'origin.git');
  const work = join(dir, 'work');
  const bin = join(dir, 'bin');
  const optchatHome = join(dir, 'optchat-home');
  const manifestPath = join(optchatHome, 'profiles', 'default', 'change-manifest.json');

  git(dir, ['init', '-q', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), 'seed\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-q', '-m', 'seed']);
  git(dir, ['init', '-q', '--bare', '-b', 'main', origin]);
  git(seed, ['push', '-q', origin, 'main']);
  git(dir, ['clone', '-q', origin, work]);
  git(work, ['switch', '-q', '-c', 'feat/improve']);

  mkdirSync(bin);
  const shim = `${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_GH)}`;
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec ${shim} "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(bin, 'gh.cmd'), `@${shim.replace(/\//g, '\\')} %*\r\n`);

  const statePath = join(dir, 'gh-state.json');
  const logPath = join(dir, 'gh.log');
  writeFileSync(statePath, JSON.stringify({ prs: [], defaults: { mergeStateStatus: 'BLOCKED', checks: PENDING_CI }, autoMerge: 'queue' }));

  return { dir, work, origin, bin, statePath, logPath, optchatHome, manifestPath, close };
}

function envFor(fx: Fixture, extra: Record<string, string> = {}) {
  const env: Record<string, string> = {
    ...process.env,
    ...IDENTITY,
    FAKE_GH_STATE: fx.statePath,
    FAKE_GH_LOG: fx.logPath,
    PI_GITWATCH_DIR: join(fx.dir, 'gitwatch'),
    SHIP_REVIEW_SCRIPT: FAKE_REVISOR,
    SHIP_REVIEW_WORKER: FAKE_REVISOR,
    OPTCHAT_HOME: fx.optchatHome,
    ...extra,
  } as Record<string, string>;
  delete env.SHIP_MANIFEST_PATH;
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = fx.bin + delimiter + (env[pathKey] ?? '');
  return env;
}

function ship(fx: Fixture, args: string[], extra: Record<string, string> = {}): ShipResult {
  const r = spawnSync(process.execPath, [SHIP, ...args], { cwd: fx.work, encoding: 'utf8', env: envFor(fx, extra), timeout: 60_000 });
  const out = Object.fromEntries(
    r.stdout.trim().split('\n').filter(Boolean).map(line => {
      const i = line.indexOf(': ');
      return [line.slice(0, i), line.slice(i + 2)];
    }),
  );
  return { code: r.status, out, raw: r.stdout, err: r.stderr };
}

function runManifest(fx: Fixture, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [MANIFEST_CLI, ...args], { cwd: fx.work, encoding: 'utf8', env: envFor(fx, extra), timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('decideVerdict and readMetricValue handle direction, tolerance, nested metrics and prototype keys', async () => {
  const mod = await import('../scripts/change-manifest.mjs');

  assert.equal(mod.decideVerdict({ before: 100, after: 90, direction: 'lower' }).verdict, 'KEEP');
  assert.equal(mod.decideVerdict({ before: 100, after: 100, direction: 'lower' }).verdict, 'KEEP');
  assert.equal(mod.decideVerdict({ before: 100, after: 101, direction: 'lower' }).verdict, 'REVERT');
  assert.equal(mod.decideVerdict({ before: 100, after: 104, direction: 'lower', tolerancePct: 5 }).verdict, 'KEEP');
  assert.equal(mod.decideVerdict({ before: 100, after: 106, direction: 'lower', tolerancePct: 5 }).verdict, 'REVERT');

  assert.equal(mod.decideVerdict({ before: 80, after: 85, direction: 'higher' }).verdict, 'KEEP');
  assert.equal(mod.decideVerdict({ before: 80, after: 80, direction: 'higher' }).verdict, 'KEEP');
  assert.equal(mod.decideVerdict({ before: 80, after: 79, direction: 'higher' }).verdict, 'REVERT');
  assert.equal(mod.decideVerdict({ before: 80, after: 77, direction: 'higher', tolerancePct: 5 }).verdict, 'KEEP');
  assert.equal(mod.decideVerdict({ before: 80, after: 75, direction: 'higher', tolerancePct: 5 }).verdict, 'REVERT');

  const benchLike = {
    'prefix.request_bytes': { value: 19223, unit: 'bytes', lowerIsBetter: true },
    'context.projection_min_saved_pct': { value: 96, unit: 'percent', lowerIsBetter: false },
  };
  assert.deepEqual(mod.readMetricValue(benchLike, 'prefix.request_bytes'), { value: 19223, unit: 'bytes', lowerIsBetter: true });
  assert.deepEqual(mod.readMetricValue(benchLike, 'context.projection_min_saved_pct'), { value: 96, unit: 'percent', lowerIsBetter: false });

  const nested = { workers: { reReads: 4, firstCallContextMedian: 'unavailable' } };
  assert.deepEqual(mod.readMetricValue(nested, 'workers.reReads'), { value: 4 });
  assert.equal(mod.readMetricValue(nested, 'workers.firstCallContextMedian'), undefined);

  assert.equal(mod.readMetricValue(nested, 'constructor'), undefined);
  assert.equal(mod.readMetricValue(nested, '__proto__'), undefined);
  assert.equal(mod.readMetricValue(nested, 'toString'), undefined);
  assert.equal(mod.readMetricValue(nested, 'workers.constructor'), undefined);
});

test('ship writes a manifest entry outside version control when --metric is given, and skips it otherwise', t => {
  const fx = fixture();
  t.after(fx.close);

  writeFileSync(join(fx.work, 'a.txt'), 'a\n');
  const plain = ship(fx, [...BODY, '-m', 'feat: plain change', 'a.txt']);
  assert.equal(plain.code, 0, plain.raw + plain.err);
  assert.equal(plain.out.manifest, undefined);
  assert.equal(existsSync(fx.manifestPath), false, 'shipping without --metric creates no manifest');

  git(fx.work, ['switch', '-q', '-c', 'feat/trim-prefix']);
  writeFileSync(join(fx.work, 'b.txt'), 'b\n');
  const tracked = ship(fx, [
    ...BODY,
    '-m', 'feat: trim request prefix',
    '--metric', 'prefix.request_bytes',
    '--before', '19223',
    'b.txt',
  ]);
  assert.equal(tracked.code, 0, tracked.raw + tracked.err);
  assert.equal(tracked.out.manifest, 'recorded');
  assert.equal(tracked.out.manifest_entry, '"pr-2:prefix.request_bytes"');
  assert.equal(existsSync(fx.manifestPath), true, 'manifest written under OPTCHAT_HOME outside the repo');
  assert.equal(git(fx.work, ['status', '--porcelain']), '', 'repo working tree stays completely clean');

  const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].change, 'feat: trim request prefix');
  assert.equal(manifest.entries[0].metric, 'prefix.request_bytes');
  assert.equal(manifest.entries[0].before, 19223);
  assert.equal(manifest.entries[0].direction, 'lower');
  assert.equal(manifest.entries[0].pr, 2);
  assert.equal(manifest.entries[0].branch, 'feat/trim-prefix');
  assert.ok(manifest.entries[0].commit);
  assert.equal(manifest.entries[0].verdict, undefined);
});

test('ship reads before value and direction from --metrics-file, and refuses bad metric args before side effects', t => {
  const fx = fixture();
  t.after(fx.close);

  writeFileSync(join(fx.work, 'a.txt'), 'a\n');
  const missingBefore = ship(fx, [...BODY, '-m', 'feat: x', '--metric', 'wakes.errors', 'a.txt']);
  assert.equal(missingBefore.code, 2);
  assert.equal(missingBefore.out.error, 'before_required');
  assert.equal(git(fx.work, ['diff', '--cached', '--name-only']), '');

  const badBefore = ship(fx, [...BODY, '-m', 'feat: x', '--metric', 'wakes.errors', '--before', 'abc', 'a.txt']);
  assert.equal(badBefore.code, 2);
  assert.equal(badBefore.out.error, 'invalid_value');

  const orphanBefore = ship(fx, [...BODY, '-m', 'feat: x', '--before', '10', 'a.txt']);
  assert.equal(orphanBefore.code, 2);
  assert.equal(orphanBefore.out.error, 'conflicting_args');

  const badDir = ship(fx, [...BODY, '-m', 'feat: x', '--metric', 'wakes.errors', '--before', '5', '--direction', 'sideways', 'a.txt']);
  assert.equal(badDir.code, 2);
  assert.equal(badDir.out.error, 'invalid_value');

  const syncConflict = ship(fx, ['--sync', '--metric', 'wakes.errors', '--before', '5']);
  assert.equal(syncConflict.code, 2);
  assert.equal(syncConflict.out.error, 'conflicting_args');

  const prConflict = ship(fx, ['--pr', '1', '--metric', 'wakes.errors', '--before', '5']);
  assert.equal(prConflict.code, 2);
  assert.equal(prConflict.out.error, 'conflicting_args');

  const bothSources = ship(fx, [...BODY, '-m', 'feat: x', '--metric', 'wakes.errors', '--before', '5', '--metrics-file', join(fx.dir, 'x.json'), 'a.txt']);
  assert.equal(bothSources.code, 2);
  assert.equal(bothSources.out.error, 'conflicting_args');

  const dry = ship(fx, [...BODY, '-m', 'feat: x', '--metric', 'wakes.errors', '--before', '5', '--dry-run', 'a.txt']);
  assert.equal(dry.code, 0, dry.raw + dry.err);
  assert.match(dry.out.plan, /manifesto \(wakes\.errors=5\)/);
  assert.equal(existsSync(fx.manifestPath), false, 'dry-run writes no manifest');

  const metricsFile = join(fx.dir, 'before.json');
  writeFileSync(metricsFile, JSON.stringify({
    'context.projection_min_saved_pct': { value: 96, unit: 'percent', lowerIsBetter: false },
  }));

  const missingMetric = ship(fx, [...BODY, '-m', 'feat: x', '--metric', 'does.not.exist', '--metrics-file', metricsFile, 'a.txt']);
  assert.equal(missingMetric.code, 2);
  assert.equal(missingMetric.out.error, 'metric_unavailable');

  const ok = ship(fx, [...BODY, '-m', 'feat: better projection', '--metric', 'context.projection_min_saved_pct', '--metrics-file', metricsFile, 'a.txt']);
  assert.equal(ok.code, 0, ok.raw + ok.err);
  const manifest = JSON.parse(readFileSync(fx.manifestPath, 'utf8'));
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].before, 96);
  assert.equal(manifest.entries[0].direction, 'higher');
  assert.equal(manifest.entries[0].unit, 'percent');
});

test('ship does not record a manifest entry when check fails before commit/push', t => {
  const fx = fixture();
  t.after(fx.close);

  writeFileSync(join(fx.work, 'package.json'), JSON.stringify({ scripts: { check: 'node -e "process.exit(1)"' } }));
  writeFileSync(join(fx.work, 'a.txt'), 'a\n');
  const failed = ship(fx, [...BODY, '-m', 'feat: broken', '--metric', 'prefix.request_bytes', '--before', '19000', 'a.txt']);
  assert.equal(failed.code, 1);
  assert.equal(failed.out.stage, 'check');
  assert.equal(existsSync(fx.manifestPath), false);
});

test('verdict command reads after values, marks KEEP and REVERT per entry, and never auto-reverts git', t => {
  const fx = fixture();
  t.after(fx.close);

  writeFileSync(join(fx.work, 'one.txt'), '1\n');
  const first = ship(fx, [
    ...BODY,
    '-m', 'feat: shrink prefix',
    '--metric', 'prefix.request_bytes',
    '--before', '19223',
    'one.txt',
  ]);
  assert.equal(first.code, 0, first.raw + first.err);

  git(fx.work, ['switch', '-q', '-c', 'feat/wake-tweak']);
  writeFileSync(join(fx.work, 'two.txt'), '2\n');
  const second = ship(fx, [
    ...BODY,
    '-m', 'feat: tweak wake loop',
    '--metric', 'wakes.errors',
    '--before', '2',
    'two.txt',
  ]);
  assert.equal(second.code, 0, second.raw + second.err);

  const headBeforeVerdict = git(fx.work, ['rev-parse', 'HEAD']);
  const afterFile = join(fx.dir, 'after.json');
  writeFileSync(afterFile, JSON.stringify({
    'prefix.request_bytes': { value: 18500, unit: 'bytes', lowerIsBetter: true },
    wakes: { errors: 5 },
  }));

  const dryVerdict = runManifest(fx, ['--metrics-file', afterFile, '--dry-run']);
  assert.equal(dryVerdict.code, 0, dryVerdict.err);
  assert.match(dryVerdict.out, /^KEEP\s+pr-1:prefix\.request_bytes\b.*19223 -> 18500/m);
  assert.match(dryVerdict.out, /^REVERT\s+pr-2:wakes\.errors\b.*2 -> 5.*git revert/m);
  const stillPending = JSON.parse(readFileSync(fx.manifestPath, 'utf8'));
  assert.equal(stillPending.entries[0].verdict, undefined, 'dry-run does not mutate manifest');

  const verdict = runManifest(fx, ['--metrics-file', afterFile]);
  assert.equal(verdict.code, 0, verdict.err);
  assert.match(verdict.out, /^KEEP\s+pr-1:prefix\.request_bytes\b/m);
  assert.match(verdict.out, /^REVERT\s+pr-2:wakes\.errors\b/m);

  assert.equal(git(fx.work, ['rev-parse', 'HEAD']), headBeforeVerdict, 'verdict command never auto-reverts git');
  assert.equal(git(fx.work, ['status', '--porcelain']), '', 'working tree untouched after verdict');

  const saved = JSON.parse(readFileSync(fx.manifestPath, 'utf8'));
  assert.equal(saved.entries[0].after, 18500);
  assert.equal(saved.entries[0].verdict, 'KEEP');
  assert.equal(saved.entries[0].delta, -723);
  assert.equal(saved.entries[1].after, 5);
  assert.equal(saved.entries[1].verdict, 'REVERT');
  assert.equal(saved.entries[1].delta, 3);
  assert.ok(saved.entries[1].measuredAt);
});

test('verdict command supports --after, --json, --help, missing metrics stay PENDING, and refuses ambiguous --after', t => {
  const fx = fixture();
  t.after(fx.close);

  const help = runManifest(fx, ['--help']);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /^usage: change-manifest\.mjs/i);
  assert.equal(help.err, '');

  writeFileSync(join(fx.work, 'a.txt'), 'a\n');
  const s1 = ship(fx, [...BODY, '-m', 'feat: one', '--metric', 'm.one', '--before', '10', 'a.txt']);
  assert.equal(s1.code, 0, s1.raw + s1.err);

  git(fx.work, ['switch', '-q', '-c', 'feat/two']);
  writeFileSync(join(fx.work, 'b.txt'), 'b\n');
  const s2 = ship(fx, [...BODY, '-m', 'feat: two', '--metric', 'm.two', '--before', '20', '--direction', 'higher', 'b.txt']);
  assert.equal(s2.code, 0, s2.raw + s2.err);

  const ambiguous = runManifest(fx, ['--after', '15']);
  assert.equal(ambiguous.code, 2);

  const partial = runManifest(fx, ['--after', 'm.two=15', '--json']);
  assert.equal(partial.code, 0, partial.err);
  const parsed = JSON.parse(partial.out);
  assert.equal(parsed.summary.pending, 1);
  assert.equal(parsed.summary.revert, 1);
  assert.equal(parsed.summary.keep, 0);
  assert.equal(parsed.entries.find((e: { id: string }) => e.id === 'pr-1:m.one').status, 'PENDING');
  assert.equal(parsed.entries.find((e: { id: string }) => e.id === 'pr-2:m.two').status, 'REVERT');

  const resolveFirst = runManifest(fx, ['--id', 'pr-1:m.one', '--after', '9']);
  assert.equal(resolveFirst.code, 0, resolveFirst.err);
  assert.match(resolveFirst.out, /^KEEP\s+pr-1:m\.one\b/m);
});

test('ship --direct-main with --metric records the commit without a PR number', t => {
  const fx = fixture();
  t.after(fx.close);

  const customManifest = join(fx.dir, 'custom-manifest.json');
  git(fx.work, ['switch', '-q', 'main']);
  writeFileSync(join(fx.work, 'a.txt'), 'a\n');
  const r = ship(fx, ['-m', 'perf: direct tweak', '--direct-main', '--metric', 'latency.ms', '--before', '-5', '--manifest', customManifest, 'a.txt']);
  assert.equal(r.code, 0, r.raw + r.err);
  assert.equal(r.out.manifest, 'recorded');
  assert.equal(existsSync(fx.manifestPath), false, '--manifest overrides the default path');
  const manifest = JSON.parse(readFileSync(customManifest, 'utf8'));
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].before, -5);
  assert.equal(manifest.entries[0].pr, undefined);
  assert.equal(manifest.entries[0].branch, 'main');
  assert.ok(manifest.entries[0].commit);

  const worse = runManifest(fx, ['--manifest', customManifest, '--after', '-2']);
  assert.equal(worse.code, 0, worse.err);
  assert.match(worse.out, /^REVERT\s+.*-5 -> -2/m);
});

test('manifest preserves decided history, supports --all re-evaluation, and rejects corrupt JSON', async t => {
  const mod = await import('../scripts/change-manifest.mjs');
  const { dir, close } = tempDir('manifest-unit-');
  t.after(close);

  const file = join(dir, 'manifest.json');
  mod.recordChange(file, { change: 'first try', metric: 'm.x', before: 100, pr: 7 });
  mod.recordChange(file, { change: 'updated pending', metric: 'm.x', before: 95, pr: 7 });
  assert.equal(mod.readManifest(file).entries.length, 1, 'pending entry with same id is updated in place');
  assert.equal(mod.readManifest(file).entries[0].before, 95);

  const firstEval = mod.evaluateManifest(file, { afterValue: 90 });
  assert.equal(firstEval.entries[0].status, 'KEEP');

  const secondEvalNoAll = mod.evaluateManifest(file, { afterValue: 120 });
  assert.equal(secondEvalNoAll.entries[0].status, 'KEEP', 'decided entry is preserved unless --all is passed');
  assert.equal(secondEvalNoAll.entries[0].evaluated, false);

  const reEval = mod.evaluateManifest(file, { afterValue: 120, all: true });
  assert.equal(reEval.entries[0].status, 'REVERT');
  assert.equal(reEval.entries[0].evaluated, true);

  const secondEntry = mod.recordChange(file, { change: 'follow-up', metric: 'm.x', before: 120, pr: 7 });
  assert.equal(secondEntry.entry.id, 'pr-7:m.x#2', 'decided entry history is preserved under a new id');
  assert.equal(mod.readManifest(file).entries.length, 2);

  const corrupt = join(dir, 'corrupt.json');
  writeFileSync(corrupt, '{bad json');
  assert.throws(() => mod.readManifest(corrupt), /manifesto inválido/);
});
