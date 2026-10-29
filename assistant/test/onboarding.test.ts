import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryView, markdownFactSource } from '../src/memory/projection.ts';
import { Onboarding } from '../src/setup.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-onboarding-'));
  const about = join(dir, 'ABOUT-ME.md');
  writeFileSync(about, '# Sobre\n- Trabalho na DentAI.\n- Prefiro respostas em portugu\ês.\n');
  const authority = {};
  const view = new MemoryView({ databasePath: join(dir, 'memory.sqlite'), profileId: 'p', operatorAuthority: authority, sources: [markdownFactSource({ path: about, sourceId: 'about', profileId: 'p', author: 'operator' })] });
  return { dir, view, authority, close: () => { view.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('the introduction states only known facts, each with its source, date and author', () => {
  const f = fixture();
  try {
    const onboarding = new Onboarding(f.view);
    const intro = onboarding.introduce([{ sourceId: 'about', ref: 'ABOUT-ME.md#L2' }, { sourceId: 'about', ref: 'ABOUT-ME.md#L3' }, { sourceId: 'about', ref: 'ABOUT-ME.md#L9' }]);
    assert.deepEqual(intro.known.map(item => item.text), ['Trabalho na DentAI.', 'Prefiro respostas em portugu\ês.']);
    for (const item of intro.known) { assert.equal(item.source, 'about:' + item.ref); assert.equal(item.author, 'operator'); assert.ok(Date.parse(item.observedAt)); }
    assert.deepEqual(intro.unknown, ['about:ABOUT-ME.md#L9'], 'a missing fact is reported as unknown, not invented');
  } finally { f.close(); }
});

test('"Est\á certo" writes nothing; "Corrigir" records an operator correction bound to the original', () => {
  const f = fixture();
  try {
    const onboarding = new Onboarding(f.view);
    const [item] = onboarding.introduce([{ sourceId: 'about', ref: 'ABOUT-ME.md#L2' }]).known;
    onboarding.confirm(item);
    assert.equal(f.view.read('about', item.ref).corrections.length, 0);
    onboarding.correct(item, 'Trabalho na DentAI e no GeneXus18MCP.', 'faltava o segundo projeto', f.authority);
    const entry = f.view.read('about', item.ref);
    assert.equal(entry.current.text, 'Trabalho na DentAI e no GeneXus18MCP.');
    assert.equal(entry.original.text, 'Trabalho na DentAI.', 'original preserved');
    assert.equal(entry.corrections[0].reason, 'faltava o segundo projeto');
    assert.throws(() => onboarding.correct(item, 'x', 'y', {}), /unauthorized/, 'only the operator authority corrects');
    const after = onboarding.introduce([{ sourceId: 'about', ref: 'ABOUT-ME.md#L2' }]).known[0];
    assert.equal(after.text, 'Trabalho na DentAI e no GeneXus18MCP.'); assert.equal(after.corrected, true);
  } finally { f.close(); }
});
