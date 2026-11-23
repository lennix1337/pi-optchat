import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  configProtectGuard,
  detectConfigWeakening,
  registerConfigProtectGuard,
} from '../src/config-protect-guard.ts';

const edit = (path: string, oldText: string, newText: string) => ({
  name: 'edit',
  arguments: { path, edits: [{ oldText, newText }] },
});

const write = (path: string, content: string) => ({
  name: 'write',
  arguments: { path, content },
});

const bash = (command: string) => ({
  name: 'bash',
  arguments: { command },
});

test('weakening lint config or ignore files is refused once with what was weakened; identical retry passes', () => {
  const guard = configProtectGuard();
  const disableRule = edit('eslint.config.mjs', "'no-unused-vars': 'error'", "'no-unused-vars': 'off'");
  const reason = guard.check(disableRule);
  assert.ok(reason, 'expected refusal');
  assert.match(reason, /^Não executado:/);
  assert.match(reason, /eslint\.config\.mjs/i);
  assert.match(reason, /lint/i);
  assert.equal(guard.check(disableRule), undefined, 'identical retry should pass');

  const downgradeRule = edit('.eslintrc.json', '"no-console": "error"', '"no-console": "warn"');
  assert.match(guard.check(downgradeRule) ?? '', /\.eslintrc\.json/i);

  const numericOff = edit('.eslintrc.cjs', 'eqeqeq: 2', 'eqeqeq: 0');
  assert.match(guard.check(numericOff) ?? '', /\.eslintrc\.cjs/i);

  const biomeOff = edit('biome.json', '"noExplicitAny": "error"', '"noExplicitAny": "off"');
  assert.match(guard.check(biomeOff) ?? '', /biome\.json/i);

  const ruffIgnore = edit('ruff.toml', 'select = ["E", "F"]', 'select = ["E", "F"]\nignore = ["E501"]');
  assert.match(guard.check(ruffIgnore) ?? '', /ruff\.toml/i);

  const ignoreFile = edit('.eslintignore', 'dist/\n', 'dist/\nsrc/legacy.ts\n');
  assert.match(guard.check(ignoreFile) ?? '', /\.eslintignore/i);

  const writeWeakLint = write('.eslintrc.json', '{"rules": {"no-eval": "off"}}');
  assert.match(guard.check(writeWeakLint) ?? '', /\.eslintrc\.json/i);
});

test('weakening tsconfig strictness is refused with the weakened option', () => {
  const guard = configProtectGuard();

  const strictFalse = edit('tsconfig.json', '"strict": true,', '"strict": false,');
  const reason = guard.check(strictFalse);
  assert.ok(reason);
  assert.match(reason, /tsconfig\.json/i);
  assert.match(reason, /strict/i);
  assert.equal(guard.check(strictFalse), undefined);

  const implicitAny = edit('tsconfig.build.json', '"strict": true', '"strict": true,\n"noImplicitAny": false');
  assert.match(guard.check(implicitAny) ?? '', /noImplicitAny/i);

  const removeStrict = edit('tsconfig.json', '"strict": true,\n"target": "ES2022"', '"target": "ES2022"');
  assert.match(guard.check(removeStrict) ?? '', /strict/i);

  const noCheck = edit('tsconfig.json', '"noEmit": true', '"noEmit": true,\n"noCheck": true');
  assert.match(guard.check(noCheck) ?? '', /noCheck/i);

  const writeWeakTsconfig = write('tsconfig.json', '{"compilerOptions": {"strictNullChecks": false}}');
  assert.match(guard.check(writeWeakTsconfig) ?? '', /strictNullChecks/i);
});

test('weakening test timeouts, retries, or skips is refused', () => {
  const guard = configProtectGuard();

  const raiseTimeout = edit('test/a.test.ts', 'timeout: 1000', 'timeout: 5000');
  const reason = guard.check(raiseTimeout);
  assert.ok(reason);
  assert.match(reason, /test\/a\.test\.ts/);
  assert.match(reason, /timeout/i);
  assert.equal(guard.check(raiseTimeout), undefined);

  const addSkip = edit('test/a.test.ts', "test('works', () => {", "test.skip('works', () => {");
  assert.match(guard.check(addSkip) ?? '', /skip/i);

  const addRetry = edit('src/__tests__/a.spec.ts', 'run()', 'retry(run)');
  assert.match(guard.check(addRetry) ?? '', /retry/i);

  const raiseRetries = edit('playwright.config.ts', 'retries: 0,', 'retries: 3,');
  assert.match(guard.check(raiseRetries) ?? '', /retr/i);

  const raiseCheckTimeout = edit('.pi/checks.json', '"timeoutMs": 30000', '"timeoutMs": 120000');
  assert.match(guard.check(raiseCheckTimeout) ?? '', /timeout/i);

  const writeSkippedTest = write('test/new.test.ts', "import { test } from 'node:test';\ntest.skip('x', () => {});\n");
  assert.match(guard.check(writeSkippedTest) ?? '', /skip/i);
});

