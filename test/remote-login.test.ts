import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  RemoteLoginManager,
  isAuthExpiryError,
  isProxyPlaceholder,
  looksLikeOAuthCode,
  oauthFamilyFor,
  persistOAuthCredential,
  resolveLoginAccount,
  type AuthStorageLike,
  type OAuthProviderDriver,
  type StoredCredential,
} from '../src/remote-login.ts';
import { homeStatus, remoteCommand, type CommandState } from '../src/remote-commands.ts';
import { accountLines } from '../src/quota-format.ts';
import { SlackBridge } from '../src/slack-bridge.ts';

const NOW = Date.UTC(2026, 10, 27, 1, 45);
const ANTHROPIC_PLACEHOLDER = 'sk-ant-oat01-pi-multi-account-proxy';
const CODEX_PLACEHOLDER_JWT = [
  Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64'),
  Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'pi-multi-account-proxy' } })).toString('base64'),
  '',
].join('.');

function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeAuthStorage(agentDir: string): { storage: AuthStorageLike; reloads: number } {
  const path = join(agentDir, 'auth.json');
  const state = { reloads: 0 };
  const storage: AuthStorageLike = {
    async modify(provider, fn) {
      let current: Record<string, StoredCredential> = {};
      try { current = JSON.parse(readFileSync(path, 'utf8')); } catch {}
      const next = await fn(current[provider]);
      if (next !== undefined) {
        current[provider] = next;
        writeFileSync(path, JSON.stringify(current, null, 2));
      }
      return next ?? current[provider];
    },
    reload() { state.reloads++; },
  };
  return { storage, get reloads() { return state.reloads; } };
}

test('auth expiry, family, placeholder and OAuth code classifiers distinguish real inputs from chat', () => {
  assert.equal(isAuthExpiryError('401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has expired. Re-authenticate to continue."}}'), true);
  assert.equal(isAuthExpiryError('401 {"error":{"message":"invalid x-api-key"}}'), true);
  assert.equal(isAuthExpiryError('429 rate limit exceeded'), false);
  assert.equal(isAuthExpiryError(undefined), false);

  assert.equal(oauthFamilyFor('anthropic'), 'anthropic');
  assert.equal(oauthFamilyFor('anthropic-account-2'), 'anthropic');
  assert.equal(oauthFamilyFor('openai-codex'), 'openai-codex');
  assert.equal(oauthFamilyFor('openai-codex-account-3'), 'openai-codex');
  assert.equal(oauthFamilyFor('google'), undefined);

  assert.equal(isProxyPlaceholder({ type: 'api_key', key: ANTHROPIC_PLACEHOLDER }), true);
  assert.equal(isProxyPlaceholder({ type: 'api_key', key: CODEX_PLACEHOLDER_JWT }), true);
  assert.equal(isProxyPlaceholder({ type: 'api_key', key: 'sk-ant-usr-real-api-key' }), false);

  assert.equal(looksLikeOAuthCode('abc1234567890XYZ#state1234567890ABC'), true);
  assert.equal(looksLikeOAuthCode('https://platform.claude.com/oauth/code/callback?code=abc123&state=xyz'), true);
  assert.equal(looksLikeOAuthCode('qual o status do deploy hoje?'), false);
  assert.equal(looksLikeOAuthCode('oi'), false);
});

