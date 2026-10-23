import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isReadOnlyDiagnostic } from '../src/operation-diagnostics.ts';
import { OperationJournal, registerOperationSafety } from '../src/operations.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const journal = () => new OperationJournal(mkdtempSync(join(tmpdir(), 'diagnostics-')));

test('failed read-only shell diagnostics do not block later writes or create uncertain effects', () => {
  for (const command of ['pwd; ls missing', 'cat "missing file" | head -20', 'grep -n missing file && wc -l file', 'head -20 file || tail -10 file']) {
    const j = journal();
    j.start('s', 'diagnostic', 'bash', { command });
    j.finish('s', 'diagnostic', true);
    assert.deepEqual(j.pending(), [], command);
    assert.equal(j.blockReason('write'), undefined, command);
  }
});

test('literal regex operators in quotes do not turn diagnostics into shell pipelines', () => {
  for (const command of ["grep -n -E 'class CharField|MaxLengthValidator' file", 'grep -n "a;b|c" file', "cat 'name;with|operators'"]) {
    assert.equal(isReadOnlyDiagnostic('bash', { command }), true, command);
  }
});

test('plain rg is read-only only without executable configuration or helper flags', () => {
  const original = process.env.RIPGREP_CONFIG_PATH;
  try {
    delete process.env.RIPGREP_CONFIG_PATH;
    assert.equal(isReadOnlyDiagnostic('bash', { command: 'rg -n "class CharField|MaxLengthValidator" django/db/models/fields' }), true);
    for (const command of ['rg --pre evil pattern', 'rg --no-config --pre=evil pattern', 'rg -z pattern', 'rg --search-zip pattern', 'rg --pre-glob=*.txt pattern', 'rg -n pattern *']) {
      assert.equal(isReadOnlyDiagnostic('bash', { command }), false, command);
    }
    process.env.RIPGREP_CONFIG_PATH = '/untrusted/config';
    assert.equal(isReadOnlyDiagnostic('bash', { command: 'rg -n pattern file' }), false);
    assert.equal(isReadOnlyDiagnostic('bash', { command: 'rg --no-config -n pattern file' }), true);
    assert.equal(isReadOnlyDiagnostic('bash', { command: "rg -- '--no-config'" }), false);
  } finally {
    if (original === undefined) delete process.env.RIPGREP_CONFIG_PATH; else process.env.RIPGREP_CONFIG_PATH = original;
  }
});

test('quote-aware diagnostics still reject expansions, concatenation, executable options and mixed mutations', () => {
  for (const command of ['cat "$(touch file)"', 'cat "`touch file`"', "grep 'literal'$(touch file) file", "cat 'safe'\"suffix\"", "grep 'x|y' file; touch other", 'rg --no-config --pre=evil pattern', 'rg --no-config --search-zip pattern', 'rg --no-config -- --pre=evil *']) {
    assert.equal(isReadOnlyDiagnostic('bash', { command }), false, command);
  }
  assert.equal(isReadOnlyDiagnostic('bash', { command: "grep '$(not-executed)|literal' file" }), true);
});

test('diagnostics can inspect state behind a barrier without clearing it', () => {
  const j = journal();
  j.start('s', 'mutation', 'write', {});
  j.finish('s', 'mutation', true);
  assert.doesNotThrow(() => j.start('s', 'inspection', 'bash', { command: 'cat missing' }));
  assert.equal(j.pending().length, 1);
  assert.match(j.blockReason('write') ?? '', /uncertain/);
});

test('ambiguous shell syntax and potentially mutating commands retain uncertainty', () => {
  for (const command of ['git push', 'cat file > output', 'cat $(touch file)', 'cat `touch file`', 'cat $FILE', 'cat file; touch other', 'git diff --output=out', 'git -c core.pager=evil diff', 'git diff --ext-diff', 'ls; bash -c pwd', 'cat <(touch file)', 'cat file\nrm file', 'rg --pre evil pattern', 'ripwire . --quality-delta', 'head --help;', 'cat "unterminated', 'cat file & touch other', 'cat file # comment', 'FOO=x cat file', 'command cat file', 'bash -c "cat file"', 'cat file\\;touch other']) {
    const j = journal();
    j.start('s', 'c', 'bash', { command });
    j.finish('s', 'c', true);
    assert.equal(j.pending().length, 1, command);
    assert.match(j.blockReason('write') ?? '', /uncertain/, command);
  }
});

