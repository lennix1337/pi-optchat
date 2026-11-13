import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseContract } from '../src/autonomy.ts';
import { extractGateAsks, labelReplayItem, redactSecrets, replayAsks, summarizeReplay, type ExtractedGateAsk } from '../scripts/gate-replay.mjs';

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
      // Unrelated toolResult mentioning approve-effect (e.g. reading source code) should be ignored
      JSON.stringify({
        type: 'message',
        timestamp: '2026-11-10T10:00:01.000Z',
        message: { role: 'toolResult', toolCallId: 'c0', toolName: 'read', content: [{ type: 'text', text: `approve-effect ${id1}` }] },
      }),
      // Ask 1: approved later
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
      // Ask 2: denied
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
      // Ask 3: unanswered
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
    // Duplicate copy in sub/run-0 without the approval line should not downgrade outcome
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

  // Explicit check of labelReplayItem for false-positive contract touch
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