test('persistOAuthCredential preserves shadowed proxy placeholder in auth.json and writes sidecar', async t => {
  const agentDir = tempDir('remote-login-shadow-');
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({
    'anthropic-account-2': { type: 'api_key', key: ANTHROPIC_PLACEHOLDER },
    anthropic: { type: 'api_key', key: 'sk-ant-usr-real-key' },
  }));
  writeFileSync(join(agentDir, 'pi-multi-account-proxy-oauth.json'), JSON.stringify({
    'anthropic-account-2': { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: 1 },
  }));
  const { storage } = makeAuthStorage(agentDir);
  await persistOAuthCredential(
    'anthropic-account-2',
    { type: 'oauth', access: 'new-access', refresh: 'new-refresh', expires: NOW + 3_600_000 },
    { agentDir, authStorage: storage },
  );
  const rawAuth = JSON.parse(readFileSync(join(agentDir, 'auth.json'), 'utf8'));
  const sidecar = JSON.parse(readFileSync(join(agentDir, 'pi-multi-account-proxy-oauth.json'), 'utf8'));
  assert.deepEqual(rawAuth['anthropic-account-2'], { type: 'api_key', key: ANTHROPIC_PLACEHOLDER });
  assert.equal(sidecar['anthropic-account-2'].access, 'new-access');
  assert.equal(sidecar['anthropic-account-2'].refresh, 'new-refresh');

  await assert.rejects(
    () => persistOAuthCredential('anthropic', { type: 'oauth', access: 'a', refresh: 'r' }, { agentDir, authStorage: storage }),
    /API key/,
  );
});

test('resolveLoginAccount handles shorthands, single invalidated auto-pick, and API-key skip', t => {
  const agentDir = tempDir('remote-login-resolve-');
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({
    anthropic: { type: 'api_key', key: 'sk-ant-usr-real-key' },
    'anthropic-account-2': { type: 'api_key', key: ANTHROPIC_PLACEHOLDER },
    'openai-codex': { type: 'oauth', access: 'a', refresh: 'r' },
  }));
  assert.deepEqual(
    resolveLoginAccount('', ['anthropic', 'anthropic-account-2', 'openai-codex'], ['anthropic-account-2', 'anthropic'], agentDir),
    { provider: 'anthropic-account-2' },
  );
  assert.deepEqual(
    resolveLoginAccount('claude 2', ['anthropic-account-2'], [], agentDir),
    { provider: 'anthropic-account-2' },
  );
  assert.deepEqual(
    resolveLoginAccount('claude', ['anthropic', 'anthropic-account-2'], [], agentDir),
    { provider: 'anthropic-account-2' },
  );
  assert.deepEqual(
    resolveLoginAccount('codex 2', ['openai-codex-account-2'], [], agentDir),
    { provider: 'openai-codex-account-2' },
  );
  assert.equal(remoteCommand('login claude 2')?.command.name, 'login');
  assert.equal(remoteCommand('login claude 2')?.arg, 'claude 2');
  assert.equal(remoteCommand('login na conta amanha'), undefined);
});