test('adding eslint-disable or inline suppression directives is refused', () => {
  const guard = configProtectGuard();

  const eslintDisable = edit('src/app.ts', 'const x = fn();', '// eslint-disable-next-line no-undef\nconst x = fn();');
  const reason = guard.check(eslintDisable);
  assert.ok(reason);
  assert.match(reason, /src\/app\.ts/);
  assert.match(reason, /eslint-disable/i);
  assert.equal(guard.check(eslintDisable), undefined);

  const tsIgnore = edit('src/app.ts', 'return value;', '// @ts-ignore\nreturn value;');
  assert.match(guard.check(tsIgnore) ?? '', /@ts-ignore/i);

  const tsNocheck = write('src/legacy.ts', '// @ts-nocheck\nexport const x = 1;\n');
  assert.match(guard.check(tsNocheck) ?? '', /@ts-nocheck/i);

  const biomeIgnore = edit('src/app.ts', 'const y = 1;', '// biome-ignore lint/suspicious/noExplicitAny: temp\nconst y = 1;');
  assert.match(guard.check(biomeIgnore) ?? '', /biome-ignore/i);
});

test('weakening CI required checks in workflows or bash is refused', () => {
  const guard = configProtectGuard();

  const continueOnError = edit(
    '.github/workflows/ci.yml',
    '- name: Test\n  run: npm test',
    '- name: Test\n  continue-on-error: true\n  run: npm test',
  );
  const reason = guard.check(continueOnError);
  assert.ok(reason);
  assert.match(reason, /\.github\/workflows\/ci\.yml/);
  assert.match(reason, /continue-on-error/i);
  assert.equal(guard.check(continueOnError), undefined);

  const orTrue = edit('.github/workflows/ci.yml', 'run: npm run check', 'run: npm run check || true');
  assert.match(guard.check(orTrue) ?? '', /\|\|\s*true|ci/i);

  const disabledJob = edit('.github/workflows/ci.yml', 'runs-on: ubuntu-latest', 'if: false\n    runs-on: ubuntu-latest');
  assert.match(guard.check(disabledJob) ?? '', /if:\s*false/i);

  const commentedCheck = edit('.github/workflows/ci.yml', '      - run: npm run check', '      # - run: npm run check');
  assert.match(guard.check(commentedCheck) ?? '', /ci\.yml/i);

  assert.match(guard.check(bash('git commit --no-verify -m "wip"')) ?? '', /--no-verify/i);
  assert.match(guard.check(bash('git commit -nm "wip"')) ?? '', /--no-verify|-n/i);
  assert.match(guard.check(bash('git push --no-verify origin main')) ?? '', /--no-verify/i);
  assert.match(guard.check(bash('gh pr merge 42 --admin')) ?? '', /--admin/i);
  assert.match(guard.check(bash('gh api -X DELETE repos/org/repo/branches/main/protection')) ?? '', /protection/i);
  assert.match(guard.check(bash('rm .eslintrc.json')) ?? '', /\.eslintrc\.json/i);
  assert.match(guard.check(bash('echo "src/a.ts" >> .eslintignore')) ?? '', /\.eslintignore/i);
  assert.match(guard.check(bash('sed -i \'s/"strict": true/"strict": false/\' tsconfig.json')) ?? '', /tsconfig\.json/i);
});

