import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bashHint, registerBashHints, HINT_INTERVAL } from '../src/bash-hints.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const raw = String.raw;

test('bash commands that patch or read source files get the native-tool kind of hint', () => {
  const cases: [string, 'edit' | 'read' | 'ripwire'][] = [
    [raw`python - <<'EOF'
from pathlib import Path
p = Path('src/a.ts'); p.write_text(p.read_text().replace('a', 'b'))
EOF`, 'edit'],
    [raw`python3 -c "open('src/app.py','w').write(open('src/app.py').read().replace('a','b'))"`, 'edit'],
    [raw`python -c "import pathlib; pathlib.Path('lib/x.js').write_text('x')"`, 'edit'],
    [raw`node -e "require('fs').writeFileSync('src/index.ts', 'x')"`, 'edit'],
    [raw`node - <<'EOF'
const fs = require('fs'); fs.writeFileSync('src/a.tsx', fs.readFileSync('src/a.tsx','utf8').replace('a','b'));
EOF`, 'edit'],
    ['sed -i s/a/b/ src/a.ts', 'edit'],
    ['sed -i.bak "s/a/b/" src/a.ts', 'edit'],
    ['sed -ni 1p src/a.ts', 'edit'],
    ['sed --in-place s/a/b/ src/main.go', 'edit'],
    ['perl -pi -e "s/a/b/" src/a.rs', 'edit'],
    ['perl -i.bak -pe "s/a/b/" src/a.py', 'edit'],
    ['sed -n 10,40p src/a.ts', 'read'],
    ["sed -n '5,9p' \"src/a b.ts\"", 'read'],
    ['sed -n 7p README.md', 'read'],
    ['cat src/a.ts', 'read'],
    ['cat C:/projetos/app/src/a.ts', 'read'],
    ['head -n 50 src/a.ts', 'read'],
    ['head -20 src/a.ts', 'read'],
    ['cd repo && sed -n 1,20p src/a.ts', 'read'],
    ['ripwire . --for "fix parser"', 'ripwire'],
    ['ripwire --grep foo', 'ripwire'],
    ['ripwire . --callers parse', 'ripwire'],
    ['ripwire . --callees parse', 'ripwire'],
    ['ripwire . --impact parse', 'ripwire'],
    ['ripwire . --edit-check src/a.ts', 'ripwire'],
    ['ripwire . --quality-delta', 'ripwire'],
    ['ripwire . --test-gate', 'ripwire'],
    ['cd repo && ripwire . --impact parse', 'ripwire'],
  ];
  for (const [command, kind] of cases) assert.equal(bashHint(command, true), kind, command);
});

test('near misses are not hinted', () => {
  const none = [
    // generated output and non-source targets
    raw`python -c "open('dist/bundle.js','w').write('x')"`,
    raw`python - <<'EOF'
open('build/out.js', 'w').write('x')
EOF`,
    'sed -i s/a/b/ dist/app.js',
    'sed -i s/a/b/ notes.txt',
    raw`python -c "open('result.json','w').write('{}')"`,
    // scripts that only print or read
    raw`python -c "print(open('src/a.py').read().replace('a','b'))"`,
    raw`python - <<'EOF'
import sys
sys.stdout.write(open('src/a.py').read())
EOF`,
    raw`python analyze.py src/a.py`,
    'node scripts/report.js src/a.ts',
    // not a script runner
    'echo x > src/a.ts',
    'tee src/a.ts',
    // not a single-file plain read
    'cat src/a.ts src/b.ts',
    'cat src/*.ts',
    'cat src/a.ts | head',
    'cat > src/a.ts',
    'cat -n src/a.ts',
    'head src/a.ts',
    'head -n 20 src/*.ts',
    'sed -n 1,20p src/a.ts src/b.ts',
    'sed -n /foo/p src/a.ts',
    'sed s/a/b/ src/a.ts',
    'grep -n foo src/a.ts src/b.ts',
    'grep -rn foo src',
    'rg foo src',
    // ripwire without a map flag
    'ripwire .',
    'ripwire . --json',
    'echo ripwire --for x',
    'git status',
    'npm test',
  ];
  for (const command of none) assert.equal(bashHint(command, true), undefined, command);
});

test('the ripwire hint needs the native ripwire tool to exist', () => {
  assert.equal(bashHint('ripwire . --for x', false), undefined);
  assert.equal(bashHint('ripwire . --for x', true), 'ripwire');
});