test('Anthropic expired OAuth run triggers graceful Slack login link, accepts pasted code without leaking it, persists sidecar and resumes DM', async t => {
  const agentDir = tempDir('remote-login-agent-');
  const profileDir = tempDir('remote-login-profile-');
  t.after(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  });
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({
    'anthropic-account-2': { type: 'api_key', key: ANTHROPIC_PLACEHOLDER },
  }));
  writeFileSync(join(agentDir, 'pi-multi-account-proxy-oauth.json'), JSON.stringify({
    'anthropic-account-2': { type: 'oauth', access: 'expired-tok', refresh: 'dead-ref', expires: NOW - 10_000 },
  }));
  const auth = makeAuthStorage(agentDir);
  const updated: string[] = [];
  let selectedMethod = '';
  let receivedCode = '';
  const fakeAnthropic: OAuthProviderDriver = {
    async login(interaction) {
      selectedMethod = await interaction.prompt({ type: 'select', message: 'method' });
      interaction.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/authorize?code=true&state=s1' });
      receivedCode = await interaction.prompt({ type: 'manual_code', message: 'paste' });
      return { type: 'oauth', access: 'fresh-access-secret', refresh: 'fresh-refresh-secret', expires: NOW + 28_800_000 };
    },
  };
  const manager = new RemoteLoginManager({
    agentDir,
    now: () => NOW,
    authStorage: () => auth.storage,
    oauthDriver: family => family === 'anthropic' ? fakeAnthropic : undefined,
    onUpdated: provider => updated.push(provider),
  });
  t.after(() => manager.stop());

  const inbox: { seq: number; ts: string; thread: string | null; text: string; channel?: string }[] = [
    { seq: 1, ts: '100.1', thread: null, channel: 'D1', text: 'qual o status dos PRs?' },
  ];
  const sentToPi: string[] = [];
  const posted: { path: string; body?: any }[] = [];
  const bridge = new SlackBridge(
    { sendUserMessage: ((text: string) => { sentToPi.push(text); }) as never },
    () => ({ dir: profileDir, name: 'swlucas05' }),
    {
      now: () => NOW,
      model: () => 'anthropic-account-2/claude-sonnet-5-5',
      failover: () => ({}),
      models: () => [{ provider: 'anthropic-account-2', id: 'claude-sonnet-5-5' }],
      remoteLogin: manager,
      schedule: () => {},
      request: async (_owner, path, body) => {
        posted.push({ path, body });
        if (path.startsWith('/v1/slack/inbox')) {
          const after = Number(new URLSearchParams(path.split('?')[1]).get('after'));
          return { messages: inbox.filter(m => m.seq > after) };
        }
        return { parts: 1, ts: '200.1', channel: 'D1' };
      },
    },
  );

  await bridge.poll();
  assert.equal(sentToPi.length, 1);
  bridge.runStarted();
  bridge.sawUserMessage(sentToPi[0]!);
  await bridge.runEnded([{
    role: 'assistant',
    content: [],
    provider: 'anthropic-account-2',
    stopReason: 'error',
    errorMessage: '401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has expired. Re-authenticate to continue."}}',
  } as unknown as AgentMessage]);

  assert.equal(selectedMethod, 'copy_code');
  const loginPost = posted.filter(p => p.path === '/v1/slack/send').at(-1)?.body.text as string;
  assert.match(loginPost, /Sessão expirada em Claude conta 2/);
  assert.match(loginPost, /https:\/\/claude\.ai\/oauth\/authorize\?code=true&state=s1/);
  assert.doesNotMatch(loginPost, /"type":"error"/);

  inbox.push({ seq: 2, ts: '100.2', thread: null, channel: 'D1', text: 'espera um segundo' });
  await bridge.poll();
  assert.equal(sentToPi.length, 2);

  const secretCode = 'antCodeSecret1234567890#stateSecret1234567890';
  inbox.push({ seq: 3, ts: '100.3', thread: null, channel: 'D1', text: secretCode });
  await bridge.poll();
  assert.equal(receivedCode, secretCode);
  assert.equal(sentToPi.some(msg => msg.includes(secretCode)), false);
  assert.deepEqual(updated, ['anthropic-account-2']);
  assert.equal(auth.reloads, 1);
  const sidecar = JSON.parse(readFileSync(join(agentDir, 'pi-multi-account-proxy-oauth.json'), 'utf8'));
  assert.equal(sidecar['anthropic-account-2'].access, 'fresh-access-secret');
  const donePost = posted.filter(p => p.path === '/v1/slack/send').at(-1)?.body.text as string;
  assert.match(donePost, /Login concluído em Claude conta 2/);
  assert.equal(donePost.includes(secretCode), false);
  assert.equal(donePost.includes('fresh-access-secret'), false);
  assert.equal(sentToPi.length, 3, 'original failed Slack DM is automatically resumed after login');
  assert.match(sentToPi[2]!, /qual o status dos PRs\?/);
});

