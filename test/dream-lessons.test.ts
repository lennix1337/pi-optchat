import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DayFrozenLessons, localDay, morningSummary } from '../src/dream-lessons.ts';

const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

test('active lessons are read once per local day, so the system prompt does not change mid-day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dreams-'));
  const file = join(dir, 'active-lessons.md');
  writeFileSync(file, '<!-- dream 2026-10-28 -->\n- Ask before merging DentAI. Why: per-PR OK. [#71189]\n');
  const lessons = new DayFrozenLessons(() => dir);
  const morning = lessons.get(at(28, 9));
  assert.match(morning, /^## Active lessons \(from the nightly dream\)\n/);
  assert.match(morning, /grants no permission/);
  assert.match(morning, /- Ask before merging DentAI\. Why: per-PR OK\. \[#71189\]$/);
  assert.doesNotMatch(morning, /<!--/);
  writeFileSync(file, '- A new lesson. [#1]\n');
  assert.equal(lessons.get(at(28, 23, 59)), morning, 'frozen until the day changes');
  assert.match(lessons.get(at(29, 0, 1)), /A new lesson/);
  rmSync(dir, { recursive: true, force: true });
});

test('no file, an empty file or one over 2 KB adds nothing to the prompt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dreams-'));
  assert.equal(new DayFrozenLessons(() => dir).get(at(28, 9)), '');
  writeFileSync(join(dir, 'active-lessons.md'), `- ${'x'.repeat(2100)} [#1]`);
  assert.equal(new DayFrozenLessons(() => dir).get(at(28, 9)), '', 'an oversized file is refused, not cut');
  rmSync(dir, { recursive: true, force: true });
});

test('the dream summary is three lines, shown once, and only from the morning hour on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dreams-'));
  const day = localDay(at(28, 9));
  mkdirSync(join(dir, day));
  writeFileSync(join(dir, day, 'run.json'), JSON.stringify({ day, outcome: 'dreamed', simulate: true, activated: false, from: 71000, to: 71792,
    citations: { bullets: 9, uncited: [], invalid: [{ line: 4, id: 9 }] } }));
  writeFileSync(join(dir, day, 'DREAM.md'), '## Active lessons\n- One. [#71001]\n- Two. [#71002]\n## Skill and playbook proposals\nNone.\n## Decisions in force\n- D. [#71003]\n## Open items\n- O. [#71004]\n## Scoreboard\n- None found. [#71792]\n');
  assert.equal(morningSummary(at(28, 6, 59), { dir }), undefined, 'not before 07:00');
  const summary = morningSummary(at(28, 7, 5), { dir })!;
  const lines = summary.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Dream 2026-10-28 \(messages 71000-71792\): dreamed; 2 lessons \(simulation, not active\); 1 citation problems\.$/);
  assert.match(lines[1], /^Scoreboard: 0 findings; open items: 1; proposals: 0\.$/);
  assert.equal(lines[2], `Full dream: ${join(dir, day, 'DREAM.md')}`);
  assert.equal(morningSummary(at(28, 8), { dir }), undefined, 'shown once per day');
  assert.equal(JSON.parse(readFileSync(join(dir, 'briefed.json'), 'utf8')).day, day);
  assert.equal(morningSummary(at(29, 9), { dir }), undefined, 'no dream for that day');
  rmSync(dir, { recursive: true, force: true });
});