test('registered tool hooks allow diagnostics behind a barrier but still block ambiguous bash', async () => {
  const j = journal();
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, handler); },
    getAllTools() { return []; },
    registerTool() {},
  } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getSessionId: () => 'session', getLeafId: () => 'entry' } };
  registerOperationSafety(pi, () => j);
  const call = (id: string, command: string) => hooks.get('tool_call')!({ toolName: 'bash', toolCallId: id, input: { command } }, ctx);
  const result = (id: string) => hooks.get('tool_result')!({ toolName: 'bash', toolCallId: id, isError: true }, ctx);
  assert.equal(await call('diagnostic', 'cat missing'), undefined);
  await result('diagnostic');
  assert.deepEqual(j.pending(), []);
  assert.equal(await call('mutation', 'git push'), undefined);
  await result('mutation');
  assert.equal(await call('readback', 'ls missing'), undefined);
  await result('readback');
  assert.equal(j.pending().length, 1);
  assert.deepEqual(await call('blocked', 'cat missing; git push'), {
    block: true, reason: j.blockReason('bash'),
  });
  assert.equal(j.pending().length, 1);
});

test('cd-prefixed inspections and line-range sed are read-only; other sed scripts and globs are not', () => {
  for (const command of ['cd C:/projetos/app && sed -n 40,140p src/a.ts', 'cd repo && grep -n x src/a.ts; echo ---; sed -n 5p "file *"']) {
    assert.equal(isReadOnlyDiagnostic('bash', { command }), true, command);
  }
  for (const command of ['sed -i 1d file', 'sed -n 1w out file', "sed -n '1e touch x' file", 'sed -n 1p *', 'sed -n 1p -i file', 'sed 1p file', 'cd a b', 'cd repo && git push', 'echo x > file']) {
    assert.equal(isReadOnlyDiagnostic('bash', { command }), false, command);
  }
});

test('an ordinary failing mutation is observed, a timed-out one opens the barrier', async () => {
  const j = journal();
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const pi = { on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, handler); }, getAllTools() { return []; }, registerTool() {} } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getSessionId: () => 'session', getLeafId: () => 'entry' } };
  registerOperationSafety(pi, () => j);
  const run = async (id: string, text: string) => {
    await hooks.get('tool_call')!({ toolName: 'bash', toolCallId: id, input: { command: 'git push' } }, ctx);
    await hooks.get('tool_result')!({ toolName: 'bash', toolCallId: id, isError: true, content: [{ type: 'text', text }] }, ctx);
  };
  await run('rejected', 'error: failed to push some refs\nCommand exited with code 1');
  assert.deepEqual(j.pending(), []);
  await run('slow', 'Command timed out after 120 seconds');
  assert.equal(j.pending().length, 1);
  assert.match(j.blockReason('bash') ?? '', /^Not executed: .*uncertain/);
});

test('common read-only inspections are recognized, including pipes and /dev/null redirects', () => {
  const accepted = [
    'cmp a.txt b.txt && echo COPY_MATCH', 'cmp -s a b', 'diff -u a.txt b.txt', 'diff -r dir1 dir2 | head -20', 'od -c file | head', 'file src/a.ts', 'stat -c %s file',
    'sort file | uniq -c | sort -rn | head', 'sort -u file', 'uniq -c file', 'uniq -f 1 file', 'cut -d, -f1 file', String.raw`cat file | tr -d '\r'`, 'nl -ba file',
    'which node', 'type git', 'tasklist //FI "IMAGENAME eq python.exe" 2>&1 | head -5', 'tasklist /FI "IMAGENAME eq python.exe"',
    'git status --short | head', 'git status -sb', 'git log --oneline -n 5', 'git --no-pager log -5', 'git -C C:/projetos/dotfiles status --short', 'git -C repo --no-pager diff --stat',
    'git diff --check', 'git diff HEAD~1 -- src/a.ts', 'git show HEAD:src/a.ts', 'git rev-parse --show-toplevel', 'git ls-files -o', 'git ls-files src',
    'git branch', 'git branch --list', 'git branch -a', 'git branch -v', 'git branch -vv', "git branch --list 'retro/*'", 'git worktree list', 'git worktree list --porcelain', 'git remote -v', 'git remote',
    'git config --get user.name', 'git config --global --get user.email',
    'cd C:/projetos/dotfiles && cmp a b && echo COPY_MATCH; git status --short | head',
    'cat file >/dev/null', 'cat file > /dev/null', 'cat file 2>/dev/null', 'cat file 2> /dev/null', 'ls missing 2>&1', 'git status 2>&1 | head', 'cmp a b >/dev/null 2>&1 && echo same',
  ];
  for (const command of accepted) assert.equal(isReadOnlyDiagnostic('bash', { command }), true, command);
});

