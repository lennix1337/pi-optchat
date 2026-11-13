import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { followDurable, launchDurable, pendingDurable } from '../src/durable-shells.ts';
import { ShellJobs, resumeDurableShells } from '../src/shells.ts';
import { tempDir } from './support.ts';

const job = (id: string, command: string, cwd: string) => ({ id, command, cwd, started: Date.now(), notify: 'end' as const });

test('a durable shell outlives the process that launched it and is followed again, once, by the next one', { timeout: 60_000 }, async () => {
  const temp = tempDir('durable-'), root = join(temp.dir, 'shells');
  try {
    // A separate Node process launches the shell and exits at once: the Pi crash or quit case.
    const launcher = `import { launchDurable } from ${JSON.stringify(new URL('../src/durable-shells.ts', import.meta.url).href)};
launchDurable(${JSON.stringify(root)}, { id: 'crash', command: 'sleep 2; echo fim; exit 3', cwd: ${JSON.stringify(temp.dir)}, started: Date.now(), notify: 'end' });`;
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', launcher], { stdio: 'ignore' });
    const [pending, ...rest] = pendingDurable(root);
    assert.equal(pending?.id, 'crash');
    assert.deepEqual(rest, []);
    const jobs = new ShellJobs();
    assert.deepEqual(resumeDurableShells(jobs, { durableDir: () => root }), ['crash']);
    assert.deepEqual(resumeDurableShells(jobs, { durableDir: () => root }), [], 'an already followed shell is not followed twice');
    const ended = await jobs.settle('crash', 20_000);
    assert.equal(ended?.exitCode, 3);
    assert.match(ended?.output ?? '', /fim/);
    assert.deepEqual(pendingDurable(root), [], 'its end is reported once');
  } finally { temp.close(); }
});

test('a durable shell whose process vanished without an exit code is reported as lost, not as success', { timeout: 30_000 }, async () => {
  const temp = tempDir('durable-'), root = join(temp.dir, 'shells');
  try {
    const record = launchDurable(root, job('lost', 'sleep 30', temp.dir));
    const result = followDurable(root, { ...record, pid: 2 ** 22 + 7 }, new AbortController().signal, () => {}, { pollMs: 50 });
    const ended = await result;
    assert.equal(ended.failed, true);
    assert.match(ended.output, /without recording an exit code/);
    const stop = new AbortController();
    const following = followDurable(root, record, stop.signal, () => {}, { pollMs: 50 });
    stop.abort();
    await assert.rejects(following, /aborted/);
  } finally { temp.close(); }
});
