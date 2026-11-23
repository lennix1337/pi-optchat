import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_HEARTBEAT, wakeText } from '../src/heartbeat.ts';
import { defaults, loadConfig } from '../src/profiles.ts';
import { composeSummary, DailySummary, localInputs, PrWatch } from '../src/slack-reports.ts';
import {
  DEFAULT_NIGHT_SHIFT,
  inNightShiftWindow,
  invalidNightShift,
  nightShiftConfig,
  nightShiftDigest,
  nightShiftLogPath,
  nightShiftWakeNote,
  readNightShiftLog,
  recordNightShiftAttempt,
} from '../src/night-shift.ts';
import { removeDir } from './support.ts';

const at = (day: number, hh: number, mm: number) => new Date(2026, 3, day, hh, mm, 0, 0).getTime();

test('nightShift defaults are neutral and disabled, and config validation rejects bad windows and fields', () => {
  assert.equal(DEFAULT_NIGHT_SHIFT.enabled, false);
  assert.equal(DEFAULT_NIGHT_SHIFT.window, '01:00-06:00');
  assert.equal(DEFAULT_NIGHT_SHIFT.digestAt, '08:30');
  assert.deepEqual(DEFAULT_NIGHT_SHIFT.repos, []);
  assert.deepEqual(DEFAULT_NIGHT_SHIFT.sentryProjects, []);

  assert.equal(invalidNightShift(undefined), undefined);
  assert.equal(invalidNightShift({ enabled: false, window: '01:00-06:00', repos: ['acme/app'], sentryProjects: ['app-api'], digestAt: '08:30' }), undefined);
  assert.equal(invalidNightShift({ enabled: true, window: '23:00-05:00', repos: [], digestAt: '07:15' }), undefined);

  for (const bad of ['01:00', '25:00-06:00', '01:60-06:00', '03:00-03:00', 'night', '1:00-6:00']) {
    assert.ok(invalidNightShift({ enabled: true, window: bad }), `expected bad window rejected: ${bad}`);
  }
  assert.ok(invalidNightShift({ enabled: 'yes', window: '01:00-06:00' }));
  assert.ok(invalidNightShift({ enabled: true, window: '01:00-06:00', digestAt: '24:00' }));
  assert.ok(invalidNightShift({ enabled: true, window: '01:00-06:00', repos: ['../bad'] }));
  assert.ok(invalidNightShift({ enabled: true, window: '01:00-06:00', sentryProjects: [''] }));

  const dir = mkdtempSync(join(tmpdir(), 'oc-ns-cfg-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      compactor: defaults.compactor,
      subagent: defaults.subagent,
      nightShift: { enabled: true, window: '99:00-06:00' },
    }));
    assert.throws(() => loadConfig(dir), /Invalid profile config/);

    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      compactor: defaults.compactor,
      subagent: defaults.subagent,
      nightShift: { enabled: true, window: '01:00-06:00', repos: ['acme/widget'], sentryProjects: ['widget-web'], digestAt: '08:30' },
    }));
    const loaded = loadConfig(dir);
    assert.equal(loaded.nightShift?.enabled, true);
    assert.deepEqual(nightShiftConfig(loaded).repos, ['acme/widget']);
  } finally { removeDir(dir); }
});

test('wake text inside the window carries night-shift instructions and sources; outside or disabled it does not', () => {
  const cfg = {
    enabled: true,
    window: '01:00-06:00',
    repos: ['acme/alpha', 'acme/beta'],
    sentryProjects: ['alpha-api'],
    digestAt: '08:30',
  };
  const logPath = '/tmp/profile/night-shift.json';

  assert.equal(inNightShiftWindow('01:00-06:00', at(10, 1, 0)), true);
  assert.equal(inNightShiftWindow('01:00-06:00', at(10, 5, 59)), true);
  assert.equal(inNightShiftWindow('01:00-06:00', at(10, 6, 0)), false);
  assert.equal(inNightShiftWindow('01:00-06:00', at(10, 0, 59)), false);
  assert.equal(inNightShiftWindow('23:00-05:00', at(10, 23, 30)), true);
  assert.equal(inNightShiftWindow('23:00-05:00', at(11, 4, 59)), true);
  assert.equal(inNightShiftWindow('23:00-05:00', at(11, 5, 0)), false);

  const insideNote = nightShiftWakeNote(cfg, logPath, at(10, 2, 15));
  assert.ok(insideNote, 'inside window should produce night-shift note');
  const insideWake = wakeText('', 'compactor', 30, DEFAULT_HEARTBEAT, undefined, undefined, {}, undefined, undefined, insideNote);
  assert.match(insideWake, /Night shift \(01:00-06:00\)/);
  assert.match(insideWake, /acme\/alpha, acme\/beta/);
  assert.match(insideWake, /alpha-api/);
  assert.match(insideWake, /failing test/i);
  assert.match(insideWake, /draft/i);
  assert.ok(insideWake.includes(logPath));

  const outsideNote = nightShiftWakeNote(cfg, logPath, at(10, 9, 0));
  assert.equal(outsideNote, undefined);
  const outsideWake = wakeText('', 'compactor', 30, DEFAULT_HEARTBEAT, undefined, undefined, {}, undefined, undefined, outsideNote);
  assert.doesNotMatch(outsideWake, /Night shift/);

  const disabledNote = nightShiftWakeNote({ ...cfg, enabled: false }, logPath, at(10, 2, 15));
  assert.equal(disabledNote, undefined);
});

