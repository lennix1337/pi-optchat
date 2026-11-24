import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { retroPrompt } from '../src/daily-retro.ts';
import { appendExecLog, type ExecEntry } from '../src/exec-log.ts';
import { analyzeToolForge, proposeSkills } from '../src/tool-forge.ts';

const now = Date.parse('2026-11-22T22:00:00Z');
const row = (day: number, run: string, extra: Partial<ExecEntry> = {}): ExecEntry => ({
  at: new Date(now - day * 86_400_000).toISOString(), source: 'tool', name: 'bash',
  target: `git diff src/file${day}.ts | wc -l`, class: 'ok', run, ...extra,
});

function validateDraft(text: string): boolean {
  return /^---\nname: [a-z0-9-]+\ndescription: .+\n---\n/m.test(text)
    && /description: .*Use when /i.test(text)
    && ['When to use', 'Inputs', 'Steps', 'Validation', 'What needs approval', 'Return']
      .every(section => text.includes(`## ${section}\n`));
}

test('proposes a draft only for three distinct successful runs in seven days', () => {
  const repeated = [row(1, 'a'), row(2, 'b'), row(3, 'c')];
  const proposals = proposeSkills(repeated, { now });
  assert.equal(proposals.length, 1);
  assert.ok(validateDraft(proposals[0].draft));
  assert.match(proposals[0].draft, /git diff <path> \| wc -l/);
  assert.deepEqual(proposeSkills([row(1, 'a')], { now }), []);
  assert.deepEqual(proposeSkills([row(1, 'a'), row(2, 'a'), row(3, 'a')], { now }), []);
  assert.deepEqual(proposeSkills([row(1, 'a'), row(2, 'b'), row(3, 'c', { class: 'error' })], { now }), []);
  assert.deepEqual(proposeSkills([row(1, 'a'), row(2, 'b'), row(8, 'c')], { now }), []);
  assert.deepEqual(proposeSkills([row(1, 'a'), row(2, 'b'), row(-1, 'c')], { now }), []);
});

test('the real forge analysis feeds the dry-run draft into the daily retro', () => {
  const dir = mkdtempSync(join(process.cwd(), '.skill-proposal-test-'));
  try {
    for (const entry of [row(1, 'a'), row(2, 'b'), row(3, 'c')]) appendExecLog(dir, entry);
    const forge = analyzeToolForge(dir, { now, toolDir: join(dir, 'absent') });
    assert.equal(forge.skillProposals.length, 1);
    const prompt = retroPrompt('2026-11-22', [], forge);
    assert.ok(prompt.includes(forge.skillProposals[0].draft));
    assert.match(prompt, /dry.run/i);
    assert.match(prompt, /no automatic merge/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
