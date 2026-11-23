import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordPrediction, readPredictions, predictionId, readStaged, stagePrediction, transitionStaged } from '../src/predictions.ts';
import { QUOTA_NEAR_PERCENT, QUOTA_STALE_MS } from '../src/quota-health.ts';
import { Heartbeat, DEFAULT_HEARTBEAT, wakeTask, wakeText } from '../src/heartbeat.ts';
import { readHomeWork, renderWork } from '../src/home-items.ts';
import { composeSummary, localInputs } from '../src/slack-reports.ts';
import { defaults, loadConfig, saveConfig } from '../src/profiles.ts';
import {
  SHADOW_MAX_PER_DAY,
  acceptStagedBranch,
  pickWorkerQuotaRoute,
  reconcileAcceptedShadow,
  shadowWakeNote,
  stageNextPrediction,
  workerRoutesForShadow,
  type RepoTarget,
} from '../src/shadow-execution.ts';
import type { ModelChoice } from '../src/compactor.ts';

const NOW = new Date(2026, 10, 22, 23, 0, 0).getTime();
const TODAY = '2026-11-22';
const TOMORROW = '2026-11-23';
const NEXT_DAY = new Date(2026, 10, 23, 8, 0, 0).getTime();

const routeA: ModelChoice = { provider: 'fixture-a', model: 'worker-1', thinking: 'high' };
const routeB: ModelChoice = { provider: 'fixture-b', model: 'worker-2', thinking: 'high' };

function quotaState(entries: Record<string, { used?: number; fetchedAt?: number; resetAt?: number; serviceable?: boolean; plan?: string }>,
  extra: { exhaustedUntilByProvider?: Record<string, number>; exhaustedUntilByModel?: Record<string, number> } = {}) {
  const usageByProvider: Record<string, unknown> = {};
  for (const [id, e] of Object.entries(entries)) {
    usageByProvider[id] = {
      fetchedAt: e.fetchedAt ?? NOW - 60_000,
      ...(e.serviceable !== undefined ? { serviceable: e.serviceable } : {}),
      ...(e.plan !== undefined ? { plan: e.plan } : {}),
      ...(e.used !== undefined ? { primary: { usedPercent: e.used, resetAt: e.resetAt ?? NOW + 3_600_000 } } : {}),
    };
  }
  return { usageByProvider, ...extra };
}

function makeFakeRepo(root: string, name: string): RepoTarget {
  const path = join(root, name);
  mkdirSync(join(path, '.git'), { recursive: true });
  return { name, path };
}

test('pickWorkerQuotaRoute: respects quota-health gate, blocks, staleness, api-key plan and picks fallback route', () => {
  const ok = quotaState({ 'fixture-a': { used: QUOTA_NEAR_PERCENT - 1 } });
  assert.deepEqual(pickWorkerQuotaRoute([routeA], ok, NOW), routeA);

  const atGate = quotaState({ 'fixture-a': { used: QUOTA_NEAR_PERCENT } });
  assert.equal(pickWorkerQuotaRoute([routeA], atGate, NOW), undefined, 'at QUOTA_NEAR_PERCENT must be skipped');
  assert.equal(pickWorkerQuotaRoute([routeA], atGate, NOW, {}, 99), undefined, 'caller gate can never go looser than QUOTA_NEAR_PERCENT');

  const overCustom = quotaState({ 'fixture-a': { used: 75 } });
  assert.equal(pickWorkerQuotaRoute([routeA], overCustom, NOW, {}, 70), undefined, 'stricter caller gate is respected');

  const modelBlocked = quotaState({ 'fixture-a': { used: 20 } }, { exhaustedUntilByModel: { 'fixture-a/worker-1': NOW + 60_000 } });
  assert.equal(pickWorkerQuotaRoute([routeA], modelBlocked, NOW), undefined);

  const wakeBlocked = quotaState({ 'fixture-a': { used: 20 } });
  assert.equal(pickWorkerQuotaRoute([routeA], wakeBlocked, NOW, { 'fixture-a': NOW + 60_000 }), undefined);

  const stale = quotaState({ 'fixture-a': { used: 10, fetchedAt: NOW - QUOTA_STALE_MS - 1000 } });
  assert.equal(pickWorkerQuotaRoute([routeA], stale, NOW), undefined);

  const apiKey = quotaState({ 'fixture-a': { used: 10, plan: 'api-key' } });
  assert.equal(pickWorkerQuotaRoute([routeA], apiKey, NOW), undefined);

  assert.equal(pickWorkerQuotaRoute([routeA], {}, NOW), undefined, 'missing reading never assumes spare quota');

  const fallback = quotaState({ 'fixture-a': { used: 95 }, 'fixture-b': { used: 40 } });
  assert.deepEqual(pickWorkerQuotaRoute([routeA, routeB], fallback, NOW), routeB);

  const multiState = quotaState({ 'fixture-a': { used: 95 }, 'fixture-a-account-2': { used: 25 } });
  const expanded = workerRoutesForShadow({ workerModels: { code: [routeA] } }, { provider: 'fixture-a' }, multiState);
  assert.deepEqual(pickWorkerQuotaRoute(expanded, multiState, NOW), { ...routeA, provider: 'fixture-a-account-2' });
});

