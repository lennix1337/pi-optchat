import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forecastPace, PACE_DEFAULTS, paceControl, paceWakeMinutes, paceForecasts, paceText, paceWakeNote, PACE_OVER_SUGGESTION, PACE_UNDER_SUGGESTION } from '../src/quota-pace.ts';
import { QUOTA_HISTORY_FILE, type QuotaRow } from '../src/quota-history.ts';
import { loadEconomy } from '../src/quota-load.ts';
import { accountText } from '../src/quota-format.ts';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 20, 12, 0);
const RESET = NOW + 4 * DAY;

function hourly(provider: string, from: number, perHour: number, hours = 24, resetAt = RESET): QuotaRow[] {
  return Array.from({ length: hours + 1 }, (_, i) => {
    const fetchedAt = NOW - (hours - i) * HOUR;
    return { at: fetchedAt, provider, fetchedAt, w7d: { used: from + perHour * i, resetAt } };
  });
}
const windowOf = (rows: QuotaRow[]) => ({ w7d: rows.at(-1)!.w7d });

test('a rising burn is projected linearly to the reset and judged against 95%', () => {
  const rising = forecastPace(hourly('a', 20, 1), NOW);
  assert.ok(rising);
  assert.equal(rising.used, 44);
  assert.equal(rising.projectedAtReset, 44 + 96);
  assert.equal(rising.verdict, 'over');
  assert.equal(rising.headroomPct, -40);
  assert.equal(rising.suggestion, PACE_OVER_SUGGESTION);

  const slow = forecastPace(hourly('a', 20, 0.25), NOW);
  assert.equal(slow?.projectedAtReset, 26 + 24);
  assert.equal(slow?.verdict, 'under');
  assert.equal(slow?.headroomPct, 50);
  assert.equal(slow?.suggestion, PACE_UNDER_SUGGESTION);
  assert.match(PACE_UNDER_SUGGESTION, /sobra cota: aumente thinking \/ spawn mais/);

  const fit = forecastPace(hourly('a', 20, 0.5), NOW);
  assert.equal(fit?.projectedAtReset, 32 + 48);
  assert.equal(fit?.verdict, 'under', '80% is below the 95% target');
  const edge = forecastPace(hourly('a', 20, 0.75), NOW);
  assert.equal(edge?.projectedAtReset, 38 + 72);
  assert.equal(edge?.verdict, 'over', '110% hits the limit');
  const onTrack = forecastPace(hourly('a', 20, 0.65), NOW);
  assert.equal(onTrack?.projectedAtReset, 98);
  assert.equal(onTrack?.verdict, 'on-track', '95-100% is the target band');
});

test('a flat history projects what is used now; only the last 24 hours set the rate', () => {
  const flat = forecastPace(hourly('a', 30, 0), NOW);
  assert.equal(flat?.projectedAtReset, 30);
  assert.equal(flat?.verdict, 'under');
  assert.equal(flat?.headroomPct, 70);

  const old: QuotaRow[] = [
    { at: NOW - 3 * DAY, provider: 'a', fetchedAt: NOW - 3 * DAY, w7d: { used: 0, resetAt: RESET } },
    ...hourly('a', 60, 0),
  ];
  assert.equal(forecastPace(old, NOW)?.projectedAtReset, 60, 'the burst three days ago is not the current rate');
});

test('an exhausted account is over with nothing left, whatever the rate', () => {
  const spent = forecastPace(hourly('a', 100, 0), NOW);
  assert.equal(spent?.projectedAtReset, 100);
  assert.equal(spent?.verdict, 'over');
  assert.equal(spent?.headroomPct, 0);
  assert.equal(spent?.suggestion, PACE_OVER_SUGGESTION);
  const one = forecastPace([{ at: NOW, provider: 'a', fetchedAt: NOW, w7d: { used: 100, resetAt: RESET }, serviceable: false, blockedUntil: RESET }], NOW);
  assert.equal(one?.verdict, 'over');
});

