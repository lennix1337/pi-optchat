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

test('a backslash before an ordinary character in double quotes is literal, as in bash', () => {
  for (const command of [String.raw`grep -n "cleaner\|const DIRS" a.ts b.ts`, String.raw`grep -n "a\.b" file`, String.raw`cd C:/x && grep -c "C:\Users" file`]) {
    assert.equal(isReadOnlyDiagnostic('bash', { command }), true, command);
  }
  // \$, \`, \" and \\ keep their escaping meaning, so they stay refused with the other expansions.
  for (const command of [String.raw`cat "\$HOME"`, String.raw`cat "a\"b"`, String.raw`cat "a\\b"`, String.raw`cat "\`touch x\`"`, String.raw`cat "a\|$(touch x)"`]) {
    assert.equal(isReadOnlyDiagnostic('bash', { command }), false, command);
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

// 03/11: after one browser timeout the barrier refused 25 inspections in a day, among them the `browser_harness status`
// that the timed-out result itself names as the next step, shell_status, netstat and loopback curl.
test('observing actions and loopback inspections pass the barrier; effects of the same tools do not', () => {
  const observing: [string, unknown][] = [
    ['browser_harness', { action: 'status' }], ['browser_harness', {}], ['browser_harness', { action: 'screenshot', tab: 'T' }],
    ['browser_harness', { action: 'inspect', tab: 'T' }], ['browser_harness', { action: 'read', receipt: 'r', offset: 10 }],
    ['shell_status', { id: 'x' }], ['shell_status', {}], ['read_many', { files: [{ path: 'a' }] }], ['project_evidence', { id: 'x' }],
    ['desktop', { command: 'snapshot', args: ['--app', 'notepad.exe', '-i'] }], ['desktop', {}], ['desktop', { command: 'list-windows' }],
    ['commitments', { action: 'list' }], ['commitments', { action: 'list', all: true }], ['gitwatch', {}], ['gitwatch', { action: 'status' }],
    ['bash', { command: 'netstat -ano | grep ":9333 .*LISTEN"' }],
    ['bash', { command: 'git grep -n -e "scripts/validation" origin/main -- docs' }],
    ['bash', { command: 'curl -s --max-time 8 http://127.0.0.1:9333/json/version | head -c 300' }],
    ['bash', { command: 'curl -sS -o /dev/null -w "%{http_code} " -m 5 "http://localhost:3434/health?x=1"' }],
    ['bash', { command: 'curl -I "http://[::1]:8080/"' }],
  ];
  for (const [tool, input] of observing) assert.equal(isReadOnlyDiagnostic(tool, input), true, JSON.stringify([tool, input]));
  const effects: [string, unknown][] = [
    ['browser_harness', { action: 'click', tab: 'T', node: 1 }], ['browser_harness', { action: 'evaluate', tab: 'T', expression: '1' }],
    ['browser_harness', { action: 'open' }], ['browser_harness', { action: 'close', tab: 'T' }], ['browser_harness', { action: 'navigate', tab: 'T', url: 'x' }],
    ['browser_harness', { action: 'type', tab: 'T', node: 1, text: 'x' }], ['browser_harness', 'status'], ['browser_harness', { action: 1 }],
    ['desktop', { command: 'click', args: ['@e1'] }], ['desktop', { command: 'clipboard-set' }], ['desktop', { command: 'launch' }], ['desktop', { command: 'permissions' }],
    ['commitments', { action: 'add' }], ['commitments', {}], ['commitments', { action: 'update', id: 'c_1' }], ['gitwatch', { action: 'watch', repo: 'a/b' }],
    ['bash', { command: 'git grep -O pattern' }], ['bash', { command: 'git grep -nO pattern' }], ['bash', { command: 'git grep --open-files-in-pager=vim x' }],
    ['bash', { command: 'curl -s https://example.com/' }], ['bash', { command: 'curl -X POST http://127.0.0.1:1/x' }],
    ['bash', { command: 'curl -d a=1 http://127.0.0.1:1/x' }], ['bash', { command: 'curl -o out.txt http://127.0.0.1:1/x' }],
    ['bash', { command: 'curl -L http://127.0.0.1:1/x' }], ['bash', { command: 'curl -K cfg http://127.0.0.1:1/x' }],
    ['bash', { command: 'curl -H "X-HTTP-Method-Override: DELETE" http://127.0.0.1:1/x' }], ['bash', { command: 'curl -sd x http://127.0.0.1:1/x' }],
    ['bash', { command: 'curl http://127.0.0.1:1/a http://127.0.0.1:1/b' }], ['bash', { command: 'curl http://127.0.0.1.evil.com/' }],
    ['bash', { command: 'curl http://localhost@evil.com/' }], ['bash', { command: 'curl file:///etc/passwd' }], ['bash', { command: 'curl -m' }], ['bash', { command: 'curl' }],
    // Unquoted brackets are a glob that could expand to an option.
    ['bash', { command: 'curl -I http://[::1]:8080/' }],
  ];
  for (const [tool, input] of effects) assert.equal(isReadOnlyDiagnostic(tool, input), false, JSON.stringify([tool, input]));
});

test('the recovery step a timed-out browser call names runs behind the barrier it opened', async () => {
  const j = journal();
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const pi = { on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, handler); }, getAllTools() { return []; }, registerTool() {} } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getSessionId: () => 'session', getLeafId: () => 'entry' } };
  registerOperationSafety(pi, () => j);
  const call = (id: string, toolName: string, input: unknown) => hooks.get('tool_call')!({ toolName, toolCallId: id, input }, ctx);
  await call('eval', 'browser_harness', { action: 'evaluate', tab: 'T', expression: 'document.title' });
  await hooks.get('tool_result')!({ toolName: 'browser_harness', toolCallId: 'eval', isError: true, content: [{ type: 'text', text: '{"status":"outcome_uncertain","message":"Runtime.evaluate timed out after 40s"}' }] }, ctx);
  assert.equal(j.pending().length, 1);
  for (const [id, tool, input] of [['status', 'browser_harness', { action: 'status' }], ['shot', 'browser_harness', { action: 'screenshot', tab: 'T' }], ['shell', 'shell_status', { id: 'x' }]] as const) {
    assert.equal(await call(id, tool, input), undefined, `${tool} ${JSON.stringify(input)}`);
  }
  assert.equal((await call('again', 'browser_harness', { action: 'evaluate', tab: 'T', expression: 'document.title' }) as { block?: boolean })?.block, true);
  assert.equal(j.pending().length, 1);
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

test('everyday inspections seen refused behind an uncertain barrier are read-only', () => {
  for (const command of [
    'git status --short; echo rc=$?', 'cd C:/projetos/x && git log --oneline -1 | cat; echo st=$?', 'echo "exit $?"',
    'date', 'date +%H:%M:%S', 'date -u "+%Y-%m-%d"', 'ps -e', 'ps -eo pid,etime,args | grep node',
    'git stash list | head -3', 'git ls-remote origin refs/heads/main', 'git -C C:/projetos/x ls-remote --heads origin',
    "find C:/Users/swluc/.pi -maxdepth 1 -name '*.json' -mmin -60",
    "gh pr view 43 --json state,mergeStateStatus --jq '{state,auto:(.autoMergeRequest!=null)}'", 'gh pr list --state open --json number,title', 'gh pr checks 7', 'gh pr diff 7 --name-only',
    'gh run list --repo lennix1337/dotfiles --branch main --limit 2 --json databaseId,status,conclusion', 'gh run view 123 --log-failed | tail -20', 'gh issue view 5 --comments',
    "gh api repos/lennix1337/pi-optchat/pulls/43 --jq '{state,merged}'", 'gh auth status --hostname github.com',
  ]) assert.equal(isReadOnlyDiagnostic('bash', { command }), true, command);
});

// A CI log is read through `sed 's/^.*Z //'` to drop the timestamps; that one-substitution stream filter touches no file.
test('a single s/// stream filter behind a pipe is read-only; sed that can write, run or edit in place is not', () => {
  for (const command of [
    "gh run view 1 --repo a/b --log-failed 2>&1 | sed 's/^.*Z //' | grep -E '^not ok' | cut -c1-140",
    "gh run view 1 --log-failed | sed 's/[0-9]*m//g' | head -20", "git log --oneline | sed -E 's/^([a-f0-9]{7}) /X /'",
    "cat a.log | sed 's/a.b/c&d/gI' | head", "cat a.log | sed 's/a/b/' | sed 's/c/d/'",
  ]) assert.equal(isReadOnlyDiagnostic('bash', { command }), true, command);
  for (const command of [
    "sed 's/a/b/' file", "cat a | sed 's/a/b/w out'", "cat a | sed 's/a/b/e'", "cat a | sed 's/a/b/;w out'", "cat a | sed -i 's/a/b/'", "cat a | sed -i 's/a/b/' file",
    "cat a | sed 's/a/b/' file", "cat a | sed -s 's/a/b/'", "cat a | sed 'e touch x'", "cat a | sed 's/a/b/' > out", "cat a | sed -f script", "cat a | sed --in-place 's/a/b/'", "cat a | sed \"s/a/$(touch x)/\"",
    "cat a | sed 's/a/b/g;s/c/d/'", "cat a | sed 's/a/b/ ; w out'",
  ]) assert.equal(isReadOnlyDiagnostic('bash', { command }), false, command);
});

test('the wider inspections still refuse anything that writes, runs a helper or reaches an unknown expansion', () => {
  for (const command of [
    'echo $?x', 'echo $??', '$? file', 'echo \\$?', 'FOO=$? cat file',
    'date -s "2020-01-01"', 'date --set=2020-01-01', 'date 010100002020', 'ps -e > out', 'ps -e; touch x',
    'git stash', 'git stash drop', 'git stash list --output=x', 'git ls-remote --upload-pack=evil origin', 'git ls-remote --upload-pack evil origin', 'git ls-remote -o evil origin', 'git fetch origin',
    'find . -delete', 'find . -exec rm x +', 'find . -execdir rm x +', 'find . -exec rm {} ;', "find . -name '*.tmp' -execdir rm {} +", 'find . -ok rm {} ;', 'find . -fprint out', 'find . -fls out', 'find *',
    'gh pr merge 5', 'gh pr close 5', 'gh pr comment 5 --body hi', 'gh pr view 5 --web', 'gh pr view 5 -w', 'gh pr checkout 5', 'gh pr create', 'gh pr edit 5 --title x',
    'gh run rerun 5', 'gh run cancel 5', 'gh run download 5', 'gh issue close 5', 'gh issue create', 'gh repo delete x', 'gh release create v1', 'gh auth login', 'gh auth token',
    'gh api repos/x/y -X DELETE', 'gh api repos/x/y --method POST', 'gh api repos/x/y -f a=b', 'gh api repos/x/y -F a=b', 'gh api repos/x/y --input file', 'gh api graphql', 'gh api -XPOST repos/x/y', 'gh api repos/x/y -H "Accept: x" --field a=b',
    'gh pr view 5 --json state; gh pr merge 5', 'gh alias set x y', 'gh extension install x', 'gh pr view $(touch x)',
  ]) assert.equal(isReadOnlyDiagnostic('bash', { command }), false, command);
});

test('PowerShell inspections built only from read cmdlets are read-only; anything that writes or runs code is refused', () => {
  for (const command of [
    "powershell -NoProfile -Command 'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \"node.exe\" } | Select-Object ProcessId,CommandLine | Format-List'",
    "pwsh -NoProfile -NonInteractive -Command 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5'",
    "powershell.exe -NoProfile -Command 'Get-Content \"$env:USERPROFILE/.pi/agent/settings.json\" -Raw | ConvertFrom-Json | ConvertTo-Json'",
    "pwsh -NoProfile -Command '$s = Get-Content x.json -Raw | ConvertFrom-Json; $s.packages | ConvertTo-Json'",
    "pwsh -NoProfile -Command 'Get-Process | Where-Object { $_.Name -match \"a|b\" -and ($_.Id -gt 4) } | ForEach-Object { Write-Output $_.Id }'",
  ]) assert.equal(isReadOnlyDiagnostic('bash', { command }), true, command);
  for (const command of [
    "pwsh -NoProfile -Command 'Stop-Process -Id 5'", "pwsh -NoProfile -Command 'Get-Process | Stop-Process'", "pwsh -NoProfile -Command 'Get-Process | kill'",
    "pwsh -NoProfile -Command 'Get-Process | ForEach-Object { $_.Kill() }'", "pwsh -NoProfile -Command '[Diagnostics.Process]::Start(\"x\")'",
    "pwsh -NoProfile -Command 'Get-Content x | Out-File y'", "pwsh -NoProfile -Command 'Get-Content x > y'", "pwsh -NoProfile -Command 'Get-Content x | iex'",
    "pwsh -NoProfile -Command 'Get-Content x; del y'", "pwsh -NoProfile -Command 'Get-Content x && del y'", "pwsh -NoProfile -Command 'Get-Content x | Out-Null'", "pwsh -NoProfile -Command '& calc'", "pwsh -NoProfile -Command '. ./x.ps1'", "pwsh -NoProfile -Command '$x = del y'",
    "pwsh -NoProfile -Command 'Get-Process | % { del x }'", "pwsh -NoProfile -Command 'Get-Content \"$(del x)\"'",
    "pwsh -NoProfile -Command 'Get-Content x' extra", 'pwsh -NoProfile -File x.ps1', 'pwsh -NoProfile -EncodedCommand AAAA', 'pwsh -NoProfile', "pwsh -Command 'Get-Content x' -ExecutionPolicy Bypass",
    "pwsh -NoProfile -Command 'Get-Content x; $x.Invoke()'", "pwsh -NoProfile -Command '$x.(\"Kill\")()'", "pwsh -NoProfile -Command 'Get-Process; Start-Sleep 1; Set-Content a b'",
  ]) assert.equal(isReadOnlyDiagnostic('bash', { command }), false, command);
});
