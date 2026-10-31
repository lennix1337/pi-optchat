import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORRECTION_NOTICE, CORRECTIONS, correctionsWeek, isCorrection, operatorText, recordCorrection, registerCorrections } from '../src/corrections.ts';
import { hookedPi, plainToolResult, withTempDir } from './support.ts';

const DAY = 86_400_000;

test('correction cues match the operator chasing a mistake, not an ordinary request', () => {
  for (const t of ['já falei pra não pushar', 'Não era isso que eu pedi', 'você errou o caminho', 'tá errado esse horário', 'eu disse pra usar UTC-3',
    'para de reiniciar o serviço', 'não faz isso de novo', 'mergeou sem eu pedir', 'that\'s wrong', 'I told you not to', 'stop restarting it'])
    assert.ok(isCorrection(t), t);
  for (const t of ['faz o merge do 39', 'pode mergear', 'para deploy amanhã', 'o erro está no build', 'novo PR para o placar', 'e aí?', 'status?', 'separa de verdade os slots'])
    assert.ok(!isCorrection(t), t);
});

test('only the operator\'s own words count: TUI input and [Slack] messages, not wakes or reports', () => {
  assert.deepEqual(operatorText('já falei', 'interactive'), { text: 'já falei', origin: 'tui' });
  assert.deepEqual(operatorText('[Slack #dentai] não era isso', 'extension'), { text: 'não era isso', origin: 'slack' });
  assert.equal(operatorText('[gitwatch] já falei', 'extension'), undefined);
  assert.equal(operatorText('[Slackbot] não era isso', 'extension'), undefined);
});

test('a correction is logged without its text and reminds the run once, on its next tool result', () => withTempDir('corrections-', dir => {
  const { pi, fire } = hookedPi();
  let now = 1_000;
  registerCorrections(pi, () => ({ dir }), () => now);
  const result = () => plainToolResult(fire);

  fire('input', { text: 'faz o merge do 39', source: 'interactive' });
  assert.equal(result(), undefined, 'an ordinary request adds nothing');
  fire('input', { text: '[gitwatch] stop doing that', source: 'extension' });
  assert.equal(result(), undefined, 'a wake is not the operator');

  fire('input', { text: '[Slack] já falei que o segredo 123 não vai pro log', source: 'extension' });
  assert.equal(result()?.content.at(-1)?.text, `\n${CORRECTION_NOTICE}`);
  assert.equal(result(), undefined, 'one reminder per correction');
  assert.ok(!readFileSync(join(dir, CORRECTIONS), 'utf8').includes('segredo'), 'the text is never stored');

  now = 2_000;
  fire('input', { text: 'não era isso', source: 'interactive' });
  assert.deepEqual(correctionsWeek(dir, 0), { count: 2, recordingSince: 1_000 });
  assert.deepEqual(correctionsWeek(dir, 1_500), { count: 1, recordingSince: 1_000 });
}));

test('nothing ever logged is unmeasured; a quiet week after a record is a measured zero', () => withTempDir('corrections-', dir => {
  assert.deepEqual(correctionsWeek(dir, 0), { count: 0 });
  recordCorrection(dir, 'tui', DAY);
  assert.deepEqual(correctionsWeek(dir, 10 * DAY), { count: 0, recordingSince: DAY });
}));

test('a correction belongs to the profile open when it arrived: none before it opens, none after it closes', () => withTempDir('corrections-', dir => {
  const { pi, fire } = hookedPi();
  let open = false;
  registerCorrections(pi, () => open ? { dir } : undefined);
  const result = () => plainToolResult(fire);
  fire('input', { text: 'já falei', source: 'interactive' });
  open = true;
  assert.equal(result(), undefined, 'said before the profile opened');
  assert.deepEqual(correctionsWeek(dir, 0), { count: 0 });
  fire('input', { text: 'já falei', source: 'interactive' });
  open = false;
  assert.equal(result(), undefined, 'the profile closed before the reminder');
  open = true;
  assert.equal(result(), undefined, 'a closed profile dropped the pending reminder');
}));