test('night-shift digest lists only last night log entries, capped at 5 lines, and posts at digestAt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-ns-log-'));
  try {
    const cfg = {
      enabled: true,
      window: '01:00-06:00',
      repos: ['acme/alpha'],
      sentryProjects: ['alpha-api'],
      digestAt: '08:30',
    };

    // Two nights ago (should be excluded)
    recordNightShiftAttempt(dir, { item: 'acme/alpha#10: old issue', branch: 'ns/10', prUrl: 'https://github.com/acme/alpha/pull/10' }, at(9, 2, 0));
    // Yesterday afternoon (outside window, should be excluded)
    recordNightShiftAttempt(dir, { item: 'acme/alpha#11: daytime', branch: 'ns/11', reason: 'outside window' }, at(9, 15, 0));
    // Last night (should be included)
    recordNightShiftAttempt(dir, { item: 'acme/alpha#21: null pointer', branch: 'ns/21', prUrl: 'https://github.com/acme/alpha/pull/21' }, at(10, 1, 30));
    recordNightShiftAttempt(dir, { item: 'sentry:ALPHA-7', branch: 'ns/alpha-7', reason: 'could not reproduce locally' }, at(10, 2, 45));
    recordNightShiftAttempt(dir, { item: 'acme/alpha#22: timeout', branch: 'ns/22', prUrl: 'https://github.com/acme/alpha/pull/22' }, at(10, 3, 15));
    recordNightShiftAttempt(dir, { item: 'acme/alpha#23: flaky spec', branch: 'ns/23', prUrl: 'https://github.com/acme/alpha/pull/23' }, at(10, 4, 0));
    recordNightShiftAttempt(dir, { item: 'acme/alpha#24: auth check', branch: 'ns/24', reason: 'missing test fixture' }, at(10, 4, 45));
    recordNightShiftAttempt(dir, { item: 'acme/alpha#25: race condition', branch: 'ns/25', prUrl: 'https://github.com/acme/alpha/pull/25' }, at(10, 5, 20));

    assert.equal(readNightShiftLog(dir).length, 8);
    assert.equal(nightShiftLogPath(dir), join(dir, 'night-shift.json'));

    const digest = nightShiftDigest(readNightShiftLog(dir), cfg, at(10, 8, 30));
    assert.equal(digest.length, 5, 'digest is capped at 5 lines');
    const joined = digest.join('\n');
    assert.doesNotMatch(joined, /#10/);
    assert.doesNotMatch(joined, /#11/);
    assert.match(joined, /#21/);
    assert.match(joined, /pull\/21/);
    assert.match(joined, /mais 2 tentativa\(s\)/);

    const summary = composeSummary({ ...localInputs(dir, at(10, 8, 30), [], cfg), waiting: [], approvals: 0 });
    assert.match(summary, /\*Turno da madrugada\*/);
    assert.match(summary, /https:\/\/github\.com\/acme\/alpha\/pull\/21/);

    // DailySummary respects digestAt when nightShift is enabled
    const posted: string[] = [];
    const prs = new PrWatch(() => ({ dir, name: 'fixture' }), async () => {});
    const dailyEarly = new DailySummary(
      () => ({ dir, name: 'fixture' }),
      async text => { posted.push(text); },
      prs,
      () => 0,
      {
        now: () => at(10, 8, 29),
        nightShift: () => cfg,
        request: async () => { throw new Error('offline'); },
        gh: async () => { throw new Error('offline'); },
        interventionScoreboard: async () => 'Intervenções: fixture',
      },
    );
    assert.equal(await dailyEarly.maybePost(), false, 'not before digestAt 08:30');

    const dailyReady = new DailySummary(
      () => ({ dir, name: 'fixture' }),
      async text => { posted.push(text); },
      prs,
      () => 0,
      {
        now: () => at(10, 8, 30),
        nightShift: () => cfg,
        request: async () => { throw new Error('offline'); },
        gh: async () => { throw new Error('offline'); },
        interventionScoreboard: async () => 'Intervenções: fixture',
      },
    );
    assert.equal(await dailyReady.maybePost(), true, 'posts at digestAt 08:30');
    assert.equal(posted.length, 1);
    assert.match(posted[0]!, /\*Turno da madrugada\*/);
  } finally { removeDir(dir); }
});