test('neutral and tightening edits, writes, and bash commands are allowed', () => {
  const guard = configProtectGuard();

  assert.equal(guard.check(edit('eslint.config.mjs', "'no-console': 'warn'", "'no-console': 'error'")), undefined);
  assert.equal(guard.check(edit('.eslintrc.json', '"ecmaVersion": 2022', '"ecmaVersion": 2024')), undefined);
  assert.equal(guard.check(write('.eslintrc.json', '{"rules": {"no-eval": "error"}}')), undefined);
  assert.equal(guard.check(edit('.eslintignore', 'dist/\nsrc/legacy.ts\n', 'dist/\n')), undefined);

  assert.equal(guard.check(edit('tsconfig.json', '"strict": false,', '"strict": true,')), undefined);
  assert.equal(guard.check(edit('tsconfig.json', '"target": "ES2022"', '"target": "ES2024"')), undefined);

  assert.equal(guard.check(edit('test/a.test.ts', 'timeout: 2000', 'timeout: 1000')), undefined);
  assert.equal(guard.check(edit('test/a.test.ts', "test.skip('x', () => {", "test('x', () => {")), undefined);
  assert.equal(guard.check(edit('test/a.test.ts', 'assert.equal(a, 1)', 'assert.equal(a, 2)')), undefined);
  assert.equal(guard.check(edit('src/http.ts', 'timeout: 1000', 'timeout: 5000')), undefined);

  assert.equal(guard.check(edit('src/app.ts', '// eslint-disable-next-line no-undef\nconst a = 1;', '// eslint-disable-next-line no-undef\nconst a = 2;')), undefined);
  assert.equal(guard.check(edit('src/app.ts', '// eslint-disable-next-line no-undef\nconst a = 1;', 'const a = 1;')), undefined);
  assert.equal(guard.check(edit('README.md', 'Checks:', 'Checks: avoid // eslint-disable-next-line')), undefined);

  assert.equal(guard.check(edit('.github/workflows/ci.yml', 'actions/checkout@v4', 'actions/checkout@v5')), undefined);
  assert.equal(guard.check(edit('.github/workflows/ci.yml', 'continue-on-error: true', 'continue-on-error: false')), undefined);

  assert.equal(guard.check(bash('git commit -m "never use --no-verify or --admin"')), undefined);
  assert.equal(guard.check(bash('git commit --amend --no-edit')), undefined);
  assert.equal(guard.check(bash('gh pr merge 42 --squash')), undefined);
  assert.equal(guard.check(bash('gh api repos/org/repo/branches/main/protection')), undefined);
  assert.equal(guard.check(bash('cat tsconfig.json')), undefined);
  assert.equal(guard.check(bash('sed -i \'s/"strict": false/"strict": true/\' tsconfig.json')), undefined);
  assert.equal(guard.check(bash('npm run check')), undefined);
});

test('OPTCHAT_CONFIG_PROTECT=off disables the guard', () => {
  const guard = configProtectGuard({ env: { OPTCHAT_CONFIG_PROTECT: 'off' } });
  assert.equal(guard.check(edit('tsconfig.json', '"strict": true', '"strict": false')), undefined);

  const handlers: Record<string, (event: any, ctx?: any) => any> = {};
  registerConfigProtectGuard(
    { on: (event, handler) => { handlers[event] = handler; } },
    { env: { OPTCHAT_CONFIG_PROTECT: 'off' } },
  );
  assert.equal(handlers.tool_call, undefined);
});

test('options have neutral defaults and support extraProtectedFiles and disabledCategories', () => {
  assert.equal(detectConfigWeakening(edit('custom-lint.json', '"rule": "error"', '"rule": "off"')).length, 0);
  assert.equal(
    detectConfigWeakening(
      edit('custom-lint.json', '"rule": "error"', '"rule": "off"'),
      { extraProtectedFiles: ['custom-lint.json'] },
    ).length,
    1,
  );
  assert.equal(
    detectConfigWeakening(
      edit('tsconfig.json', '"strict": true', '"strict": false'),
      { disabledCategories: ['tsconfig-strictness'] },
    ).length,
    0,
  );
});

test('registers on tool_call, blocks once with reason, and lets identical retry through', () => {
  const handlers: Record<string, (event: any, ctx?: any) => any> = {};
  registerConfigProtectGuard({ on: (event, handler) => { handlers[event] = handler; } });
  const event = {
    toolName: 'edit',
    input: { path: 'tsconfig.json', edits: [{ oldText: '"strict": true', newText: '"strict": false' }] },
  };
  const first = handlers.tool_call!(event);
  assert.equal(first?.block, true);
  assert.match(first?.reason ?? '', /tsconfig\.json/i);
  assert.match(first?.reason ?? '', /strict/i);
  const second = handlers.tool_call!(event);
  assert.equal(second, undefined);
});
