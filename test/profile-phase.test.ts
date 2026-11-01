import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profilePhase, type ProfileFacts } from '../src/profile-phase.ts';

const facts = (over: Partial<ProfileFacts> = {}): ProfileFacts => ({ active: true, remote: false, stopping: false, importing: false, importPending: () => false, ...over });

test('a profile is open only when nothing else holds it', () => {
  assert.equal(profilePhase(facts()), 'open');
  assert.equal(profilePhase(facts({ active: false })), 'none');
  assert.equal(profilePhase(facts({ remote: true })), 'remote');
  assert.equal(profilePhase(facts({ stopping: true })), 'closing');
  assert.equal(profilePhase(facts({ importing: true })), 'importing');
  assert.equal(profilePhase(facts({ importPending: () => true })), 'import-paused');
});

test('the first fact that holds names the phase, and the import journal is read only when nothing earlier decided', () => {
  let reads = 0;
  const journal = () => { reads++; return true; };
  assert.equal(profilePhase(facts({ active: false, remote: true, stopping: true, importing: true, importPending: journal })), 'none');
  assert.equal(profilePhase(facts({ remote: true, stopping: true, importing: true, importPending: journal })), 'remote');
  assert.equal(profilePhase(facts({ stopping: true, importing: true, importPending: journal })), 'importing');
  assert.equal(profilePhase(facts({ stopping: true, importPending: journal })), 'closing');
  assert.equal(reads, 0);
  assert.equal(profilePhase(facts({ importPending: journal })), 'import-paused');
  assert.equal(reads, 1);
});
