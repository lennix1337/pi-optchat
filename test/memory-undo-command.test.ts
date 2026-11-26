import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executedEffects, registerExecLog } from '../src/exec-log.ts';
import { Memory } from '../src/memory.ts';
import { registerMemoryUndo } from '../src/memory-undo.ts';
import { SlackBridge } from '../src/slack-bridge.ts';

test('Pi /undo and /redo share the Slack text and reaction route; confirmations name executed effects', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'undo-command-'));
  const memory = new Memory(dir, async ({ source }) => source);
  t.after(async () => { await memory.close(); rmSync(dir, { recursive: true, force: true }); });
  type Handler = (args: string, ctx: { ui: { notify(text: string): void } }) => Promise<void>;
  const handlers = new Map<string, Handler>();
  const notices: string[] = [];
  const ctx = { ui: { notify: (text: string) => { notices.push(text); } } };
  const use = registerMemoryUndo({ registerCommand: ((name: string, command: { handler: Handler }) => handlers.set(name, command.handler)) as never }, () => memory);
  memory.append('user', 'Test Alpha', undefined, undefined, undefined, 'slack:DFAKE:100.1');
  memory.append('tool', 'bash {"command":"gh pr create"}', undefined, 'call-alpha');
  memory.append('echo', 'bash: https://github.com/fake/example/pull/17', undefined, 'call-alpha');
  memory.append('talk', 'Reply Alpha');
  memory.append('user', 'Test Bravo');
  memory.append('talk', 'Reply Bravo');
  const executions = new Map<string, (event: object, ctx: object) => void>();
  registerExecLog({ on: ((name: string, fn: (event: object, ctx: object) => void) => executions.set(name, fn)) as never } as never, () => dir);
  function execute(toolCallId: string, command: string, result: string, isError = false) {
    executions.get('tool_execution_start')!({ toolCallId, args: { command } }, { cwd: dir });
    executions.get('tool_execution_end')!({ toolCallId, toolName: 'bash', result, isError }, { cwd: dir });
  }
  execute('call-alpha', 'gh pr create', 'https://github.com/fake/example/pull/17');
  execute('elsewhere', 'gh pr create', 'https://github.com/fake/example/pull/99');
  execute('call-alpha', 'gh pr create', 'refused: https://github.com/fake/example/pull/42', true);
  await handlers.get('undo')?.('2', ctx);
  assert.doesNotMatch(memory.render(), /Bravo/);
  assert.match(memory.render(), /Reply Alpha/);
  await handlers.get('redo')?.('', ctx);
  assert.match(memory.render(), /Reply Bravo/);
  const sends: string[] = [];
  let messages: object[] = [
    { seq: 1, ts: '100.2', thread: null, channel: 'DFAKE', text: 'undo' },
    { seq: 2, ts: '100.3', thread: null, channel: 'DFAKE', text: 'redo' },
    { seq: 3, ts: '100.4', thread: null, channel: 'DFAKE', text: '', undoTs: '100.1' },
  ];
  const bridge = new SlackBridge({ sendUserMessage: (() => assert.fail('command must not start a model turn')) as never }, () => ({ dir, name: 'fake' }), {
    memoryUndo: use,
    request: async (_owner, path, body) => {
      if (path.startsWith('/v1/slack/inbox')) return { messages };
      sends.push((body as { text: string }).text);
      return { parts: 1, ts: '110.1' };
    },
  });
  await bridge.poll();
  assert.match(memory.render(), /Reply Bravo/);
  assert.doesNotMatch(memory.render(), /Alpha/);
  assert.equal(sends.length, 3);
  assert.match(sends[0], /ocultad/);
  assert.match(sends[1], /restaurad/);
  assert.match(sends[2], /já foi executado e não volta:[\s\S]*PR #17 aberta[\s\S]*Feche a PR/);
  assert.doesNotMatch(sends[2], /#99|#42/);
  messages = [];
  assert.match(use({ action: 'redo', arg: '', seq: 4 }), /restaurad/);
  assert.match(use({ action: 'redo', arg: '', seq: 4 }), /já foi aplicad/);
  assert.equal(notices.length, 2);
});

test('undo effect descriptions name the operation and give a manual response, not a command', () => {
  const run = (tool: string, args: object) => executedEffects(tool, args, '/fake/repo', '').map(e => `${e.label}: ${e.revert}`).join('\n');
  assert.match(run('bash', { command: 'git push origin feature-fake' }), /Push Git: origin feature-fake.*reversão/);
  assert.match(run('bash', { command: 'gh pr merge 42 --squash' }), /PR #42 mesclada.*reversão/);
  assert.match(run('bash', { command: 'npm run deploy' }), /Deploy.*rollback/);
  assert.match(run('slack_send', {}), /Slack.*retratação/);
  assert.match(run('whatsapp_send', {}), /WhatsApp.*retratação/);
  assert.match(run('write', { path: 'fake.txt' }), /fake.txt.*reverta/);
  assert.equal(run('bash', { command: 'git push --dry-run origin feature-fake' }), '');
  assert.equal(run('shell_start', { command: 'git push origin feature-fake' }), '');
});
