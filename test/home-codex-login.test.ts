import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { hookedPi, tempDir } from './support.ts';
import { homeBlocks } from '../assistant/src/channels/slack-relay.ts';
import { codexHomeLoginReader } from '../src/codex-home-login.ts';
import { registerSlackBridge } from '../src/slack-bridge.ts';

const NOW = Date.UTC(2026, 10, 27, 2);
const BASE = 'openai-codex', SECOND = 'openai-codex-account-2';
const jwt = (payload: object) => `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture-signature`;
const oauth = (email: string, expires: number) => ({ type: 'oauth', access: jwt({ 'https://api.openai.com/profile': { email } }), refresh: 'fixture-refresh-secret', expires });
const proxy = { type: 'api_key', key: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'pi-mul-fixture' } }) };

async function renderHome(t: TestContext, auth: object, sidecar: object = {}, quota: object = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { dir, close } = tempDir('home-codex-profile-');
  t.after(close);
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  for (const [name, data] of Object.entries({ 'auth.json': auth, 'pi-multi-account-proxy-oauth.json': sidecar, 'provider-failover-state.json': quota })) {
    const path = join(agentDir, name);
    writeFileSync(path, JSON.stringify(data));
    t.after(() => rmSync(path));
  }
  const { pi } = hookedPi();
  const sent: string[] = [];
  const bridge = registerSlackBridge(pi, () => ({ dir, name: 'test' }), undefined, {
    request: async (_owner, path, body) => {
      if (path === '/v1/slack/home') {
        const { text } = body as { text: string };
        sent.push(text);
      }
    },
  });
  bridge.sawUserMessage('oi');
  await setImmediate();
  assert.equal(sent.length, 1);
  const blocks = homeBlocks(sent[0]!) as { text?: { text: string }; fields?: { text: string }[] }[];
  const start = blocks.findIndex(b => b.text?.text === 'Cotas das contas');
  assert.notEqual(start, -1);
  const card = (account: number) => blocks.slice(start + 1).find(b => b.text?.text.includes(`Codex conta ${account}`));
  return { blocks, card, text: sent[0]! };
}

test('Codex Home: OAuth card shows masked email and Brasília expiry with its quota gauge', async t => {
  const login = oauth('alexandra@example.test', NOW + 30 * 60_000);
  const { card } = await renderHome(t, { [BASE]: login }, { [BASE]: oauth('other@example.test', NOW + 60_000) }, {
    usageByProvider: { [BASE]: { primary: { usedPercent: 35, resetAt: NOW + 3_600_000 } } },
  });
  assert.match(card(1)?.text?.text ?? '', /oauth · ale…@example\.test · vence 26\/11 23:30 BRT/);
  assert.match(card(1)?.fields?.[0]?.text ?? '', /35%/);
});

test('Codex Home: expired and missing logins remain visible when all quota is exhausted', async t => {
  const end = NOW + 3_600_000;
  const { card } = await renderHome(t, { [BASE]: oauth('alexandra@example.test', NOW) }, {}, {
    exhaustedUntilByProvider: { [BASE]: end, [SECOND]: end },
  });
  assert.match(card(1)?.text?.text ?? '', /⚠️ login vencido — refazer · oauth · ale…@example\.test · venceu 26\/11 23:00 BRT.*esgotada/);
  assert.match(card(2)?.text?.text ?? '', /⚠️ login ausente — refazer.*esgotada/);
});

test('Codex Home: proxy API-key placeholder uses the OAuth sidecar and leaks no credential strings', async t => {
  const login = oauth('beatriz@example.test', NOW + 7_200_000);
  const realKey = 'fixture-real-api-key-secret';
  const { card, blocks, text } = await renderHome(t, { [BASE]: { type: 'api_key', key: realKey }, [SECOND]: proxy }, {
    [BASE]: oauth('stale@example.test', NOW + 3_600_000), [SECOND]: login,
  }, { authTypeByProvider: { [SECOND]: 'api_key' } });
  assert.match(card(2)?.text?.text ?? '', /oauth · bea…@example\.test · vence 27\/11 01:00 BRT/);
  assert.doesNotMatch(card(2)?.text?.text ?? '', /api_key|sem limite de cota/);
  assert.match(card(1)?.text?.text ?? '', /api_key · sem vencimento informado/);
  const published = `${text}\n${JSON.stringify(blocks)}`;
  for (const secret of [login.access, login.refresh, proxy.key, realKey, 'beatriz@example.test', 'stale@example.test']) {
    assert.ok(!published.includes(secret), 'only redacted login metadata may be published');
  }
});

test('Codex Home: proxy without OAuth sidecar is a missing login, not a usable API key', async t => {
  const { card } = await renderHome(t, { [SECOND]: proxy }, {}, { authTypeByProvider: { [SECOND]: 'api_key' } });
  const line = card(2)?.text?.text ?? '';
  assert.match(line, /⚠️ login ausente — refazer/);
  assert.doesNotMatch(line, /api_key|sem limite de cota/);
});

test('Codex Home: a long valid mail domain does not hide the expiry on an unmetered card', async t => {
  const domain = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.test`;
  const { card } = await renderHome(t, { [BASE]: oauth(`alexandra@${domain}`, NOW + 60_000) });
  assert.ok(card(1)?.text?.text.includes(`ale…@${domain} · vence 26/11 23:01 BRT`));
});

test('Codex Home: injected directory keeps only redacted metadata and observes sidecar update or removal', t => {
  const { dir, close } = tempDir('home-login-cache-');
  t.after(close);
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ [BASE]: proxy }));
  const sidecar = join(dir, 'pi-multi-account-proxy-oauth.json');
  writeFileSync(sidecar, JSON.stringify({ [BASE]: oauth('alexandra@example.test', NOW) }));
  const read = codexHomeLoginReader(dir), first = read();
  assert.deepEqual(first.get(BASE), { type: 'oauth', maskedEmail: 'ale…@example.test', expires: NOW });
  assert.equal(read(), first, 'unchanged files reuse the redacted projection');
  writeFileSync(sidecar, JSON.stringify({ [BASE]: oauth('beatriz@another.test', NOW + 3_600_000) }));
  assert.deepEqual(read().get(BASE), { type: 'oauth', maskedEmail: 'bea…@another.test', expires: NOW + 3_600_000 });
  rmSync(sidecar);
  assert.deepEqual([...read()], [[BASE, undefined]]);
});
