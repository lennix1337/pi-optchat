import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { registerSlackBridge, SlackBridge } from '../src/slack-bridge.ts';
import { isNudge, recordAnswer, recordInbound, SLACK_METRICS, slackWeek } from '../src/slack-metrics.ts';
import { composeScoreboard, WeeklyScoreboard, weekInputs } from '../src/scoreboard.ts';
import { withTempDir } from './support.ts';

const MIN = 60_000, DAY = 86_400_000;
const withDir = (run: (dir: string) => void | Promise<void>) => () => withTempDir('scoreboard-', run);
/** Monday 2026-11-02 10:00 local time. */
const monday = new Date(2026, 10, 2, 10, 0).getTime();

test('"e aí" style chasing is a nudge; a real request is not', () => {
  for (const t of ['e aí?', 'E ai, como foi', 'cadê o PR', 'como tá o deploy?', 'alguma novidade?', 'status?', 'novidades']) assert.ok(isNudge(t), t);
  for (const t of ['estado do banco', 'faz o merge do 39', 'como fazer o deploy amanhã? preciso que você prepare tudo, rode os testes e me mande o link do PR', 'statusbar quebrou']) assert.ok(!isNudge(t), t);
});

test('first-response time pairs each message with the first answer in its channel; text is never stored', withDir(dir => {
  const t0 = monday - DAY;
  recordInbound(dir, null, 'e aí?', t0);
  recordInbound(dir, null, 'segredo do cliente 123', t0 + MIN);
  recordInbound(dir, 'dentai', 'olha o deploy', t0 + 2 * MIN);
  recordAnswer(dir, 'harness', t0 + 3 * MIN); // another channel answers nobody here
  recordAnswer(dir, null, t0 + 5 * MIN);
  recordAnswer(dir, null, t0 + 9 * MIN); // a second answer is not a first response
  assert.ok(!readFileSync(join(dir, SLACK_METRICS), 'utf8').includes('segredo'));
  assert.deepEqual(slackWeek(dir, t0 - 1), { received: 3, answered: 2, waiting: 1, nudges: 1, medianMs: 4 * MIN, worstMs: 5 * MIN, recordingSince: t0 });
  assert.deepEqual(slackWeek(dir, t0 + 10 * MIN), { received: 0, answered: 0, waiting: 0, nudges: 0, recordingSince: t0 }, 'a quiet week is a measured zero');
  assert.equal(slackWeek(join(dir, 'none'), 0).recordingSince, undefined, 'nothing ever recorded is unmeasured');
}));

test('the bridge records a DM on arrival and the answer only when Slack accepted it', withDir(async dir => {
  let now = monday, fail = false;
  const bridge = new SlackBridge({ sendUserMessage: () => {} } as never, () => ({ dir, name: 'p' }), {
    now: () => now,
    request: async (_o, path) => {
      if (path.startsWith('/v1/slack/inbox')) return { messages: [{ seq: 1, ts: '1.0', thread: null, text: 'e aí?' }] };
      if (fail) throw new Error('down');
      return { parts: 1, ts: '2.0' };
    },
  });
  await bridge.poll();
  bridge.sawUserMessage('[Slack] e aí?');
  fail = true; now += 2 * MIN;
  await bridge.runEnded([{ role: 'assistant', content: [{ type: 'text', text: 'feito' }] } as unknown as AgentMessage]);
  assert.deepEqual(slackWeek(dir, monday - 1), { received: 1, answered: 0, waiting: 1, nudges: 1, recordingSince: monday }, 'a failed reply is not an answer');
  await bridge.poll(); // the cursor keeps the message from counting twice
  bridge.sawUserMessage('[Slack] e aí?');
  fail = false; now += MIN;
  await bridge.runEnded([{ role: 'assistant', content: [{ type: 'text', text: 'feito' }] } as unknown as AgentMessage]);
  assert.deepEqual(slackWeek(dir, monday - 1), { received: 1, answered: 1, waiting: 0, nudges: 1, medianMs: 3 * MIN, worstMs: 3 * MIN, recordingSince: monday });
}));

test('a slack_send the operator received answers his message in that channel; a failed one does not', withDir(async dir => {
  const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<unknown> }>();
  let fail = true;
  const pi = { on: () => {}, sendUserMessage: () => {}, registerTool: (tool: { name: string; execute: (id: string, params: unknown) => Promise<unknown> }) => { tools.set(tool.name, tool); } };
  registerSlackBridge(pi as never, () => ({ dir, name: 'p' }), () => {}, { request: async () => { if (fail) throw new Error('down'); return { parts: 1, ts: '1.0' }; } });
  recordInbound(dir, 'dentai', 'cadê?', Date.now() - MIN);
  await assert.rejects(tools.get('slack_send')!.execute('1', { text: 'já vai', channel: 'dentai' }));
  assert.equal(slackWeek(dir, 0).answered, 0);
  fail = false;
  await tools.get('slack_send')!.execute('2', { text: 'pronto', channel: 'dentai' });
  assert.equal(slackWeek(dir, 0).answered, 1);
}));

