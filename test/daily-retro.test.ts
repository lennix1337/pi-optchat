import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { judgeSelfEdit, selfEditViolations } from '../src/autonomy-self-edit.ts';
import { parseContract } from '../src/autonomy.ts';
import { markRetro, retroDue, retroPrompt } from '../src/daily-retro.ts';

const at = (hh: number, mm = 0, day = 3) => new Date(2026, 10, day, hh, mm).getTime();

test('the daily retro is due once a day, after its time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'retro-'));
  assert.equal(retroDue(dir, at(21, 59), '22:00'), false);
  assert.equal(retroDue(dir, at(22, 0), '22:00'), true);
  markRetro(dir, at(22, 1));
  assert.equal(retroDue(dir, at(23, 30), '22:00'), false);
  assert.equal(retroDue(dir, at(22, 5, 4), '22:00'), true);
  assert.match(retroPrompt('2026-11-03'), /retro/);
});

const contract = {
  version: 1, default: 'advisor', rules: [
    { action: 'deploy', scope: ['*'], level: 'ask' },
    { action: 'recursive-delete', scope: ['*/dist'], level: 'free' },
    { action: 'recursive-delete', scope: ['*'], level: 'ask' },
  ],
};

test('self-edits may change unprotected rules but never the operator\'s protected ones or the default', () => {
  const before = parseContract(contract);
  const add = parseContract({ ...contract, rules: [contract.rules[0], { action: 'discard', scope: ['candidate/*'], level: 'free' }, ...contract.rules.slice(1)] });
  assert.deepEqual(selfEditViolations(before, add), []);
  const loosen = parseContract({ ...contract, rules: [{ action: 'deploy', scope: ['*'], level: 'free' }, ...contract.rules.slice(1)] });
  assert.equal(selfEditViolations(before, loosen).length, 1);
  const shadow = parseContract({ ...contract, rules: [{ action: 'deploy', scope: ['x/*'], level: 'free' }, ...contract.rules] });
  assert.equal(selfEditViolations(before, shadow).length, 1);
  const wildcard = parseContract({ ...contract, rules: [{ action: '*', scope: ['*'], level: 'free' }, ...contract.rules] });
  assert.equal(selfEditViolations(before, wildcard).length, 1);
  assert.equal(selfEditViolations(before, parseContract({ ...contract, default: 'free' })).length, 1);
});

test('an edit of the profile autonomy.json runs by itself only when the result is safe and exact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-edit-'));
  const file = join(dir, 'autonomy.json');
  writeFileSync(file, JSON.stringify(contract, null, 2));
  const text = readFileSync(file, 'utf8');
  const old = '"scope": [\n        "*/dist"\n      ]';
  assert.ok(text.includes(old));
  const ok = judgeSelfEdit(dir, { tool: 'edit', input: { path: file, edits: [{ oldText: old, newText: '"scope": [\n        "*/dist",\n        "*/build"\n      ]' }] } });
  assert.equal(ok?.ok, true);
  const bad = judgeSelfEdit(dir, { tool: 'write', input: { path: file, content: JSON.stringify({ ...contract, rules: contract.rules.slice(1) }) } });
  assert.equal(bad?.ok, false);
  assert.equal(judgeSelfEdit(dir, { tool: 'write', input: { path: file, content: '{' } })?.ok, false);
  assert.equal(judgeSelfEdit(dir, { tool: 'edit', input: { path: file, edits: [{ oldText: 'nope', newText: 'x' }] } })?.ok, false);
  assert.equal(judgeSelfEdit(dir, { tool: 'bash', input: { command: `echo {} > ${file}` } }), undefined);
  assert.equal(judgeSelfEdit(dir, { tool: 'write', input: { path: join(dir, 'other', 'autonomy.json'), content: '{}' } })?.ok, false);
  assert.equal(judgeSelfEdit(dir, { tool: 'write', input: { path: join(dir, 'autonomy.json.md'), content: '{}' } }), undefined);
});

// 03/11 retro: mirroring the profile into dotfiles (payload/pi/.../autonomy.json) waited for the operator, though the
// copy was byte-for-byte the live contract. A copy is judged against the live file: it may not loosen what is his.
test('a copy of autonomy.json elsewhere runs by itself when its protected rules match the live contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-edit-'));
  writeFileSync(join(dir, 'autonomy.json'), JSON.stringify(contract, null, 2));
  const mirror = join(mkdtempSync(join(tmpdir(), 'dotfiles-')), 'payload', 'autonomy.json');
  const same = judgeSelfEdit(dir, { tool: 'write', input: { path: mirror, content: JSON.stringify(contract, null, 2) } });
  assert.equal(same?.ok, true);
  assert.match(same?.ok ? same.summary : '', /copy/);
  const loosened = { ...contract, rules: [{ action: 'deploy', scope: ['*'], level: 'free' }, ...contract.rules.slice(1)] };
  assert.equal(judgeSelfEdit(dir, { tool: 'write', input: { path: mirror, content: JSON.stringify(loosened) } })?.ok, false);
  writeFileSync(join(dirname(mirror), '..', 'autonomy.json'), JSON.stringify(contract, null, 2));
  const edited = judgeSelfEdit(dir, { tool: 'edit', input: { path: join(dirname(mirror), '..', 'autonomy.json'), edits: [{ oldText: '"*/dist"', newText: '"*/dist",\n        "*/dist/*"' }] } });
  assert.equal(edited?.ok, true);
});
