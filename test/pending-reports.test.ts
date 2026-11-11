import './support.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeReports, REPORT_IN_FLIGHT_MS, reportsBlockReload, type PendingReport } from '../src/pending-reports.ts';

const now = 1_000_000_000;
const never = () => false;

test('reports held for quota or long unlogged do not block a reload', () => {
  const held: PendingReport = { text: '[51c7c3cb] worker result', sentAt: now - 1000 };
  const stale: PendingReport = { text: '[shell abc] alert: Error', sentAt: now - REPORT_IN_FLIGHT_MS - 1 };
  const unsent: PendingReport = { text: '[machine] Memory 87% in use' };
  assert.equal(reportsBlockReload([held, stale, unsent], now, r => r === held), undefined);
});

test('a report sent moments ago blocks the reload and is named', () => {
  const fresh: PendingReport = { text: '[f2079b44] **Resumo:** relatórios retidos\nsegunda linha', sentAt: now - 1000 };
  const stale: PendingReport = { text: 'old', sentAt: now - REPORT_IN_FLIGHT_MS - 1 };
  const reason = reportsBlockReload([fresh, stale], now, never);
  assert.match(reason ?? '', /^1 report\(s\) still being delivered: "\[f2079b44\] \*\*Resumo:\*\* relatórios retidos"\./);
  assert.match(reason ?? '', /1 other journaled report\(s\) are redelivered after the reload/);
  assert.doesNotMatch(reason ?? '', /segunda linha/);
});

test('a report a wake waits on blocks the reload unless it is held', () => {
  const awaiting: PendingReport = { text: 'wake worker', awaitingProcessing: true };
  const recovery: PendingReport = { text: 'recovery', workerRecovery: true };
  assert.ok(reportsBlockReload([awaiting], now, never));
  assert.ok(reportsBlockReload([recovery], now, never));
  assert.equal(reportsBlockReload([awaiting], now, () => true), undefined);
});

test('describeReports cuts long lines and counts the rest', () => {
  const reports = Array.from({ length: 7 }, (_, i) => ({ text: `${i}`.repeat(100) }));
  const text = describeReports(reports);
  assert.match(text, /\+2 more$/);
  assert.equal(text.split('; ').length, 6);
  assert.ok(text.split('; ')[0].length <= 82);
});