test('the scoreboard says what is unmeasured instead of showing zero', () => {
  const empty = { received: 0, answered: 0, waiting: 0, nudges: 0 };
  assert.match(composeScoreboard({ from: 0, to: DAY, slack: empty, merged: { green: 0, other: 0 } }), /"E a\u00ed\?" e primeira resposta no Slack: n\u00e3o medidos ainda/);
  assert.doesNotMatch(composeScoreboard({ from: 0, to: DAY, slack: empty, merged: { green: 0, other: 0 } }), /\*0\* \(meta 0\)/, 'no record is not a zero');
  const text = composeScoreboard({ from: monday - 7 * DAY, to: monday, slack: { received: 2, answered: 0, waiting: 2, nudges: 0, recordingSince: monday - 2 * DAY }, merged: { green: 0, other: 0 } });
  assert.match(text, /registro s\u00f3 desde/);
  assert.match(text, /sem pares mensagem→resposta registrados \(2 recebidas\)/);
  assert.match(text, /compromissos ilegíveis, não medido/);
  assert.match(text, /sem linha de base ainda/);
  assert.match(text, /Ações sem autorização: não medido/);
  assert.match(composeScoreboard({ from: 0, to: 1, slack: { received: 1, answered: 1, waiting: 0, nudges: 1, medianMs: 75 * MIN, worstMs: 75 * MIN, recordingSince: 0 }, commitments: { stuck: 1, overdue: 0 }, routing: { woke: 3, quiet: 1 }, merged: { green: 2, other: 1 } }),
    /"E aí\?" do operador no Slack: \*1\*[\s\S]*mediana \*1h15\*[\s\S]*\*1\* sem progresso[\s\S]*\*1 de 4\* \(25%\)[\s\S]*\*2\* com CI verde, 1 sem CI verde/);
});

test('weekly inputs: merged PRs of the week, Gitwatch routing as a delta from the saved baseline, reset counters unmeasured', withDir(dir => {
  const gitwatch = join(dir, 'gitwatch.json');
  writeFileSync(join(dir, 'pr-watch.json'), JSON.stringify({
    'a#1': { sig: 'MERGED:SUCCESS', seen: monday, since: monday - DAY, title: 't', url: 'u', channel: 'harness' },
    'a#2': { sig: 'MERGED:FAILURE', seen: monday, since: monday - 2 * DAY, title: 't', url: 'u', channel: 'harness' },
    'a#3': { sig: 'MERGED:SUCCESS', seen: monday, since: monday - 8 * DAY, title: 't', url: 'u', channel: 'harness' },
    'a#4': { sig: 'OPEN:SUCCESS', seen: monday, since: monday - DAY, title: 't', url: 'u', channel: 'harness' },
  }));
  writeFileSync(gitwatch, JSON.stringify({ stats: { since: 1, woke: 10, quiet: 6 } }));
  const first = weekInputs(dir, monday, {}, gitwatch);
  assert.deepEqual(first.inputs.merged, { green: 1, other: 1 });
  assert.equal(first.inputs.routing, undefined, 'no baseline yet');
  assert.deepEqual(first.routing, { since: 1, woke: 10, quiet: 6 });
  assert.deepEqual(weekInputs(dir, monday, { routing: { since: 1, woke: 7, quiet: 2 } }, gitwatch).inputs.routing, { woke: 3, quiet: 4 });
  assert.equal(weekInputs(dir, monday, { routing: { since: 0, woke: 7, quiet: 2 } }, gitwatch).inputs.routing, undefined, 'a reset counter is not a negative week');
}));

test('the scoreboard posts once a week to #harness, Monday morning only, saving the next baseline first', withDir(async dir => {
  const posts: { text: string; channel: string | null }[] = [];
  let now = monday - DAY; // Sunday
  const gitwatch = join(dir, 'gitwatch.json');
  writeFileSync(gitwatch, JSON.stringify({ stats: { since: 1, woke: 4, quiet: 1 } }));
  const board = new WeeklyScoreboard(() => ({ dir, name: 'p' }), async (text, channel) => { posts.push({ text, channel }); }, { now: () => now, gitwatchFile: gitwatch });
  assert.equal(await board.maybePost(), false, 'not on Sunday');
  now = monday;
  assert.equal(await board.maybePost(), true);
  assert.equal(await board.maybePost(), false, 'once per week');
  assert.equal(posts[0]!.channel, 'harness');
  assert.match(posts[0]!.text, /Placar Jarvis/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'slack-scoreboard.json'), 'utf8')).routing, { since: 1, woke: 4, quiet: 1 });
  writeFileSync(gitwatch, JSON.stringify({ stats: { since: 1, woke: 5, quiet: 4 } }));
  now = monday + 7 * DAY;
  assert.equal(await board.maybePost(), true);
  assert.match(posts[1]!.text, /\*3 de 4\* \(75%\)/);
  now = monday + 14 * DAY + 3 * 3_600_000; // 13:00: too late, the week is skipped
  assert.equal(await board.maybePost(), false);
}));