test('OpenAI Codex device-code login starts immediately and completes in background', async t => {
  const agentDir = tempDir('remote-login-codex-');
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({
    'openai-codex-account-2': { type: 'api_key', key: CODEX_PLACEHOLDER_JWT },
  }));
  let finishDevice!: (cred: StoredCredential) => void;
  const completed: any[] = [];
  const updated: string[] = [];
  const fakeCodex: OAuthProviderDriver = {
    async login(interaction) {
      const method = await interaction.prompt({ type: 'select', message: 'method' });
      assert.equal(method, 'device_code');
      interaction.notify({ type: 'device_code', verificationUri: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234' });
      return new Promise<StoredCredential>(resolve => { finishDevice = resolve; });
    },
  };
  const manager = new RemoteLoginManager({
    agentDir,
    now: () => NOW,
    oauthDriver: family => family === 'openai-codex' ? fakeCodex : undefined,
    onUpdated: provider => updated.push(provider),
    onBackgroundComplete: event => completed.push(event),
  });
  t.after(() => manager.stop());

  const step = await manager.start('openai-codex-account-2');
  assert.match(step.text, /https:\/\/auth\.openai\.com\/codex\/device/);
  assert.match(step.text, /ABCD-1234/);
  assert.equal(completed.length, 0);

  finishDevice({ type: 'oauth', access: 'codex-new', refresh: 'codex-ref', expires: NOW + 3_600_000, accountId: 'acc-2' });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updated, ['openai-codex-account-2']);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].ok, true);
  assert.match(completed[0].text, /Login concluído em Codex conta 2/);
  const sidecar = JSON.parse(readFileSync(join(agentDir, 'pi-multi-account-proxy-oauth.json'), 'utf8'));
  assert.equal(sidecar['openai-codex-account-2'].access, 'codex-new');
});

test('proactive invalidation notice sends one-tap login buttons once and cota/Home flag expired accounts', async t => {
  const agentDir = tempDir('remote-login-notice-');
  const profileDir = tempDir('remote-login-notice-profile-');
  t.after(() => {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  });
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({
    'anthropic-account-2': { type: 'api_key', key: ANTHROPIC_PLACEHOLDER },
  }));
  const manager = new RemoteLoginManager({ agentDir, now: () => NOW });
  t.after(() => manager.stop());
  const sends: any[] = [];
  const failover = {
    authTypeByProvider: { 'anthropic-account-2': 'oauth', anthropic: 'api_key' },
    usageByProvider: { 'anthropic-account-2': { primary: { usedPercent: 16, resetAt: NOW + 3_600_000 } } },
    invalidatedByProvider: {
      'anthropic-account-2': { tokenHash: 'abc', at: NOW, reason: 'invalid_grant' },
      anthropic: { tokenHash: 'def', at: NOW, reason: 'invalid x-api-key' },
    },
  };
  const bridge = new SlackBridge(
    { sendUserMessage: (() => {}) as never },
    () => ({ dir: profileDir, name: 'swlucas05' }),
    {
      now: () => NOW,
      failover: () => failover,
      remoteLogin: manager,
      schedule: () => {},
      request: async (_owner, path, body) => {
        if (path === '/v1/slack/send') sends.push(body);
        return { parts: 1, ts: '1.1', channel: 'D1' };
      },
    },
  );

  await bridge.notifyAuthInvalidated({ provider: 'anthropic-account-2', at: NOW, reason: 'invalid_grant' });
  await bridge.notifyAuthInvalidated({ provider: 'anthropic-account-2', at: NOW, reason: 'invalid_grant' });
  assert.equal(sends.length, 1, 'duplicate invalidation must notify only once');
  assert.match(sends[0].text, /Claude conta 2/);
  assert.deepEqual(sends[0].choices, ['login anthropic-account-2', 'status']);

  const quota = accountLines(failover, NOW).join('\n');
  assert.match(quota, /anthropic-account-2 \[OAuth\]: 🔐 \*login OAuth expirado\* — mande \*login anthropic-account-2\*/);
  assert.match(quota, /anthropic \[API key\]: 🔐 \*API key recusada\* — atualize com `\/login` no terminal/);
  const state: CommandState = {
    model: () => 'anthropic-account-2/claude-opus-5-5',
    activity: () => '✅ *Livre*',
    failover: () => failover,
    now: () => NOW,
    models: () => [],
    select: async () => true,
  };
  const home = homeStatus(state);
  assert.match(home, /Claude conta 2 \[OAuth\]: 🔐 \*login OAuth expirado\* — mande \*login anthropic-account-2\*/);
  assert.match(home, /Claude conta 1 \[API key\]: 🔐 \*chave recusada\* — atualize com `\/login` no terminal/);
});