test('readings from before the last reset are ignored, and a window that already renewed has no forecast', () => {
  const before: QuotaRow[] = Array.from({ length: 6 }, (_, i) => ({
    at: NOW - 30 * HOUR + i * HOUR, provider: 'a', fetchedAt: NOW - 30 * HOUR + i * HOUR, w7d: { used: 90 + i, resetAt: NOW - 25 * HOUR },
  }));
  const after = hourly('a', 0, 0.25, 12, RESET);
  const crossed = forecastPace([...before, ...after], NOW);
  assert.equal(crossed?.used, 3);
  assert.equal(crossed?.projectedAtReset, 3 + 0.25 * 96, 'the old window\'s 95% never counts, nor does the drop at the reset');
  assert.equal(crossed?.verdict, 'under');

  const jitter = hourly('a', 20, 0.25).map((r, i) => ({ ...r, w7d: { used: r.w7d!.used, resetAt: RESET + (i % 3) * 300 } }));
  assert.equal(forecastPace(jitter, NOW)?.projectedAtReset, 26 + 24, 'the provider\'s reset stamp jitters by under five minutes');

  assert.equal(forecastPace(hourly('a', 20, 1, 24, NOW - HOUR), NOW), undefined, 'the last reading is of a window that has ended');
});

test('with too few recent readings the whole window\'s average is used, and with no basis there is no forecast', () => {
  const start = RESET - 7 * DAY;
  const single: QuotaRow[] = [{ at: NOW, provider: 'a', fetchedAt: NOW, w7d: { used: 30, resetAt: RESET } }];
  const avg = forecastPace(single, NOW);
  const elapsed = NOW - start;
  assert.equal(avg?.projectedAtReset, Math.round((30 + 30 / elapsed * (RESET - NOW)) * 10) / 10);
  assert.equal(avg?.basis, 'window');
  assert.equal(forecastPace(hourly('a', 20, 1), NOW)?.basis, 'recent');

  const fresh: QuotaRow[] = [{ at: NOW, provider: 'a', fetchedAt: NOW, w7d: { used: 3, resetAt: NOW + 7 * DAY - HOUR } }];
  assert.equal(forecastPace(fresh, NOW), undefined, 'one hour into a window says nothing');
  assert.equal(forecastPace([{ at: NOW, provider: 'a', fetchedAt: NOW, plan: 'api-key' }], NOW), undefined);
  assert.equal(forecastPace([], NOW), undefined);
});

test('in the first day after a reset the burn is spread over a full day, so a busy afternoon is not projected over the whole week', () => {
  const resetAt = NOW + 7 * DAY - 2.5 * HOUR;
  const rows: QuotaRow[] = [0, 1, 2].map(i => ({ at: NOW - (2 - i) * HOUR, provider: 'a', fetchedAt: NOW - (2 - i) * HOUR, w7d: { used: i, resetAt } }));
  const f = forecastPace(rows, NOW);
  const hoursLeft = (resetAt - NOW) / HOUR;
  assert.equal(f?.basis, 'since-reset');
  assert.equal(f?.projectedAtReset, Math.round((2 + 2 / 24 * hoursLeft) * 10) / 10);
  assert.equal(f?.verdict, 'under');

  const dayOld = NOW + 7 * DAY - 25 * HOUR;
  const steady = hourly('a', 0, 0.5, 24, dayOld);
  assert.equal(forecastPace(steady, NOW)?.basis, 'recent', 'after a full day the last 24 hours set the rate again');
});

test('the meter dropping inside one window (a provider correction) counts as no burn, never a negative rate', () => {
  const down = forecastPace(hourly('a', 50, -0.5, 10), NOW);
  assert.equal(down?.projectedAtReset, 45);
});

test('paceForecasts gives one forecast per account, sorted, skipping accounts with no weekly meter', () => {
  const rows = [...hourly('b', 10, 0.1), ...hourly('a', 10, 2), { at: NOW, provider: 'c', fetchedAt: NOW, plan: 'api-key' } as QuotaRow];
  const all = paceForecasts(rows, NOW);
  assert.deepEqual(all.map(f => [f.provider, f.verdict]), [['a', 'over'], ['b', 'under']]);
});

test('texts: the card line, the wake note, and nothing to say when every account is on track', () => {
  const [under] = paceForecasts(hourly('anthropic-account-2', 20, 0.25), NOW);
  const [over] = paceForecasts(hourly('openai-codex', 20, 1), NOW);
  assert.equal(paceText(under!), 'projeção: 50% no reset');
  assert.equal(paceText(over!), 'projeção: 140% no reset');
  const note = paceWakeNote([under!, over!], id => `conta ${id}`)!;
  assert.match(note, /conta anthropic-account-2: .*projeção: 50% no reset.*sobra cota: aumente thinking \/ spawn mais/);
  assert.match(note, /conta openai-codex: .*projeção: 140% no reset.*estoura/);
  const [fit] = paceForecasts(hourly('a', 20, 0.65), NOW);
  assert.equal(paceWakeNote([fit!]), undefined);
  assert.equal(paceWakeNote([]), undefined);
});

