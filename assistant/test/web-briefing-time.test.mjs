import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAt } from '../web/src/time.js';

test('briefing read time is shown in the briefing time zone, not as a UTC stamp', () => {
  assert.equal(readAt('2026-10-29T10:00:21.234Z', 'America/Sao_Paulo'), '29/10/2026 07:00');
  assert.equal(readAt('2026-10-29T10:00:21.234Z', 'Asia/Tokyo'), '29/10/2026 19:00');
});

test('an unknown time zone keeps the original stamp instead of guessing', () => {
  assert.equal(readAt('2026-10-29T10:00:21.234Z', 'Not/AZone'), '2026-10-29T10:00:21.234Z');
});
