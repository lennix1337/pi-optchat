import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGY_ADVISOR, advisorLine, councilReport, agyAnswer, askAdvisor, debatePrompt, debateTurns, decisionChanged, offersModel, pickAdvisor } from '../src/council.ts';

const now = Date.parse('2026-11-19T03:00:00Z');
const later = now + 86_400_000;
const state = (usage: Record<string, number>, cooldowns: Record<string, number> = {}) => ({
  usageByProvider: Object.fromEntries(Object.entries(usage).map(([id, used]) => [id, { primary: { usedPercent: used, resetAt: later } }])),
  exhaustedUntilByProvider: cooldowns,
});

test('council background comes only from profile configuration', () => {
  assert.doesNotMatch(debatePrompt('candidate', [], 'critic'), /DentAI/);
  assert.match(debatePrompt('candidate', [], 'critic', 'fixture background'), /fixture background/);
});

test('the advisor is the least used Codex account, never Claude itself', () => {
  const pick = pickAdvisor(state({ 'anthropic-account-2': 2, 'openai-codex': 30, 'openai-codex-account-2': 5 }), now);
  assert.deepEqual(pick, { account: 'openai-codex-account-2', model: 'openai-codex-account-2/gpt-6.2-sol', used: 5 });
});

test('only an account whose models.json lists the advisor model advises', () => {
  const offers = offersModel(JSON.stringify({ providers: { 'openai-codex-account-2': { models: [{ id: 'gpt-6.2-sol' }] }, 'openai-codex': { models: [{ id: 'gpt-6.1-terra' }] } } }));
  assert.equal(pickAdvisor(state({ 'openai-codex': 0, 'openai-codex-account-2': 40 }), now, offers)?.account, 'openai-codex-account-2');
  assert.equal(pickAdvisor(state({ 'openai-codex': 0 }), now, offers), undefined);
  assert.equal(pickAdvisor(state({ 'openai-codex': 0 }), now, offersModel('not json')), undefined);
});

test('a blocked or exhausted account never advises; none left means no council', () => {
  assert.equal(pickAdvisor(state({ 'openai-codex': 100 }), now), undefined);
  assert.equal(pickAdvisor(state({ 'openai-codex': 1 }, { 'openai-codex': later }), now), undefined);
  assert.equal(pickAdvisor(state({ 'anthropic-account-2': 0 }), now), undefined);
  assert.equal(pickAdvisor({}, now), undefined);
});

test('the prompt carries the candidates and asks for an objection, in Portuguese', () => {
  const prompt = debatePrompt('1. radar quieto (4/5)\n2. funil usdentai (5/5)', [], 'critic');
  assert.match(prompt, /funil usdentai/);
  assert.match(prompt, /objeção/);
  assert.match(prompt, /português/i);
});

test('every post names who spoke', () => {
  assert.equal(advisorLine({ account: 'openai-codex', model: 'openai-codex/gpt-6.1-terra', used: 0 }, 'Fico com o 2.'),
    '🤖 *gpt-6.1-terra · openai-codex* (conselheiro): Fico com o 2.');
});

test('the advisor run closes stdin, so a print run that reads it does not hang until the timeout', async () => {

  const fake = ['-e', "process.stdin.resume(); process.stdin.on('end', () => console.log('escolho o 2'))"];
  const answer = await askAdvisor(fake, { command: process.execPath, timeoutMs: 5_000 });
  assert.deepEqual(answer, { text: 'escolho o 2' });
});

test('an advisor that times out says so, without echoing the prompt back', async () => {
  const answer = await askAdvisor(['-e', 'setTimeout(() => {}, 10_000)', 'PROMPT LONGO'], { command: process.execPath, timeoutMs: 300 });
  assert.match(answer.error ?? '', /sem resposta em 0\.3 s/);
  assert.doesNotMatch(answer.error ?? '', /PROMPT LONGO/);
});