test('the economy carries each account\'s forecast from the history file, and the account line shows it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-pace-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, QUOTA_HISTORY_FILE), hourly('anthropic-account-2', 20, 0.25).map(r => JSON.stringify(r)).join('\n') + '\n');
  const economy = loadEconomy({ dir, now: NOW, cacheFile: join(dir, 'none.json') });
  const account = economy.accounts.find(a => a.provider === 'anthropic-account-2');
  assert.equal(account?.pace?.projectedAtReset, 50);
  const state = { usageByProvider: { 'anthropic-account-2': { fetchedAt: NOW, secondary: { usedPercent: 26, resetAt: RESET, windowSeconds: 604_800 } } } };
  assert.match(accountText('anthropic-account-2', state, NOW, account), /7d 26% usado, renova .* · projeção: 50% no reset/);
  assert.doesNotMatch(accountText('anthropic-account-2', state, NOW, { provider: 'anthropic-account-2' }), /projeção/);
});

const BASE = { baseMin: 30, floorMin: 10, ceilMin: 120 };

test('pace control: a big surplus close to the reset wakes at the floor, and the closer the reset the shorter the interval', () => {
  const near = hourly('a', 20, 0.25, 24, NOW + 6 * HOUR);
  const control = paceControl(windowOf(near), near, NOW, BASE);
  assert.deepEqual(control, { projectedPct: 27.5, pace: 'under', wakeIntervalMin: 10, thinkingHint: 'raise' });

  const slow = (resetIn: number) => { const rows = hourly('a', 20, 0.5, 24, NOW + resetIn); return paceControl(windowOf(rows), rows, NOW, BASE)!; };
  const far = slow(4 * DAY), closer = slow(2 * DAY);
  assert.equal(far.pace, 'under');
  assert.ok(far.wakeIntervalMin < BASE.baseMin, `${far.wakeIntervalMin} is shorter than the default`);
  assert.ok(closer.wakeIntervalMin < far.wakeIntervalMin, `${closer.wakeIntervalMin} < ${far.wakeIntervalMin}`);
  assert.ok(closer.wakeIntervalMin >= BASE.floorMin);
});

test('pace control: a pace right at the limit keeps the default interval and the thinking level', () => {
  const rows = hourly('a', 20, 0.65);
  assert.deepEqual(paceControl(windowOf(rows), rows, NOW, BASE), { projectedPct: 98, pace: 'on', wakeIntervalMin: 30, thinkingHint: 'keep' });
});

test('pace control: an account about to blow the week wakes less often, up to the ceiling, and asks for less thinking', () => {
  const rows = hourly('a', 20, 1);
  const control = paceControl(windowOf(rows), rows, NOW, BASE);
  const ratio = (95 - 44) / 96 / 1;
  assert.deepEqual(control, { projectedPct: 140, pace: 'over', wakeIntervalMin: Math.round(30 / ratio), thinkingHint: 'lower' });
  assert.ok(control!.wakeIntervalMin > BASE.baseMin && control!.wakeIntervalMin < BASE.ceilMin);

  const spent = hourly('a', 100, 0);
  assert.deepEqual(paceControl(windowOf(spent), spent, NOW, BASE), { projectedPct: 100, pace: 'over', wakeIntervalMin: 120, thinkingHint: 'lower' });
  const crawling = hourly('a', 90, 0.1);
  assert.equal(paceControl(windowOf(crawling), crawling, NOW, BASE)!.wakeIntervalMin, Math.round(30 / ((95 - 92.4) / 96 / 0.1)));
});