test('the edit hint wins over the read hint and ripwire hint', () => {
  assert.equal(bashHint('sed -i s/a/b/ src/a.ts', true), 'edit');
});

function harness(tools: string[] = []) {
  const hooks = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) { hooks.set(name, handler); },
    getAllTools: () => tools.map(name => ({ name })),
  } as unknown as ExtensionAPI;
  registerBashHints(pi);
  const ctx = (session: string) => ({ sessionManager: { getSessionId: () => session } });
  const result = (session: string, command: string, text = 'output', isError = false, toolName = 'bash') => hooks.get('tool_result')!(
    { toolName, toolCallId: 'c', input: { command }, content: [{ type: 'text', text }], isError }, ctx(session)) as { content: { type: string; text: string }[]; isError?: boolean } | undefined;
  return { hooks, ctx, result };
}

test('a hinted result keeps its text, appends one short line and does not set isError or exit code', () => {
  const { result } = harness();
  const patched = result('s', 'cat src/a.ts', 'line1\nline2')!;
  assert.equal(patched.content.length, 1);
  assert.match(patched.content[0].text, /^line1\nline2\nHint: use the native read tool with offset\/limit/);
  assert.equal(patched.content[0].text.split('\n').length, 3);
  assert.equal('isError' in patched, false);
  const failed = result('s2', 'cat src/missing.ts', 'cat: nope\n\nCommand exited with code 1', true)!;
  assert.match(failed.content[0].text, /^cat: nope\nHint: .*\n\nCommand exited with code 1$/);
  assert.equal('isError' in failed, false);
});

test('hint lines stay under about 30 tokens', () => {
  const { result } = harness(['ripwire']);
  for (const command of ['cat src/a.ts', 'sed -i s/a/b/ src/a.ts', 'ripwire . --for x']) {
    const line = result(`len-${command}`, command)!.content[0].text.split('\n')[1];
    assert.ok(line.split(/[\s/;(),]+/).length <= 30, line);
    assert.ok(line.length <= 170, line);
  }
});

test('the same hint is shown at most once per interval of bash calls, per session', () => {
  const { result } = harness();
  assert.ok(result('s', 'cat a.ts'));
  for (let call = 2; call <= HINT_INTERVAL; call++) assert.equal(result('s', 'cat a.ts'), undefined, `call ${call}`);
  assert.ok(result('s', 'cat a.ts'), 'again after the interval');
  assert.equal(result('s', 'cat a.ts'), undefined);
  // Other sessions have their own counters, and a different hint kind is limited independently.
  assert.ok(result('other', 'cat a.ts'));
  assert.ok(result('s', 'sed -i s/a/b/ src/a.ts'));
  assert.equal(result('s', 'sed -i s/a/b/ src/b.ts'), undefined);
});

test('unrelated bash calls count toward the interval and other tools are ignored', () => {
  const { result } = harness();
  assert.ok(result('s', 'cat a.ts'));
  for (let call = 2; call <= HINT_INTERVAL; call++) assert.equal(result('s', 'echo hi'), undefined);
  assert.ok(result('s', 'cat a.ts'));
  assert.equal(result('t', 'cat a.ts', 'x', false, 'read'), undefined);
  assert.equal(result('t', 'cat a.ts', 'x', false, 'read'), undefined);
  assert.ok(result('t', 'cat a.ts'), 'non-bash results are not counted and do not use up the hint');
});

test('a result without text still receives the hint and a missing command is ignored', () => {
  const { hooks, ctx } = harness();
  const patched = hooks.get('tool_result')!({ toolName: 'bash', toolCallId: 'c', input: { command: 'cat a.ts' }, content: [], isError: false }, ctx('s')) as { content: { text: string }[] };
  assert.match(patched.content[0].text, /^Hint:/);
  assert.equal(hooks.get('tool_result')!({ toolName: 'bash', toolCallId: 'c', input: {}, content: [], isError: false }, ctx('s')), undefined);
});

test('shutdown clears the session counter', () => {
  const { hooks, ctx, result } = harness();
  assert.ok(result('s', 'cat a.ts'));
  assert.equal(result('s', 'cat a.ts'), undefined);
  hooks.get('session_shutdown')!({}, ctx('s'));
  assert.ok(result('s', 'cat a.ts'));
});