test('the agy advisor answer is the text agy-worker printed, without pc-task and agy-worker framing', () => {
  const out = 'started PiTask-agy-council at 2026-11-19T12:43:00Z\nFetching available models...\nagy-worker: conversation 52a0 (continue with --resume 52a0)\nFico com o 2.\nObjeção: custo.\n\n\n(agy model: gemini-4-neon-high; quota left: 100%)\n\nrc=0 after 0.5 min; full log C:\\x\\out.log\n';
  assert.equal(agyAnswer(out), 'Fico com o 2.\nObjeção: custo.');
  assert.equal(agyAnswer('started PiTask-x\nagy-worker: model not offered\nrc=2 after 0.1 min'), undefined);
  assert.equal(advisorLine(AGY_ADVISOR, 'Fico com o 1.'), '🤖 *gemini-4-neon-high · agy* (conselheiro): Fico com o 1.');
});

test('the council is a debate of at most 5 messages: proposal, critic, second critic, rebuttal, decision', () => {
  const sol = { account: 'openai-codex-account-2', model: 'openai-codex-account-2/gpt-6.2-sol', used: 1 };
  assert.deepEqual(debateTurns([sol, AGY_ADVISOR]).map(t => [t.advisor.account, t.role]),
    [['openai-codex-account-2', 'critic'], ['agy', 'second'], ['openai-codex-account-2', 'rebuttal']]);
  assert.equal(1 + debateTurns([sol, AGY_ADVISOR]).length + 1, 5);
  assert.deepEqual(debateTurns([AGY_ADVISOR]).map(t => t.role), ['critic']);
  assert.deepEqual(debateTurns([]), []);
});

test('each debate turn is told to disagree, not to approve the best score', () => {
  const cands = '1. guarda (5/5)\n2. funil (3/5)\nInclino para 1.';
  const critic = debatePrompt(cands, [], 'critic');
  assert.match(critic, /Inclino para 1/);
  assert.match(critic, /não concorde por padrão/i);
  assert.match(critic, /fora da lista/);
  const second = debatePrompt(cands, ['🤖 sol: fico com o 2'], 'second');
  assert.match(second, /sol: fico com o 2/);
  assert.match(second, /discorde/i);
  assert.match(second, /não repita/i);
  const rebuttal = debatePrompt(cands, ['🤖 sol: 2', '🤖 neon: 3'], 'rebuttal');
  assert.match(rebuttal, /concede/);
  assert.match(rebuttal, /mantém/);
});

test('the decision records whether the debate changed the leaning', () => {
  assert.equal(decisionChanged('Decido 2. Mudou: sim, o neon mostrou que 1 já existe.'), true);
  assert.equal(decisionChanged('Decido 1. mudou: não; a objeção do sol não se sustenta.'), false);
  assert.equal(decisionChanged('Decido 1.'), undefined);
});

test('configured council context is passed to every role', () => {
  for (const role of ['critic', 'second', 'rebuttal'] as const) {
    const prompt = debatePrompt('1. placar (4/5)\nInclino para 1.', [], role, 'fixture: challenge assumptions');
    assert.match(prompt, /fixture: challenge assumptions/);
  }
});

test('the council report prints each advisor answer in full on its own lines, then the thread ts to reply on', () => {
  const long = 'Objeção: ' + 'x'.repeat(900);
  const sol = { account: 'openai-codex-account-2', model: 'openai-codex-account-2/gpt-6.2-sol', used: 1 };
  const report = councilReport('1795.22', 'wakes', [
    { advisor: sol, role: 'critic', answer: long },
    { advisor: AGY_ADVISOR, role: 'second', answer: undefined, error: 'sem resposta em 300 s' },
  ]);
  assert.ok(report.split('\n').every(l => l.length <= 1000));
  assert.match(report, new RegExp(`critic · gpt-6.2-sol: Objeção: x{900}`));
  assert.match(report, /second · gemini-4-neon-high: não respondeu: sem resposta em 300 s/);
  assert.match(report.split('\n').at(-1)!, /--reply 1795\.22/);
});