test('pace control: floor and ceiling are configurable, the defaults are neutral, and no forecast means no control', () => {
  const surplus = hourly('a', 20, 0.25, 24, NOW + 6 * HOUR);
  assert.equal(paceControl(windowOf(surplus), surplus, NOW, { ...BASE, floorMin: 15 })!.wakeIntervalMin, 15);
  const blown = hourly('a', 20, 1);
  assert.equal(paceControl(windowOf(blown), blown, NOW, { ...BASE, ceilMin: 45 })!.wakeIntervalMin, 45);
  assert.deepEqual(PACE_DEFAULTS, { baseMin: 30, floorMin: 10, ceilMin: 120 });
  const flat = hourly('a', 20, 0, 24);
  assert.deepEqual(paceControl(windowOf(flat), flat, NOW), { projectedPct: 20, pace: 'under', wakeIntervalMin: 10, thinkingHint: 'raise' });
  assert.equal(paceControl(windowOf(blown), blown, NOW)!.wakeIntervalMin, 56, 'without a config the default base and ceiling apply');
  assert.equal(paceControl({}, [], NOW), undefined);
  assert.equal(paceControl({ w7d: { used: 20, resetAt: NOW - HOUR } }, hourly('a', 20, 1, 24, NOW - HOUR), NOW), undefined);
});

test('pace control: the live window from the cache is the latest reading, not the last row of the history', () => {
  const rows = hourly('a', 20, 0.25);
  const live = paceControl({ w7d: { used: 80, resetAt: RESET } }, rows, NOW, BASE)!;
  assert.equal(live.pace, 'over', '80% used already, with the recent rate carried forward');
  assert.equal(paceControl(windowOf(rows), rows, NOW, BASE)!.pace, 'under', 'the history alone says under');
});

const stateFor = (provider: string, used: number, resetAt = RESET) => ({ usageByProvider: { [provider]: { fetchedAt: NOW, secondary: { usedPercent: used, resetAt, windowSeconds: 604_800 } } } });
const pacing = { heartbeatPace: true, heartbeatPaceFloorMin: 10, heartbeatPaceCeilMin: 120 };

test('wake minutes: the base moves with the account\'s pace, and stays the base when there is nothing to forecast from', () => {
  const slow = hourly('acct', 20, 0.25, 24, NOW + 6 * HOUR), slowState = stateFor('acct', 26, NOW + 6 * HOUR);
  assert.equal(paceWakeMinutes(30, pacing, 'acct', slowState, slow, NOW), 10, 'surplus near the reset: the floor');
  const blown = hourly('acct', 20, 1);
  const longer = paceWakeMinutes(30, pacing, 'acct', stateFor('acct', 44), blown, NOW)!;
  assert.ok(longer > 30 && longer <= 120, String(longer));
  assert.equal(paceWakeMinutes(30, pacing, 'acct', stateFor('acct', 44), blown, NOW), Math.round(30 / ((95 - 44) / 96)));
  assert.equal(paceWakeMinutes(30, pacing, 'acct', {}, [], NOW), undefined, 'no cache, no history');
  assert.equal(paceWakeMinutes(30, pacing, 'other', slowState, slow, NOW), undefined, 'another account\'s rows say nothing about this one');
  assert.equal(paceWakeMinutes(30, pacing, 'acct', stateFor('acct', 26, NOW - HOUR), slow, NOW), undefined, 'a window that already ended');
  assert.equal(paceWakeMinutes(30, pacing, undefined, slowState, slow, NOW), undefined, 'no account known');
});

test('wake minutes: the switch turns it off, and the floor and ceiling come from the settings, clamped around the base', () => {
  const slow = hourly('acct', 20, 0.25, 24, NOW + 6 * HOUR), slowState = stateFor('acct', 26, NOW + 6 * HOUR);
  assert.equal(paceWakeMinutes(30, { ...pacing, heartbeatPace: false }, 'acct', slowState, slow, NOW), undefined);
  assert.equal(paceWakeMinutes(30, { ...pacing, heartbeatPaceFloorMin: 20 }, 'acct', slowState, slow, NOW), 20);
  assert.equal(paceWakeMinutes(5, pacing, 'acct', slowState, slow, NOW), 5, 'a base below the floor is never raised by a surplus');
  assert.equal(paceWakeMinutes(30, { ...pacing, heartbeatPaceCeilMin: 40 }, 'acct', stateFor('acct', 44), hourly('acct', 20, 1), NOW), 40);
});

test('wake minutes do not replace newer history with a stale cached reading', () => {
  const rows = hourly('acct', 20, 1);
  const stale = stateFor('acct', 20);
  stale.usageByProvider.acct.fetchedAt = NOW - DAY;
  assert.equal(paceWakeMinutes(30, pacing, 'acct', stale, rows, NOW), paceWakeMinutes(30, pacing, 'acct', stateFor('acct', 44), rows, NOW));
});
