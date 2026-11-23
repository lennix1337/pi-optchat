import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseContract } from '../src/autonomy.ts';
import {
  DEFAULT_GOOD_SAMPLE,
  compareRuleReplay,
  extractGateAsks,
  labelReplayItem,
  readRuleBaseline,
  redactSecrets,
  replayAsks,
  runRuleReplay,
  summarizeReplay,
  type ExtractedGateAsk,
} from '../scripts/gate-replay.mjs';

const contract = parseContract({
  version: 1,
  default: 'report',
  rules: [
    { action: 'force-push', scope: ['*'], level: 'ask' },
    { action: 'deploy', scope: ['*'], level: 'ask' },
    { action: 'production-write', scope: ['*'], level: 'ask' },
    { action: 'push', scope: ['*'], level: 'report' },
    { action: 'merge', scope: ['*'], level: 'report' },
    { action: 'recursive-delete', scope: ['*/node_modules', 'c:/tmp/*'], level: 'free' },
  ],
});

test('extractGateAsks deduplicates by id and resolves approved, denied, and unanswered outcomes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-replay-test-'));
  try {
    const subDir = join(dir, 'sub', 'run-0');
    mkdirSync(subDir, { recursive: true });

    const id1 = '0123456789abcdef01234567';
    const id2 = 'fedcba9876543210fedcba98';
    const id3 = 'aaaaaaaaaaaaaaaaaaaaaaaa';

    const sessionLines = [
      JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: '2026-11-10T10:00:00.000Z', cwd: 'C:/projetos/demo' }),

      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-10T10:00:01.000Z',
        message: { role: 'toolResult', toolCallId: 'c0', toolName: 'read', content: [{ type: 'text', text: `approve-effect ${id1}` }] },
      }),

      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-10T10:01:00.000Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'git push --force origin feat' } }] },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-10T10:01:01.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'bash',
          content: [{
            type: 'text',
            text: `autonomy.json says this waits for the operator: force-push on demo: ask (rule force-push *). Not executed: bash is a force-push effect and requires approval. approve-effect ${id1}`,
          }],
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-10T10:01:10.000Z',
        message: { role: 'user', content: [{ type: 'text', text: `approve-effect ${id1}` }] },
      }),

      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-10T10:02:00.000Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'gh pr merge 14 --admin' } }] },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-10T10:02:01.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'c2',
          toolName: 'bash',
          content: [{ type: 'text', text: `Not executed: bash is a merge-bypass effect and requires approval. approve-effect ${id2}` }],
        },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-10T10:02:10.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Denied by the operator, do not run or retry: gh pr merge 14 --admin' }] },
      }),

      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-10T10:03:00.000Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c3', name: 'bash', arguments: { command: 'git push origin feat' } }] },
      }),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-10T10:03:01.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'c3',
          toolName: 'bash',
          content: [{ type: 'text', text: `Not executed: bash is a push effect and requires approval. approve-effect ${id3}` }],
        },
      }),
    ];

    writeFileSync(join(dir, 'main.jsonl'), sessionLines.join('\n') + '\n');

    writeFileSync(join(subDir, 'session.jsonl'), sessionLines.slice(0, 4).join('\n') + '\n');

    const asks = extractGateAsks(dir);
    assert.equal(asks.length, 3);
    assert.deepEqual(asks.map(a => [a.id, a.outcome]), [
      [id1, 'approved'],
      [id2, 'denied'],
      [id3, 'unanswered'],
    ]);
    assert.equal(asks[0].rule, 'force-push *');
    assert.deepEqual(asks[0].actions, ['force-push']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('labelReplayItem and replayAsks distinguish needed, needless-still-asks, and fixed', () => {
  const noRepo = { slug: () => undefined, branch: () => undefined };
  const asks: ExtractedGateAsk[] = [
    { id: '1', timestamp: '2026-11-10T10:00:00Z', cwd: 'C:/projetos/demo', tool: 'bash', input: { command: 'git push origin feat' }, command: 'git push origin feat', actions: ['push'], outcome: 'approved' },
    { id: '2', timestamp: '2026-11-10T10:01:00Z', cwd: 'C:/projetos/demo', tool: 'bash', input: { command: 'git push --force origin feat' }, command: 'git push --force origin feat', actions: ['force-push'], outcome: 'approved' },
    { id: '3', timestamp: '2026-11-10T10:02:00Z', cwd: 'C:/projetos/demo', tool: 'bash', input: { command: 'gh pr merge 14 --admin' }, command: 'gh pr merge 14 --admin', actions: ['merge-bypass'], outcome: 'approved' },
    { id: '4', timestamp: '2026-11-10T10:03:00Z', cwd: 'C:/projetos/demo', tool: 'bash', input: { command: 'rm -rf .scratch test/.scratch' }, command: 'rm -rf .scratch test/.scratch', actions: ['recursive-delete'], outcome: 'unanswered' },
  ];

  const replayed = replayAsks(asks, { contract, contractDir: 'C:/Users/example/.optchat/profiles/test', repo: noRepo });
  assert.deepEqual(replayed.map(r => r.label), ['fixed', 'needed', 'needless-still-asks', 'needless-still-asks']);

  const summary = summarizeReplay(replayed);
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.byLabel, { needed: 1, 'needless-still-asks': 2, fixed: 1 });
  assert.equal(summary.topNeedless.length, 2);


  const falseContract = labelReplayItem(
    { tool: 'bash', input: { command: 'gh pr create --body "mentions autonomy.json"' }, command: 'gh pr create --body "mentions autonomy.json"' },
    { wouldAsk: true, touchesContract: true, effects: [] },
  );
  assert.equal(falseContract, 'needless-still-asks');
});

