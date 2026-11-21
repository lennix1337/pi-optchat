import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { abandonedCauses, branchEvidenceMessages, claimRetryText, evidenceText, uncheckedAdmissions, unbackedClaims, utcTimes } from '../src/claim-check.ts';

test('multiple hash claims normalize the evidence at most once', () => {
  const evidence = 'ABC1234 DEF5678 '.repeat(1000);
  const original = String.prototype.toLowerCase;
  let normalizations = 0;
  String.prototype.toLowerCase = function () {
    if (String(this) === evidence) normalizations++;
    return original.call(this);
  };
  try {
    assert.deepEqual(unbackedClaims('Commits abc1234 e def5678.', evidence), []);
    assert.equal(normalizations, 1);
  } finally { String.prototype.toLowerCase = original; }
});

test('a pass count no output showed is unbacked; the counts a test runner prints back it', () => {

  assert.deepEqual(unbackedClaims('Validado: API 31/31 e web 10/10.', ' Test Files  4 failed | 2 passed\n Tests  4 failed | 27 passed (31)\n Tests 10 passed (10)'), ['31/31']);
  assert.deepEqual(unbackedClaims('Os testes que citam o README passaram (105 de 105).', 'ℹ pass 105\nℹ fail 0'), []);
  assert.deepEqual(unbackedClaims('npm run verify: 164 de 164 testes.', 'ℹ tests 164\nℹ pass 164\nℹ fail 0'), []);
  assert.deepEqual(unbackedClaims('Checks 2/2 verdes.', 'checks passed 2/2, 0 failed'), []);
});

test('dates, versions and times are not pass counts', () => {
  assert.deepEqual(unbackedClaims('Os testes rodaram em 18/11 e a cota renova em 24/11 às 23:06; 05/10 foi o fork; versão 4.7.1 passou.', ''), []);
});

test('digits around "de" or "of" inside an ID are not a pass count', () => {

  const id = '43733b62-5de6-4f1a-9b2c-0d7de7261234';
  assert.deepEqual(unbackedClaims(`OK: [shell ${id}] failed · exit 3\nfail-out`, `Background shell ${id} started`), []);
  assert.deepEqual(unbackedClaims('Os testes passaram: 3de4 e 2of9 são nomes.', ''), []);
  assert.deepEqual(unbackedClaims('Testes: 5 de 6 passaram.', ''), ['5 de 6']);
});

test('a commit hash must appear in some output; plain words that look hex do not count', () => {
  assert.deepEqual(unbackedClaims('Mesclado como 1d3ae355, deploy de 8a77c8c0. A decade facade.', 'commit 1d3ae3558e849a16522d6dbc0cf885dbf0439b1c'), ['8a77c8c0']);
});

test('a merged PR needs an output saying it merged; "no ar" needs a health answer', () => {
  assert.deepEqual(unbackedClaims('O #190 foi mesclado e está no ar.', '#190 merged\nverify ok'), ['no ar']);
  assert.deepEqual(unbackedClaims('O #190 foi mesclado e está no ar.', 'PR #190 MERGED 0c9aebbf\napi 200 dentai.com.br 200'), []);
  assert.deepEqual(unbackedClaims('O #191 foi mesclado.', '#190 MERGED'), ['#191 mesclado']);
  assert.deepEqual(unbackedClaims('O deploy ainda não está no ar.', ''), []);
});

test('the evidence is what tools returned and what arrived, never the agent\'s own words', () => {
  const messages = [
    { role: 'user', content: '[gitwatch] #39 MERGED 748b6e87' },
    { role: 'assistant', content: [{ type: 'text', text: 'Tests 99/99' }] },
    { role: 'toolResult', content: [{ type: 'text', text: 'ℹ pass 21\nℹ fail 0' }] },
  ] as unknown as AgentMessage[];
  const evidence = evidenceText(messages);
  assert.ok(evidence.includes('#39 MERGED') && evidence.includes('pass 21') && !evidence.includes('99/99'));
  assert.deepEqual(unbackedClaims('#39 mesclado (748b6e87), testes 21/21, depois 99/99.', evidence), ['99/99']);
});

test('a denied merge is no claim, and a merge word names only the PR next to it', () => {
  assert.deepEqual(unbackedClaims('O PR #152 ainda não foi mesclado: o CI falhou.', ''), []);
  assert.deepEqual(unbackedClaims('O PR #186 está aberto e não vai ser mergeado.', ''), []);
  assert.deepEqual(unbackedClaims('Abri o PR #157 para o navegador, testado à parte; o #155 já estava mesclado.', '#155 MERGED'), []);
});

test('a gitwatch notice injected between runs backs the merge it reports', () => {

  const entries = [
    { type: 'custom_message', content: '[gitwatch] lennix1337/dotfiles · 05:19\n#167 merged af268f09\n  #167 MERGED af268f09 · checks pass 4✓' },
    { type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'O #168 foi mesclado.' }] } },
  ];
  const evidence = evidenceText(branchEvidenceMessages(entries as never));
  assert.deepEqual(unbackedClaims('O #167 foi mesclado (af268f0).', evidence), []);
  assert.deepEqual(unbackedClaims('O #168 foi mesclado.', evidence), ['#168 mesclado']);
});

test('"não confirmei" in the reply is an admission the run must check before sending (operator 18/11)', () => {
  assert.deepEqual(uncheckedAdmissions('Feito o PR. Não confirmei que ele começou de fato. Resto ok.'), ['Não confirmei que ele começou de fato.']);
  assert.deepEqual(uncheckedAdmissions('I did not verify the deploy.'), ['I did not verify the deploy.']);

  assert.deepEqual(uncheckedAdmissions('Não verificado: CI. Verifiquei o merge no GitHub.'), []);
  assert.match(claimRetryText([], ['Não confirmei X.']), /Não confirmei X\.[\s\S]*read-only tool/);

  assert.deepEqual(uncheckedAdmissions('Quando uma resposta diz "não confirmei" ou \u201cI did not verify\u201d, ela volta uma vez.'), []);
});

test('a reply that gives up on a cause goes back once to take one more step (operator 15/11)', () => {
  assert.deepEqual(abandonedCauses('Os stalls seguem; causa não encontrada. Fim.'), ['causa não encontrada.']);
  assert.equal(abandonedCauses('Stall cause not found.').length, 1);
  assert.deepEqual(abandonedCauses('A causa foi encontrada no carregamento.'), []);
  assert.deepEqual(abandonedCauses('O detector procura "causa não encontrada" no texto.'), []);
  assert.match(claimRetryText([], [], ['Causa não encontrada.']), /gives up on a cause[\s\S]*one more cheap step/);
});

test('a reply with a UTC clock time goes back once to be written in Brasília time (operator rule, UTC-3)', () => {
  assert.deepEqual(utcTimes('O deploy terminou às 12:43Z.'), ['O deploy terminou às 12:43Z.']);
  assert.equal(utcTimes('Rodou 09:30:15.123Z e depois parou.').length, 1);
  assert.deepEqual(utcTimes('O deploy terminou às 09:43.'), []);
  assert.deepEqual(utcTimes('O radar usa o formato "12:43Z" no título.'), []);
  assert.match(claimRetryText([], [], [], ['Às 12:43Z.']), /time in UTC[\s\S]*Brasília time/);
});
