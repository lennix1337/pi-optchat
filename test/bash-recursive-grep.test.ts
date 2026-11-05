import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { narrowRecursiveGrep, NOTE, registerRecursiveGrepNarrowing } from '../src/bash-recursive-grep.ts';

const EXCLUDES = '--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.worktrees --exclude-dir=worktrees';

test('a recursive grep over project trees skips node_modules and worktrees', () => {
  const narrowed: [string, string][] = [
    // Two of the calls of 04-05/11 that timed out.
    [String.raw`cd C:/projetos; grep -rln "expands \$_\|before PowerShell starts" --include=*.ts pi-* dotfiles 2>/dev/null | head`,
      String.raw`cd C:/projetos; grep ${EXCLUDES} -rln "expands \$_\|before PowerShell starts" --include=*.ts pi-* dotfiles 2>/dev/null | head`],
    [`grep -rln 'This is the swlucas05 profile' C:/Users/swluc/.pi C:/projetos/dotfiles/payload/pi 2>/dev/null | grep -v node_modules`,
      `grep ${EXCLUDES} -rln 'This is the swlucas05 profile' C:/Users/swluc/.pi C:/projetos/dotfiles/payload/pi 2>/dev/null | grep -v node_modules`],
    ['grep -R foo src', `grep ${EXCLUDES} -R foo src`],
    ['grep -n --recursive foo .', `grep ${EXCLUDES} -n --recursive foo .`],
    ['ls && grep -rhoE "x" a; grep -rn y b', `ls && grep ${EXCLUDES} -rhoE "x" a; grep ${EXCLUDES} -rn y b`],
    // 05/11: `time grep -rn` ran unnarrowed (18 s); a prefix keeps grep in command position.
    ['cd a && time grep -rn x C:/projetos/pi-optchat | head', `cd a && time grep ${EXCLUDES} -rn x C:/projetos/pi-optchat | head`],
    ['LC_ALL=C grep -r x .', `LC_ALL=C grep ${EXCLUDES} -r x .`],
    ['env LC_ALL=C timeout 30 grep -r x .', `env LC_ALL=C timeout 30 grep ${EXCLUDES} -r x .`],
    ['nice -n 10 command grep -r x .', `nice -n 10 command grep ${EXCLUDES} -r x .`],
  ];
  for (const [command, expected] of narrowed) assert.equal(narrowRecursiveGrep(command), expected, command);
});

test('greps that are not recursive, ask for those folders, or are only text are left alone', () => {
  const kept = [
    'grep -n foo src/index.ts',
    'grep -c -A3 foo a.txt',
    'cat x | grep -v node_modules',
    'grep -rn foo node_modules/@earendil-works/pi-coding-agent/dist',
    'grep -rn "a | b; c" node_modules/x',
    'grep -rn foo C:/projetos/dotfiles/.worktrees/bench',
    'grep -rn foo --exclude-dir=dist src',
    'echo "grep -rn foo src"',
    'echo time grep -r x .',
    'ls -r grep',
    "git log --grep 'x' -r",
    'rg -n foo src',
    'egrep -r foo src',
    "cat > a.sh <<'EOF'\ngrep -rn foo src\nEOF\nbash a.sh",
  ];
  for (const command of kept) assert.equal(narrowRecursiveGrep(command), undefined, command);
});

test('the hook rewrites the call and says so in its result only', async () => {
  const handlers = new Map<string, (event: unknown) => unknown>();
  registerRecursiveGrepNarrowing({ on(name: string, handler: (event: unknown) => unknown) { handlers.set(name, handler); } } as unknown as ExtensionAPI);
  const call = { toolName: 'bash', toolCallId: 'a', input: { command: 'grep -rn foo src' } };
  assert.equal(await handlers.get('tool_call')!(call), undefined);
  assert.equal(call.input.command, `grep ${EXCLUDES} -rn foo src`);
  const result = await handlers.get('tool_result')!({ toolName: 'bash', toolCallId: 'a', content: [{ type: 'text', text: 'src/a.ts:1:foo\n\nCommand exited with code 0' }] }) as { content: { text: string }[] };
  assert.equal(result.content[0].text, `src/a.ts:1:foo\n${NOTE}\n\nCommand exited with code 0`);
  assert.equal(await handlers.get('tool_result')!({ toolName: 'bash', toolCallId: 'a', content: [{ type: 'text', text: 'again' }] }), undefined);
  const plain = { toolName: 'bash', toolCallId: 'b', input: { command: 'grep -n foo a.ts' } };
  await handlers.get('tool_call')!(plain);
  assert.equal(plain.input.command, 'grep -n foo a.ts');
  assert.equal(await handlers.get('tool_result')!({ toolName: 'bash', toolCallId: 'b', content: [{ type: 'text', text: 'x' }] }), undefined);
});