test('redactSecrets masks bearer tokens, API keys, and query tokens', () => {
  const raw = 'curl -H "Authorization: Bearer abcdef1234567890" https://example.com?token=secret123 OPENAI_API_KEY=sk-1234567890abcdef1234';
  const clean = redactSecrets(raw);
  assert.doesNotMatch(clean, /abcdef1234567890|secret123|sk-1234567890abcdef1234/);
  assert.match(clean, /\[REDACTED\]/);
});

const NOW = Date.parse('2026-11-22T22:00:00Z');
const RECENT = '2026-11-21T12:00:00Z';
const OLD_OUTSIDE_30D = '2026-10-10T12:00:00Z';

function writeJsonl(filePath: string, events: object[]) {
  writeFileSync(filePath, events.map(e => JSON.stringify(e)).join('\n') + '\n');
}

function caughtAdmissionEvents(timestamp: string) {
  return [
    {
      type: 'message',
      timestamp,
      message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Não confirmei que o worker começou.' }] },
    },
    {
      type: 'custom_message',
      customType: 'optchat-report',
      timestamp,
      content: '[OptChat claim check] Your reply admits not having checked.',
    },
  ];
}

function caughtPipeEvents(timestamp: string, id: string) {
  return [
    {
      type: 'message',
      timestamp,
      message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id, name: 'bash', arguments: { command: 'npm test | tail -3; echo rc=' + '$' + '?' } }] },
    },
    {
      type: 'message',
      timestamp,
      message: { role: 'toolResult', toolCallId: id, content: [{ type: 'text', text: 'Não executado: use PIPESTATUS.' }] },
    },
  ];
}