test('near-miss commands that write, execute or hide a mutation are not read-only', () => {
  const rejected = [
    'git commit -m x', 'git push', 'git add .', 'git checkout main', 'git reset --hard', 'git stash', 'git fetch', 'git pull', 'git clean -fd', 'git',
    'git config user.name x', 'git config --global user.name x', 'git config --unset user.name', 'git config --get', 'git config --get --unset user.name', 'git config --list',
    'git branch newbranch', 'git branch -d old', 'git branch -D old', 'git branch -v newbranch', 'git branch -m a b', 'git branch -l newbranch', 'git branch --list -d old',
    'git worktree add ../x', 'git worktree remove x', 'git remote add origin url', 'git remote remove origin', 'git remote show origin',
    'git log --output=out.txt', 'git diff --out=out.txt', 'git show --output out', 'git diff --ext-diff', 'git log --ext-diff -p', 'git -c core.pager=evil log', 'git -C', 'git -C -c x log',
    'git --paginate log', 'git -p log', 'git --git-dir=x status', 'git status *',
    'sort -o out file', 'sort file -o out', 'sort -ro out file', 'sort --output=out file', 'sort --output out file', 'sort --compress-program=evil file', 'sort *.txt',
    'uniq in out', 'uniq -c in out', 'uniq -f 1 in out', 'uniq file out',
    'uniq -- -f output.txt', 'uniq -- --skip-fields output.txt', 'uniq -- -c output.txt',
    'diff --output=out a b', 'diff --output out a b', 'diff a *',
    'file -C -m magic', 'file -bC x', 'file --compile x', 'tr -d x', 'tr a b', String.raw`tr -d '\r' < file`, 'cat file | tr -d x > out',
    'cat file > out', 'cat file >> out', 'cat file >out', 'echo x > file', 'echo x >> file', 'cat file | tee out', 'tee out', 'cat file | tee /dev/null', 'cat file >> /dev/null', 'cat file > /dev/nullx', 'cat file > /dev/null/x', 'cat file 2>out', 'cat file 2>&2', 'cat file &>/dev/null', 'cat file >&2', 'cat file 1>&2',
    'cat "a"2>&1', 'cat < file', 'cat file <<EOF', String.raw`cmp <(tr -d '\r' < a) <(tr -d '\r' < b)`, 'cat $(touch x)', 'cmp a $(echo b)', 'diff <(cat a) b',
    'du -sh .', 'du', 'cd repo && du -sh src', 'sed -i 1d file', 'cmp a b; rm c', 'cmp a b & touch x', 'diff a b && git push',
  ];
  for (const command of rejected) assert.equal(isReadOnlyDiagnostic('bash', { command }), false, command);
});

test('a block message names each uncertain call with its tool and says read-only tools still work', () => {
  const j = journal();
  j.start('s', 'slow-call', 'bash', { command: 'git push' });
  j.finish('s', 'slow-call', true);
  const reason = j.blockReason('bash') ?? '';
  assert.match(reason, /s:slow-call \(bash\)/);
  assert.match(reason, /Read-only tools still work \(read, grep, find, ls, zoom, search/);
  assert.match(reason, /operation_state/);
});
