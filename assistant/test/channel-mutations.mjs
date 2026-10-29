// Disposable-source negative controls: removing each Slack/Teams boundary guard must fail a channel test.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'assistant-channel-mutants-'));
const tests = ['slack-boundary.test.ts', 'teams-boundary.test.ts', 'channel-approval.test.ts', 'slack-relay.test.ts'];
const variants = [
  ['slack-signature', 'channels/slack.ts', 'return given.length === expected.length && timingSafeEqual(given, expected);', 'return true;'],
  ['slack-window', 'channels/slack.ts', 'if (Math.abs(now / 1000 - Number(ts)) > WINDOW_SECONDS) return false;', ''],
  ['slack-workspace', 'channels/slack.ts', "if (body.team_id !== o.team || body.api_app_id !== o.appId) return { outcome: 'foreign_workspace' };", ''],
  ['slack-bot', 'channels/slack.ts', "const human = !event.bot_id && !NON_HUMAN_SUBTYPES.has(event.subtype) && typeof event.user === 'string';", 'const human = true;'],
  ['slack-button-approves', 'channels/slack.ts', "return { outcome: 'review_required', reply: `Revise no painel autenticado: ${o.reviewLink(taskId)}` };\n    }\n    if (body?.type !== 'event_callback'", "return { outcome: 'ignored' };\n    }\n    if (body?.type !== 'event_callback'"],
  ['slack-click-workspace', 'channels/slack.ts', "if (body.team?.id !== o.team || body.api_app_id !== o.appId) return { outcome: 'foreign_workspace' };", ''],
  ['slack-click-sender', 'channels/slack.ts', "if (!this.options.ledger.authorized('slack', this.options.team, user)) return { outcome: 'unauthorized_sender' };", ''],
  ['slack-click-dm-only', 'channels/slack.ts', "if (!channel.startsWith('D')) return { outcome: 'ignored' };", ''],
  ['slack-click-retires-buttons', 'channels/slack.ts', "relay.retire(channel, post,", "void (channel, post,"],
  ['teams-signature', 'channels/teams.ts', 'if (!ok) return false;', ''],
  ['teams-audience', 'channels/teams.ts', ' && claims.aud === options.appId', ''],
  ['teams-expiry', 'channels/teams.ts', ' && now <= claims.exp + SKEW_SECONDS', ''],
  ['teams-service-url', 'channels/teams.ts', ' && claims.serviceurl === options.serviceUrl', ''],
  ['teams-alg', 'channels/teams.ts', "head.alg !== 'RS256' || ", ''],
  ['teams-tenant', 'channels/teams.ts', "if (activity.channelData?.tenant?.id !== o.tenantId || (activity.conversation?.tenantId !== undefined && activity.conversation.tenantId !== o.tenantId)) return { outcome: 'foreign_workspace' };", ''],
  ['teams-bot', 'channels/teams.ts', "human: activity.from?.role !== 'bot' && Boolean(sender)", 'human: Boolean(sender)'],
  ['sender-authorization', 'channels/inbound.ts', "if (!ledger.authorized(message.platform, message.account, message.sender)) return { outcome: 'unauthorized_sender' };", ''],
  // Without the guard the store's unique source constraint still refuses the second task (defense in depth), as an error.
  ['replay', 'channels/inbound.ts', "if (store.get(taskId)) return { outcome: 'duplicate', taskId };", '', /UNIQUE constraint failed: events\.profile, events\.source_id/],
  ['stale-input', 'channels/inbound.ts', ' || current.revision !== binding.revision) return', ') return'],
  ['revocation', 'channels/inbound.ts', ' AND revoked = 0', ''],
  ['operator-only', 'channels/inbound.ts', "    if (authority !== this.authority) fail('unauthorized');\n    this.db.prepare('INSERT INTO channel_senders", "    this.db.prepare('INSERT INTO channel_senders"],
  ['outbound-bypass', 'channels/inbound.ts', 'posted = await gateway.dispatch(request, (bytes, metadata) => transport(bytes, metadata));', 'posted = await transport(request.payload, request);'],
];
let killed = 0;
try {
  for (const [name, path, before, after, expected = /AssertionError|ERR_ASSERTION|Missing expected/] of variants) {
    const dir = join(root, name); mkdirSync(join(dir, 'test'), { recursive: true });
    cpSync(join(sourceRoot, 'src'), join(dir, 'src'), { recursive: true });
    cpSync(join(sourceRoot, 'package.json'), join(dir, 'package.json'));
    for (const file of [...tests, 'channel-support.ts']) cpSync(join(sourceRoot, 'test', file), join(dir, 'test', file));
    const file = join(dir, 'src', path);
    const source = readFileSync(file, 'utf8'); assert.equal(source.split(before).length, 2, `nonunique mutant ${name}`);
    writeFileSync(file, source.replace(before, after));
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', ...tests.map(t => join(dir, 'test', t))], { env, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 1, `${name} survived`);
    assert.match(result.stdout, expected, `${name}: failed for an unexpected reason`);
    killed++; console.log(`killed ${name}`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify({ mutants: variants.length, killed, survivors: variants.length - killed }));