function cleanTurnEvents(timestamp: string) {
  return [
    { type: 'message', timestamp, message: { role: 'user', content: [{ type: 'text', text: 'Conclui o ajuste do módulo.' }] } },
    { type: 'message', timestamp, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Ajuste aplicado e validado nos testes focados.' }] } },
  ];
}

test('rule replay writes baseline with --update, passes when equal or better, and fails when a rule regresses', () => {
  const root = mkdtempSync(join(tmpdir(), 'rule-replay-'));
  try {
    const sessions = join(root, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const good = join(root, 'known-good.jsonl');
    const baseline = join(root, 'profile', 'replay-baseline.json');

    writeJsonl(join(sessions, 's1.jsonl'), [
      ...caughtAdmissionEvents(RECENT),
      ...caughtPipeEvents(RECENT, 'p1'),
      ...caughtAdmissionEvents(OLD_OUTSIDE_30D),
    ]);
    writeJsonl(good, cleanTurnEvents(RECENT));

    const updated = runRuleReplay({ sessionsDir: sessions, goodSample: good, baselinePath: baseline, now: NOW, update: true });
    assert.equal(updated.updated, true);
    assert.equal(updated.passed, true);
    assert.equal(existsSync(baseline), true);

    const saved = readRuleBaseline(baseline);
    assert.ok(saved);
    assert.equal(saved.windowDays, 30);
    assert.equal(saved.rules['unchecked-own-work']?.caught, 1);
    assert.equal(saved.rules['pipe-status']?.caught, 1);
    assert.equal(saved.rules['unchecked-own-work']?.falseFlags, 0);

    const equalRun = runRuleReplay({ sessionsDir: sessions, goodSample: good, baselinePath: baseline, now: NOW });
    assert.equal(equalRun.passed, true);
    assert.deepEqual(equalRun.comparison.regressions, []);

    writeJsonl(join(sessions, 's2.jsonl'), caughtAdmissionEvents(RECENT));
    const betterRun = runRuleReplay({ sessionsDir: sessions, goodSample: good, baselinePath: baseline, now: NOW });
    assert.equal(betterRun.passed, true);
    assert.ok(betterRun.comparison.improvements.some(i => i.id === 'unchecked-own-work' && i.kind === 'caught-rose'));

    rmSync(join(sessions, 's2.jsonl'));
    writeJsonl(join(sessions, 's1.jsonl'), caughtAdmissionEvents(RECENT));
    const droppedRun = runRuleReplay({ sessionsDir: sessions, goodSample: good, baselinePath: baseline, now: NOW });
    assert.equal(droppedRun.passed, false);
    assert.ok(droppedRun.comparison.regressions.some(r => r.id === 'pipe-status' && r.kind === 'caught-dropped'));

    writeJsonl(join(sessions, 's1.jsonl'), [
      ...caughtAdmissionEvents(RECENT),
      ...caughtPipeEvents(RECENT, 'p1'),
    ]);
    writeJsonl(good, [
      ...cleanTurnEvents(RECENT),
      { type: 'message', timestamp: RECENT, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Se quiser, é só dizer.' }] } },
    ]);
    const falseFlagRun = runRuleReplay({ sessionsDir: sessions, goodSample: good, baselinePath: baseline, now: NOW });
    assert.equal(falseFlagRun.passed, false);
    assert.ok(falseFlagRun.comparison.regressions.some(r => r.id === 'ending-offer' && r.kind === 'false-flags-rose'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rule replay handles missing sessions dir without crashing and still checks known-good sample', () => {
  const root = mkdtempSync(join(tmpdir(), 'rule-replay-missing-'));
  try {
    const missingSessions = join(root, 'does-not-exist');
    const good = join(root, 'known-good.jsonl');
    const baseline = join(root, 'replay-baseline.json');

    writeJsonl(good, cleanTurnEvents(RECENT));
    writeFileSync(baseline, JSON.stringify({
      version: 1,
      updatedAt: RECENT,
      windowDays: 30,
      rules: { 'pipe-status': { caught: 3, detected: 3, falseFlags: 0 } },
    }));

    const okRun = runRuleReplay({ sessionsDir: missingSessions, goodSample: good, baselinePath: baseline, now: NOW });
    assert.equal(okRun.sessionsMissing, true);
    assert.equal(okRun.passed, true);
    assert.deepEqual(okRun.comparison.regressions, []);

    const updateWhileMissing = runRuleReplay({ sessionsDir: missingSessions, goodSample: good, baselinePath: baseline, now: NOW, update: true });
    assert.equal(updateWhileMissing.sessionsMissing, true);
    assert.equal(updateWhileMissing.updated, false);
    assert.equal(readRuleBaseline(baseline)?.rules['pipe-status']?.caught, 3);

    writeJsonl(good, [
      { type: 'message', timestamp: RECENT, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Posso mergear agora?' }] } },
    ]);
    const badGoodRun = runRuleReplay({ sessionsDir: missingSessions, goodSample: good, baselinePath: baseline, now: NOW });
    assert.equal(badGoodRun.sessionsMissing, true);
    assert.equal(badGoodRun.passed, false);
    assert.ok(badGoodRun.comparison.regressions.some(r => r.id === 'free-action' && r.kind === 'false-flags-rose'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shipped known-good fixture produces zero false flags across all correction rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'rule-replay-good-'));
  try {
    const result = runRuleReplay({
      sessionsDir: join(root, 'missing-sessions'),
      goodSample: DEFAULT_GOOD_SAMPLE,
      baselinePath: join(root, 'no-baseline.json'),
      now: NOW,
    });
    assert.equal(result.goodMissing, false);
    assert.equal(result.passed, true);
    const flagged = Object.entries(result.comparison.rules).filter(([, v]) => v.falseFlags > 0);
    assert.deepEqual(flagged, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compareRuleReplay treats improved falseFlags and new rules as passing and flags missing baseline rules', () => {
  const baseline = {
    version: 1 as const,
    updatedAt: RECENT,
    windowDays: 30,
    rules: {
      'pipe-status': { caught: 2, detected: 2, falseFlags: 1 },
      'removed-rule': { caught: 1, detected: 1, falseFlags: 0 },
    },
  };
  const improved = compareRuleReplay(
    {
      'pipe-status': { caught: 2, detected: 2, falseFlags: 0 },
      'removed-rule': { caught: 1, detected: 1, falseFlags: 0 },
      'new-rule': { caught: 1, detected: 1, falseFlags: 0 },
    },
    baseline,
  );
  assert.equal(improved.passed, true);
  assert.ok(improved.improvements.some(i => i.id === 'pipe-status' && i.kind === 'false-flags-dropped'));

  const missing = compareRuleReplay({ 'pipe-status': { caught: 2, detected: 2, falseFlags: 0 } }, baseline);
  assert.equal(missing.passed, false);
  assert.ok(missing.regressions.some(r => r.id === 'removed-rule' && r.kind === 'caught-dropped'));
});

test('gate-replay CLI writes baseline with --update into profile dir and exits non-zero on regression', () => {
  const root = mkdtempSync(join(tmpdir(), 'rule-replay-cli-'));
  try {
    const sessions = join(root, 'sessions');
    const optchatHome = join(root, 'optchat-home');
    mkdirSync(sessions, { recursive: true });
    mkdirSync(join(optchatHome, 'profiles', 'demo'), { recursive: true });
    writeFileSync(join(optchatHome, 'last-profile'), 'demo\n');
    const good = join(root, 'good.jsonl');
    const nowIso = new Date().toISOString();
    writeJsonl(join(sessions, 's1.jsonl'), caughtAdmissionEvents(nowIso));
    writeJsonl(good, cleanTurnEvents(nowIso));

    const env = { ...process.env, OPTCHAT_HOME: optchatHome };
    const cli = ['--experimental-transform-types', '--no-warnings', 'scripts/gate-replay.mjs'];

    const outUpdate = execFileSync(process.execPath, [...cli, '--rules', '--update', '--sessions', sessions, '--good', good, '--json'], { encoding: 'utf8', env });
    const parsedUpdate = JSON.parse(outUpdate);
    assert.equal(parsedUpdate.updated, true);
    assert.equal(parsedUpdate.passed, true);
    const expectedBaseline = join(optchatHome, 'profiles', 'demo', 'replay-baseline.json');
    assert.equal(existsSync(expectedBaseline), true);
    assert.equal(JSON.parse(readFileSync(expectedBaseline, 'utf8')).rules['unchecked-own-work'].caught, 1);

    const outPass = execFileSync(process.execPath, [...cli, '--rules', '--sessions', sessions, '--good', good, '--json'], { encoding: 'utf8', env });
    assert.equal(JSON.parse(outPass).passed, true);

    writeJsonl(join(sessions, 's1.jsonl'), cleanTurnEvents(nowIso));
    assert.throws(
      () => execFileSync(process.execPath, [...cli, '--rules', '--sessions', sessions, '--good', good], { encoding: 'utf8', env }),
      (err: { status?: number }) => err.status === 1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
