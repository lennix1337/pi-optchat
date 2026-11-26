import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge, parseProbe } from '../scripts/pc-github-probe.mjs';

test('parseProbe reads TCP lines of the remote output', () => {
  assert.deepEqual(parseProbe('TCP github 140.82.112.3 False\nTCP control google.com True\nnoise'), [
    { group: 'github', host: '140.82.112.3', ok: false },
    { group: 'control', host: 'google.com', ok: true },
  ]);
});

test('judge blames the PC route to GitHub when only the controls answer', () => {
  const v = judge(parseProbe('TCP github a False\nTCP github b False\nTCP control google.com True'));
  assert.equal(v.code, 'github-unreachable');
  assert.equal(v.exit, 1);
});

test('judge is ok when GitHub answers, partial when only some does', () => {
  assert.equal(judge(parseProbe('TCP github a True\nTCP control c True')).code, 'ok');
  assert.equal(judge(parseProbe('TCP github a True\nTCP github b False\nTCP control c True')).code, 'github-partial');
});

test('judge does not blame GitHub when the controls fail too or nothing was read', () => {
  assert.equal(judge(parseProbe('TCP github a False\nTCP control c False')).code, 'pc-offline');
  assert.equal(judge([]).code, 'no-data');
});