test('selection: picks top buildable prediction, skips non-buildable, skips staged and under-gate quota, enforces max 1 per day and config switch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-sel-'));
  const reposRoot = join(dir, 'repos');
  try {
    const appRepo = makeFakeRepo(reposRoot, 'sample-app');
    const libRepo = makeFakeRepo(reposRoot, 'sample-lib');
    const repos = [appRepo, libRepo];

    recordPrediction(dir, { day: '2026-11-20', text: 'Old task in sample-app', status: 'predicted' }, NOW - 2 * 86_400_000);
    recordPrediction(dir, { day: TOMORROW, text: 'Reply to vendor invoice', status: 'predicted' }, NOW - 5000);
    recordPrediction(dir, { day: TOMORROW, text: 'Fix retry timeout in sample-app', status: 'predicted', evidence: 'open issue #4' }, NOW - 4000);
    recordPrediction(dir, { day: TOMORROW, text: 'Add cache tests', status: 'predicted', repo: 'sample-lib' }, NOW - 3000);
    recordPrediction(dir, { day: TODAY, text: 'Harden config parser in sample-app', status: 'predicted' }, NOW - 2000);

    const lowQuota = quotaState({ 'fixture-a': { used: 92 } });
    const skippedQuota = stageNextPrediction({ dir, now: NOW, repos, routes: [routeA], quotaState: lowQuota });
    assert.equal(skippedQuota.staged, undefined);
    assert.equal(skippedQuota.reason, 'quota');

    const goodQuota = quotaState({ 'fixture-a': { used: 35 } });
    const disabled = stageNextPrediction({ dir, now: NOW, repos, routes: [routeA], quotaState: goodQuota, enabled: false });
    assert.equal(disabled.staged, undefined);
    assert.equal(disabled.reason, 'disabled');

    const first = stageNextPrediction({ dir, now: NOW, repos, routes: [routeA], quotaState: goodQuota });
    assert.ok(first.staged, 'should stage today prediction ahead of tomorrow');
    assert.equal(first.staged.id, predictionId(TODAY, 'Harden config parser in sample-app'));
    assert.equal(first.staged.repo, 'sample-app');
    assert.equal(first.staged.repoPath, appRepo.path);
    assert.match(first.staged.branch, /^shadow\/[a-z0-9-]+$/);
    assert.equal(first.staged.status, 'staged');
    assert.match(first.staged.brief, /Harden config parser in sample-app/);
    assert.deepEqual(first.route, routeA);

    assert.deepEqual(readdirSync(dir).filter(f => f.endsWith('.json') || f.endsWith('.jsonl')), ['predictions.jsonl'], 'reuses predictions.jsonl with no new state file');

    assert.equal(SHADOW_MAX_PER_DAY, 1);
    const capped = stageNextPrediction({ dir, now: NOW + 60_000, repos, routes: [routeA], quotaState: goodQuota });
    assert.equal(capped.staged, undefined);
    assert.equal(capped.reason, 'daily-cap');

    transitionStaged(dir, first.staged.id, 'dropped', 'no longer needed', NOW + 90_000);
    const stillCappedAfterDrop = stageNextPrediction({ dir, now: NOW + 120_000, repos, routes: [routeA], quotaState: goodQuota });
    assert.equal(stillCappedAfterDrop.staged, undefined);
    assert.equal(stillCappedAfterDrop.reason, 'daily-cap', 'daily cap still applies even after a staged item is dropped');

    const nextDayQuota = quotaState({ 'fixture-a': { used: 35, fetchedAt: NEXT_DAY - 60_000, resetAt: NEXT_DAY + 3_600_000 } });
    const nextDay = stageNextPrediction({ dir, now: NEXT_DAY, repos, routes: [routeA], quotaState: nextDayQuota });
    assert.ok(nextDay.staged, 'next day picks top remaining buildable prediction');
    assert.equal(nextDay.staged.repo, 'sample-app');
    assert.equal(nextDay.staged.text, 'Fix retry timeout in sample-app');

    const explicitRepo = stageNextPrediction({ dir, now: NEXT_DAY + 60_000, repos, routes: [routeA], quotaState: nextDayQuota, maxPerDay: 2 });
    assert.ok(explicitRepo.staged, 'explicit repo field resolves even when text does not name repo');
    assert.equal(explicitRepo.staged.repo, 'sample-lib');
    assert.equal(explicitRepo.staged.text, 'Add cache tests');

    const dayAfter = NEXT_DAY + 86_400_000;
    const dayAfterQuota = quotaState({ 'fixture-a': { used: 35, fetchedAt: dayAfter - 60_000, resetAt: dayAfter + 3_600_000 } });
    const noneLeft = stageNextPrediction({ dir, now: dayAfter, repos, routes: [routeA], quotaState: dayAfterQuota, maxPerDay: 5 });
    assert.equal(noneLeft.staged, undefined);
    assert.equal(noneLeft.reason, 'no-candidate');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('state transitions: staged -> accepted / dropped, rejects invalid transitions and unsafe branch names, keeps recordPrediction compatible', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-state-'));
  try {
    recordPrediction(dir, { day: TOMORROW, text: 'Refactor parser in sample-app', status: 'predicted' }, NOW);
    recordPrediction(dir, { day: TOMORROW, text: 'Tighten schema in sample-lib', status: 'predicted' }, NOW + 1);

    assert.throws(() => stagePrediction(dir, { day: TOMORROW, text: 'Unrecorded task', repo: 'sample-app', branch: 'shadow/x', brief: 'do x' }, NOW + 2), /Invalid/);
    assert.throws(() => stagePrediction(dir, { day: TOMORROW, text: 'Refactor parser in sample-app', repo: 'sample-app', branch: 'main', brief: 'do x' }, NOW + 2), /branch/i);
    assert.throws(() => stagePrediction(dir, { day: TOMORROW, text: 'Refactor parser in sample-app', repo: 'sample-app', branch: 'shadow/../escape', brief: 'do x' }, NOW + 2), /branch/i);

    const s1 = stagePrediction(dir, { day: TOMORROW, text: 'Refactor parser in sample-app', repo: 'sample-app', branch: 'shadow/refactor-parser', brief: 'Refactor parser locally' }, NOW + 10);
    assert.equal(s1.status, 'staged');
    assert.throws(() => stagePrediction(dir, { day: TOMORROW, text: 'Refactor parser in sample-app', repo: 'sample-app', branch: 'shadow/refactor-parser-2', brief: 'dup' }, NOW + 11), /Invalid/);

    const accepted = transitionStaged(dir, s1.id, 'accepted', 'merged into main', NOW + 20);
    assert.equal(accepted.status, 'accepted');
    assert.throws(() => transitionStaged(dir, s1.id, 'dropped', 'too late', NOW + 21), /Invalid/);
    assert.throws(() => transitionStaged(dir, s1.id, 'accepted', 'dup', NOW + 22), /Invalid/);

    const s2 = stagePrediction(dir, { day: TOMORROW, text: 'Tighten schema in sample-lib', repo: 'sample-lib', branch: 'shadow/tighten-schema', brief: 'Tighten schema' }, NOW + 30);
    const dropped = transitionStaged(dir, s2.id, 'dropped', 'superseded', NOW + 40);
    assert.equal(dropped.status, 'dropped');
    assert.throws(() => transitionStaged(dir, s2.id, 'accepted', 'too late', NOW + 41), /Invalid/);
    assert.throws(() => transitionStaged(dir, 'pred_missing', 'dropped', 'nope', NOW + 42), /Invalid/);

    recordPrediction(dir, { day: TOMORROW, text: 'Refactor parser in sample-app', status: 'hit', evidence: 'refactor the parser' }, NOW + 50);
    assert.equal(readStaged(dir).length, 2);
    assert.equal(readStaged(dir, { status: 'accepted' }).length, 1);
    assert.equal(readStaged(dir, { status: 'dropped' }).length, 1);
    assert.equal(readStaged(dir, { status: 'staged' }).length, 0);
    assert.ok(readPredictions(dir).some(row => row.status === 'hit'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('wake prompt text and idle heartbeat wake include staged worker instructions on a local branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-wake-'));
  const reposRoot = join(dir, 'repos');
  try {
    const appRepo = makeFakeRepo(reposRoot, 'sample-app');
    recordPrediction(dir, { day: TOMORROW, text: 'Add timeout guard in sample-app', status: 'predicted' }, NOW - 1000);
    const goodQuota = quotaState({ 'fixture-a': { used: 25 } });

    const stagedRes = stageNextPrediction({ dir, now: NOW, repos: [appRepo], routes: [routeA], quotaState: goodQuota });
    assert.ok(stagedRes.staged);
    const note = shadowWakeNote(stagedRes.staged, stagedRes.route);
    assert.match(note, new RegExp(stagedRes.staged.id));
    assert.match(note, /sample-app/);
    assert.match(note, new RegExp(stagedRes.staged.branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(note, /spawn/i);
    assert.match(note, /local branch/i);
    assert.match(note, /never push|do not push/i);

    const prompt = wakeText('check idle', 'compactor', 30, DEFAULT_HEARTBEAT, undefined, undefined, {}, note);
    assert.equal(wakeTask(prompt), 'check idle', 'wakeTask still parses wakeText with shadow section');
    assert.ok(prompt.includes(stagedRes.staged.branch));
    assert.ok(prompt.includes(stagedRes.staged.id));

    const dir2 = mkdtempSync(join(tmpdir(), 'shadow-hb-'));
    try {
      recordPrediction(dir2, { day: TOMORROW, text: 'Build metrics helper in sample-app', status: 'predicted' }, NOW - 1000);
      let timer: { run: () => void } | undefined;
      const woken: { stagedId?: string; branch?: string }[] = [];
      const hb = new Heartbeat({
        dir: dir2, now: () => NOW, minutes: () => 30, maxWakes: () => 4, always: () => true, busy: () => undefined,
        setTimer: run => { timer = { run }; return timer; }, clearTimer: () => { timer = undefined; },
        check: async () => ({ wake: true, text: '' }),
        stageShadow: () => stageNextPrediction({ dir: dir2, now: NOW, repos: [appRepo], routes: [routeA], quotaState: goodQuota }).staged,
        wake: beat => { woken.push({ stagedId: beat.staged?.id, branch: beat.staged?.branch }); },
        note: () => {},
      });
      hb.arm();
      timer!.run();
      await hb.settled();
      assert.equal(woken.length, 1);
      assert.equal(woken[0]!.stagedId, predictionId(TOMORROW, 'Build metrics helper in sample-app'));
      assert.match(woken[0]!.branch!, /^shadow\//);
    } finally { rmSync(dir2, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('acceptance tracking: a staged branch later merged is marked accepted (real git repo + idempotent)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-merge-'));
  const remoteDir = join(dir, 'origin.git');
  const repoDir = join(dir, 'sample-app');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    mkdirSync(remoteDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    git(remoteDir, 'init', '--bare');
    git(repoDir, 'init', '-b', 'main');
    git(repoDir, 'config', 'user.email', 'fixture@example.com');
    git(repoDir, 'config', 'user.name', 'Fixture');
    writeFileSync(join(repoDir, 'README.md'), 'init\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'init');
    git(repoDir, 'remote', 'add', 'origin', remoteDir);
    git(repoDir, 'push', '-u', 'origin', 'main');

    recordPrediction(dir, { day: TOMORROW, text: 'Add health check in sample-app', status: 'predicted' }, NOW);
    const staged = stagePrediction(dir, {
      day: TOMORROW, text: 'Add health check in sample-app', repo: 'sample-app', repoPath: repoDir,
      branch: 'shadow/add-health-check', brief: 'Add health check',
    }, NOW + 10);

    git(repoDir, 'checkout', '-b', staged.branch);
    writeFileSync(join(repoDir, 'health.txt'), 'ok\n');
    git(repoDir, 'add', '.');
    git(repoDir, 'commit', '-m', 'shadow work');

    const beforeMerge = await reconcileAcceptedShadow(dir, { now: NOW + 100 });
    assert.deepEqual(beforeMerge, []);
    assert.equal(readStaged(dir)[0]!.status, 'staged');

    git(repoDir, 'checkout', 'main');
    git(repoDir, 'merge', '--no-ff', staged.branch, '-m', 'accept shadow');
    git(repoDir, 'push', 'origin', 'main');

    const afterMerge = await reconcileAcceptedShadow(dir, { now: NOW + 200 });
    assert.equal(afterMerge.length, 1);
    assert.equal(afterMerge[0]!.id, staged.id);
    assert.equal(afterMerge[0]!.status, 'accepted');
    assert.equal(readStaged(dir, { status: 'accepted' }).length, 1);

    const again = await reconcileAcceptedShadow(dir, { now: NOW + 300 });
    assert.deepEqual(again, [], 'reconcile is idempotent');

    recordPrediction(dir, { day: TOMORROW, text: 'Second branch in sample-app', status: 'predicted' }, NOW + 310);
    const direct = stagePrediction(dir, { day: TOMORROW, text: 'Second branch in sample-app', repo: 'sample-app', branch: 'shadow/second-branch', brief: 'Direct merge check' }, NOW + 320);
    assert.deepEqual(acceptStagedBranch(dir, 'shadow/other-branch', undefined, NOW + 330), []);
    const acceptedDirect = acceptStagedBranch(dir, direct.branch, 'https://github.com/org/sample-app/pull/5', NOW + 340);
    assert.equal(acceptedDirect.length, 1);
    assert.equal(acceptedDirect[0]!.status, 'accepted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('daily summary and Home items surface staged entries, and omit section when none exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-surface-'));
  try {
    assert.equal(readHomeWork(dir, [], NOW).staged, undefined);
    assert.doesNotMatch(composeSummary({ day: [], waiting: [], prs: [], approvals: 0 }), /Preparado em shadow/);

    recordPrediction(dir, { day: TOMORROW, text: 'Add retry metrics in sample-app', status: 'predicted' }, NOW);
    stagePrediction(dir, { day: TOMORROW, text: 'Add retry metrics in sample-app', repo: 'sample-app', branch: 'shadow/retry-metrics', brief: 'Add retry metrics' }, NOW + 10);

    const homeWork = readHomeWork(dir, [], NOW + 20);
    assert.equal(homeWork.staged?.length, 1);
    const renderedHome = renderWork(homeWork);
    assert.match(renderedHome, /Preparado em branch/);
    assert.match(renderedHome, /sample-app/);
    assert.match(renderedHome, /shadow\/retry-metrics/);

    const inputs = localInputs(dir, NOW + 30, []);
    assert.equal(inputs.staged?.length, 1);
    const summary = composeSummary({ ...inputs, waiting: [], approvals: 0 });
    assert.match(summary, /\*Preparado em shadow\*/);
    assert.match(summary, /sample-app/);
    assert.match(summary, /shadow\/retry-metrics/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config switch: speculativeShadow defaults to true, turns off cleanly, and shadowRepos validates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-cfg-'));
  try {
    assert.equal(defaults.speculativeShadow, true);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ compactor: defaults.compactor, subagent: defaults.subagent }));
    const loaded = loadConfig(dir);
    assert.equal(loaded.speculativeShadow, true);

    saveConfig(dir, { ...loaded, speculativeShadow: false, shadowRepos: ['/repos/sample-app'] });
    const updated = loadConfig(dir);
    assert.equal(updated.speculativeShadow, false);
    assert.deepEqual(updated.shadowRepos, ['/repos/sample-app']);

    const raw = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...raw, speculativeShadow: 'off' }));
    assert.throws(() => loadConfig(dir), /Invalid profile config/);

    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...raw, shadowRepos: [''] }));
    assert.throws(() => loadConfig(dir), /Invalid profile config/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
