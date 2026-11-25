import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackBridge } from '../src/slack-bridge.ts';
import { awayRecap, buildRecap, nextAction, renderRecap } from '../src/away-recap.ts';
import { recordRun } from '../src/home-day.ts';
import { recordInbound } from '../src/slack-metrics.ts';
import { COALESCE_FROM, coalescePrChanges, logSent, PrWatch, type PrChange } from '../src/slack-reports.ts';
import { desktopNotification } from '../src/terminal-notify.ts';
import { remoteCommand } from '../src/remote-commands.ts';

const NOW = Date.UTC(2026, 10, 1, 18, 0);
const HOUR = 3_600_000;
const PR = (n: number, text: string) => `${text} \u00b7 <https://github.com/acme/app/pull/${n}|app#${n}> Titulo ${n}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ux-plans-'));
  return { dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}


test('the same plan sent again with steps ticked moves the DM card instead of posting a second one', async () => {
  const dir = fixture().dir, posts: { path: string; body: any }[] = [];
  const bridge = new SlackBridge({ sendUserMessage: () => {} } as never, () => ({ dir, name: 'p' }), {
    now: () => NOW, schedule: () => {},
    request: async (_o: unknown, path: string, body: any) => { posts.push({ path, body }); return { parts: 1, ts: '9.1', channel: 'D1' }; },
  } as never);
  try {
    const plan = (marks: string) => `<proposed_plan>\n# Migrar\n${marks}</proposed_plan>`;
    await bridge.send(plan('- [ ] Ler\n- [ ] Escrever\n'));
    await bridge.send(plan('- [x] Ler\n- [ ] Escrever\n'));
    assert.deepEqual(posts.map(p => p.path), ['/v1/slack/send', '/v1/slack/plan']);
    assert.deepEqual([posts[1]!.body.channel, posts[1]!.body.ts], ['D1', '9.1']);
    await bridge.send(`<proposed_plan>\n# Outro plano\n- [ ] A\n</proposed_plan>`);
    assert.equal(posts[2]!.path, '/v1/slack/send', 'a different plan is a new card');
    await bridge.send(plan('- [ ] Ler\n- [ ] Escrever\n'));
    await bridge.send(plan('- [ ] Ler\n- [ ] Escrever\n- [ ] Testar\n'));
    assert.equal(posts[4]!.path, '/v1/slack/send', 'same title with another number of steps is a different plan');
    await bridge.send(plan('- [ ] Ler os dados\n- [ ] Escrever o relatório\n- [ ] Testar tudo\n'));
    assert.equal(posts[5]!.path, '/v1/slack/send', 'same title and number of steps, rewritten steps: a new card, not an edit of the old one');
    await bridge.send(plan('- [x] Ler os dados\n- [ ] Escrever o relatório\n- [ ] Testar tudo\n'));
    assert.equal(posts[6]!.path, '/v1/slack/plan', 'ticking a box of the same steps still updates the card');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('when the card can no longer be edited, the plan goes out as a new card', async () => {
  const dir = fixture().dir, posts: string[] = [];
  const bridge = new SlackBridge({ sendUserMessage: () => {} } as never, () => ({ dir, name: 'p' }), {
    now: () => NOW, schedule: () => {},
    request: async (_o: unknown, path: string) => { posts.push(path); if (path === '/v1/slack/plan') throw new Error('message_not_found'); return { parts: 1, ts: '9.1', channel: 'D1' }; },
  } as never);
  try {
    await bridge.send('<proposed_plan>\n# Migrar\n- [ ] Ler\n</proposed_plan>');
    const result = await bridge.send('<proposed_plan>\n# Migrar\n- [x] Ler\n</proposed_plan>');
    assert.deepEqual(posts, ['/v1/slack/send', '/v1/slack/plan', '/v1/slack/send']);
    assert.equal(result.ts, '9.1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a card Slack posted without a timestamp is not kept for later updates', async () => {
  const dir = fixture().dir, posts: string[] = [];
  const bridge = new SlackBridge({ sendUserMessage: () => {} } as never, () => ({ dir, name: 'p' }), {
    now: () => NOW, schedule: () => {},
    request: async (_o: unknown, path: string) => { posts.push(path); return { parts: 1, ts: '', channel: 'D1' }; },
  } as never);
  try {
    await bridge.send('<proposed_plan>\n# Migrar\n- [ ] Ler\n</proposed_plan>');
    await bridge.send('<proposed_plan>\n# Migrar\n- [x] Ler\n</proposed_plan>');
    assert.deepEqual(posts, ['/v1/slack/send', '/v1/slack/send']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


const change = (n: number, text: string, channel = 'dentai'): PrChange => ({ channel, key: `acme/app#${n}`, change: text, line: PR(n, text) });

test('a burst of low-priority PR changes in one channel is one post whose first line says what happened', () => {
  const burst = [change(1, '\u{1F7E3} Mergeado'), change(2, '\u{1F7E3} Mergeado'), change(3, '\u2705 CI verde')];
  assert.equal(burst.length, COALESCE_FROM);
  const out = coalescePrChanges(burst);
  assert.equal(out.length, 1);
  assert.equal(out[0]![0], 'dentai');
  assert.equal(out[0]![1].split('\n')[0], '*3 PRs mudaram* \u00b7 2\u00d7 \u{1F7E3} Mergeado \u00b7 1\u00d7 \u2705 CI verde');
  assert.match(out[0]![1], /<https:\/\/github\.com\/acme\/app\/pull\/3\|app#3>/, 'every PR link stays in the post');
});

test('a red CI is never held back in a burst, and two changes stay two posts', () => {
  const out = coalescePrChanges([change(1, '\u274c CI vermelho'), change(2, '\u{1F7E3} Mergeado'), change(3, '\u{1F7E3} Mergeado'), change(4, '\u{1F7E3} Mergeado', 'harness'), change(5, '\u{1F7E3} Mergeado', 'harness')]);
  assert.deepEqual(out.map(([channel, text]) => [channel, text.split(' \u00b7 ')[0]]), [['dentai', '\u274c CI vermelho'], ['dentai', '\u{1F7E3} Mergeado'], ['dentai', '\u{1F7E3} Mergeado'], ['harness', '\u{1F7E3} Mergeado'], ['harness', '\u{1F7E3} Mergeado']]);
  assert.equal(out[0]![2], 'pr:acme/app#1', 'an urgent change keeps its PR thread');
});

test('the PR watch posts three merges in one pass as one message', async () => {
  const f = fixture();
  writeFileSync(join(f.dir, 'assistant.json'), '{}');
  try {
    const node = (n: number, state: string) => ({ number: n, title: `Item ${n}`, url: `https://github.com/lennix1337/pi-optchat/pull/${n}`, state, isDraft: false, createdAt: '2020-01-01T00:00:00Z',
      repository: { name: 'pi-optchat', nameWithOwner: 'lennix1337/pi-optchat' }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } });
    let nodes = [1, 2, 3].map(n => node(n, 'OPEN'));
    const posts: { text: string; topic?: string }[] = [];
    const watch = new PrWatch(() => ({ dir: f.dir, name: 'p' }), async (text, _channel, topic) => { posts.push({ text, topic }); }, async () => JSON.stringify({ data: { search: { nodes } } }), () => Date.parse('2026-10-29T12:00:00Z'));
    await watch.poll();
    nodes = [1, 2, 3].map(n => node(n, 'MERGED'));
    assert.equal(await watch.poll(), 1);
    assert.match(posts[0]!.text, /^\*3 PRs mudaram\* \u00b7 3\u00d7 /u);
    assert.equal((posts[0]!.text.match(/pull\/\d/g) ?? []).length, 3);
  } finally { f.close(); }
});

test('the desktop notification uses the sequence the terminal knows, and no control character from a tool call reaches it', () => {
  assert.equal(desktopNotification({ TERM_PROGRAM: 'iTerm.app' }, 'Aprovação pendente', 'git push'), '\x1b]9;Aprovação pendente: git push\x07');
  assert.equal(desktopNotification({ KITTY_WINDOW_ID: '3' }, 'Aprovação pendente', 'git push'), '\x1b]777;notify;Aprovação pendente;git push\x07');
  assert.equal(desktopNotification({ TERM_PROGRAM: 'vscode' }, 'a', 'b'), undefined, 'a terminal without notifications gets the bell only');
  const hostile = desktopNotification({ VTE_VERSION: '7000' }, 't', 'echo x\x1b]0;pwn\x07; echo \x00')!;
  assert.equal(hostile.slice(1).match(/[\x00-\x1f\x7f]/g)!.length, 1, 'past the opening ESC only the closing BEL is a control character');
  assert.equal(hostile, '\x1b]777;notify;t;echo x ]0 pwn echo\x07');
});


test('the recap lists what was sent since the last message, keeps the links and names one next action', () => {
  const f = fixture();
  try {
    logSent(f.dir, null, PR(9, '\u{1F195} PR aberto'), NOW - 5 * HOUR);
    recordInbound(f.dir, null, 'vou sair', NOW - 3 * HOUR);
    logSent(f.dir, null, PR(9, '\u{1F195} PR aberto'), NOW - 2 * HOUR);
    logSent(f.dir, null, PR(9, '\u2705 CI verde'), NOW - HOUR);
    logSent(f.dir, 'dentai', PR(10, '\u{1F7E3} Mergeado'), NOW - 30 * 60_000);
    recordRun(f.dir, { start: NOW - 150 * 60_000, end: NOW - 90 * 60_000, about: 'x', origin: 'slack', steps: 3 });
    const text = awayRecap(f.dir, NOW);
    assert.match(text, /^\*Desde sua última mensagem\* \u00b7 01\/11 12:00 \(há 3h00\)/, 'times in Brasília');
    assert.match(text, /1 trabalho \u00b7 1h00 trabalhando \u00b7 2 avisos enviados/, 'the PR that opened and went green counts once');
    assert.match(text, /\u2022 \u{1F7E3} Mergeado \u00b7 <https:\/\/github\.com\/acme\/app\/pull\/10\|app#10>/u);
    assert.doesNotMatch(text, /PR aberto/);
    assert.match(text, /\*Próximo passo:\* revisar e mergear: <https:\/\/github\.com\/acme\/app\/pull\/9\|app#9> Titulo 9/);
  } finally { f.close(); }
});

test('without a recorded message the recap covers 24 hours and says so; the next action falls back honestly', () => {
  const recap = buildRecap({ now: NOW, lastMessage: undefined, runs: [], posts: [{ at: NOW - 30 * HOUR, line: 'velho' }], waiting: 0 });
  assert.equal(recap.known, false);
  assert.deepEqual(recap.posts, []);
  const text = renderRecap(recap, NOW);
  assert.match(text, /^\*Últimas 24h\* \u00b7 sem mensagem sua registrada/);
  assert.match(text, /nenhum trabalho registrado \u00b7 nenhum aviso enviado/);
  assert.match(text, /nada pendente nos registros \(isso não prova/);
  assert.match(nextAction([PR(3, '\u274c CI vermelho'), PR(4, '\u2705 CI verde')], 2), /^ver o CI vermelho: <https/, 'a red CI outranks the rest');
  assert.match(nextAction([], 2), /há 2 mensagens suas sem resposta/);
});

test('"resumo" is a command answered on the spot from the records, not a message to the agent', async () => {
  assert.equal(remoteCommand('resumo')?.command.name, 'resumo');
  assert.equal(remoteCommand('Jarvis, voltei')?.command.name, 'resumo');
  const f = fixture(), agent: string[] = [], posts: { path: string; body: any }[] = [];
  recordInbound(f.dir, null, 'vou sair', NOW - 2 * HOUR);
  logSent(f.dir, null, PR(7, '\u274c CI vermelho'), NOW - HOUR);
  const bridge = new SlackBridge({ sendUserMessage: ((text: string) => { agent.push(text); }) as never }, () => ({ dir: f.dir, name: 'p' }), {
    now: () => NOW, schedule: () => {},
    request: async (_o: unknown, path: string, body: any) => {
      posts.push({ path, body });
      if (path.startsWith('/v1/slack/inbox')) return { messages: Number(new URLSearchParams(path.split('?')[1]).get('after')) < 1 ? [{ seq: 1, ts: '1.0', thread: null, text: 'resumo' }] : [] };
      return { parts: 1, ts: '9.1', channel: 'D1' };
    },
  } as never);
  try {
    await bridge.poll();
    assert.deepEqual(agent, []);
    const reply = posts.find(p => p.path === '/v1/slack/send')!.body.text as string;
    assert.match(reply, /^\*Desde sua última mensagem\*/);
    assert.match(reply, /\*Próximo passo:\* ver o CI vermelho: <https:\/\/github\.com\/acme\/app\/pull\/7\|app#7>/);
  } finally { f.close(); }
});
