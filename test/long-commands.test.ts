import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LONG_COMMAND_SECONDS, commandSegments, longCommandReason } from '../src/long-commands.ts';

// Long families seen in the OptChat main session's bash calls (scripts/delegation-stats.mjs and the duration table
// behind it: npm run, npm test, dotnet test, cargo build/test, wsl/pwsh wrappers, timeout N).
test('package scripts, suites, builds and runners are long', () => {
  for (const command of [
    'cd C:/projetos/Genexus18MCP && npm test',
    'npm test 2>&1 | tail -30; echo rc=$?',
    'npm ci',
    'npm run build:prod',
    'npm run check:types',
    'pnpm -r test',
    'yarn test',
    'bun test',
    'npx playwright test',
    'cargo build --release',
    'cargo test -p core',
    'dotnet test ./Tests.csproj',
    'go test ./...',
    'make all',
    'python -m pytest tests/',
    'node --test test/unit',
    'vitest run',
    'docker compose up -d',
    'docker build -t app .',
    'gh run watch 40194703121 --exit-status',
    'gh pr checks 685 --watch',
    '.\\build.ps1',
    'pwsh -NoProfile -File C:/projetos/Genexus18MCP/build.ps1',
  ]) assert.ok(longCommandReason(command), command);
});

test('shells that run a long command are classified by the command inside them', () => {
  assert.ok(longCommandReason('wsl.exe -e bash -lc "cd /mnt/c/projetos/x && npm test"'));
  assert.ok(longCommandReason('bash -lc \'npm ci\''));
  assert.ok(longCommandReason('powershell -NoProfile -Command "& ./build.ps1"'));
  assert.ok(longCommandReason('pwsh -NoProfile -Command "cargo test"'));
});

test('an explicit timeout above the limit is long, one at or below it is not', () => {
  assert.equal(LONG_COMMAND_SECONDS, 120);
  assert.match(longCommandReason('git status', 300) ?? '', /timeout 300/);
  assert.equal(longCommandReason('git status', 120), undefined);
  assert.equal(longCommandReason('git status', 30), undefined);
  assert.match(longCommandReason('timeout 300 gh run list') ?? '', /timeout 300/);
  assert.equal(longCommandReason('timeout 60 gh run list'), undefined);
  assert.match(longCommandReason('timeout 3m curl x') ?? '', /timeout 3m/);
  assert.equal(longCommandReason('timeout 2m curl x'), undefined);
  assert.match(longCommandReason('sleep 150; ls') ?? '', /sleep 150/);
  assert.equal(longCommandReason('sleep 2 && curl -s localhost:3000/health'), undefined);
});

test('short commands, probes and text that only mentions a long command stay synchronous', () => {
  for (const command of [
    'git status --short',
    'git -C C:/projetos/x log --oneline -5',
    'gh pr view 685 --json state',
    'gh pr checks 685',
    'npm view left-pad version',
    'npm test --help',
    'npm --version',
    'cargo fmt',
    'cargo test --list',
    'echo "npm test"',
    'grep -rn "npm test" docs',
    'git commit -m "fix: run npm ci before tests"',
    'ls -la && cat README.md',
    'npm run format:fix',
    'node scripts/delegation-stats.mjs',
    'sed -n 1,20p src/index.ts',
    'python3 -c "print(1)"',
    'timeout 60 gh run list',
    'docker ps',
    'gh pr merge 1 --squash',
  ]) assert.equal(longCommandReason(command), undefined, command);
});

test('a near-miss name is not a long subcommand', () => {
  assert.equal(longCommandReason('npm testing-helpers'), undefined);
  assert.equal(longCommandReason('npm run policy-report'), undefined);
  assert.equal(longCommandReason('cargo testcase'), undefined);
  assert.equal(longCommandReason('mytest --all'), undefined);
  assert.equal(longCommandReason('./scripts/deploy-testimony.sh'), undefined);
});

test('a command split by pipes, lists and newlines is classified per simple command', () => {
  assert.deepEqual(commandSegments('cd repo && npm  test | tail -2\nls "a b" ; echo x'), [['cd', 'repo'], ['npm', 'test'], ['tail', '-2'], ['ls', 'a b'], ['echo', 'x']]);
  assert.match(longCommandReason('ls && npm test') ?? '', /npm test/);
});
