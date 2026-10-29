import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const assistant = dirname(dirname(fileURLToPath(import.meta.url)));
const root = mkdtempSync(join(tmpdir(), 'assistant-store-mutations-'));
const mutations = [
  ['initial task profile guard', 'src/store/db.ts', "task.profileId !== this.profileId || !['suggested', 'queued']", "!['suggested', 'queued']", 'ownership.test.ts', 'profile filters isolate', /Missing expected exception/],
  ['event profile guard', 'src/store/db.ts', 'event.profileId !== this.profileId || ', '', 'ownership.test.ts', 'profile filters isolate', /Missing expected exception/],
  ['get profile filter', 'src/store/db.ts', "this.taskRow('SELECT snapshot FROM tasks WHERE profile = ? AND id = ?', taskId)", "this.db.prepare('SELECT snapshot FROM tasks WHERE id = ?').get(taskId)", 'ownership.test.ts', 'profile filters isolate', /Expected values to be strictly equal/],
  ['list profile filter', 'src/store/db.ts', "'SELECT snapshot FROM tasks WHERE profile = ? AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?').all(this.profileId, cursor, cursor, limit + 1)", "'SELECT snapshot FROM tasks WHERE (? IS NULL OR id > ?) ORDER BY id LIMIT ?').all(cursor, cursor, limit + 1)", 'ownership.test.ts', 'profile filters isolate', /Expected values to be strictly deep-equal/],
  ['events profile filter', 'src/store/db.ts', "'SELECT payload FROM events WHERE profile = ? AND sequence > ? ORDER BY sequence LIMIT ?').all(this.profileId, afterSequence, limit)", "'SELECT payload FROM events WHERE sequence > ? ORDER BY sequence LIMIT ?').all(afterSequence, limit)", 'ownership.test.ts', 'profile filters isolate', /Expected values to be strictly deep-equal/],
  ['transition revision guard', 'src/contracts/tasks.ts', 'task.revision !== expectedRevision || ', '', 'ownership.test.ts', 'stale transition revision', /Missing expected exception/],
  ['response revision guard', 'src/contracts/tasks.ts', 'response.revision !== task.revision || ', '', 'tasks.test.ts', 'stale response revisions', /Missing expected exception/],
  ['response inputRevision guard', 'src/contracts/tasks.ts', ' || response.inputRevision !== task.inputRevision', '', 'tasks.test.ts', 'stale response revisions', /Missing expected exception/],
  ['event ID deduplication', 'src/store/db.ts', ', UNIQUE(profile,event_id)', '', 'ownership.test.ts', 'profile scope, conflicts', /Missing expected exception/],
  ['source ID deduplication', 'src/store/db.ts', ', UNIQUE(profile,source_id)', '', 'ownership.test.ts', 'profile scope, conflicts', /Missing expected exception/],
  ['sequence admission', 'src/store/db.ts', "if (event.sequence !== this.nextSequence()) throw new TypeError('Invalid event sequence');", '', 'ownership.test.ts', 'profile scope, conflicts', /Missing expected exception/],
];
function run(dir, file, name) {
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern', name, join(dir, 'test', file)], { encoding: 'utf8' });
  if (result.error || result.signal) throw new Error(`Test process failed to run: ${result.error ?? result.signal}`);
  return { status: result.status, output: result.stdout + result.stderr };
}
try {
  const baseline = join(root, 'baseline'); cpSync(join(assistant, 'src'), join(baseline, 'src'), { recursive: true }); cpSync(join(assistant, 'test'), join(baseline, 'test'), { recursive: true });
  for (const file of ['tasks.test.ts', 'ownership.test.ts']) {
    const result = run(baseline, file, '.');
    if (result.status !== 0) throw new Error(`Baseline ${file} failed:\n${result.output}`);
    console.log(`baseline ${file}: passed`);
  }
  for (const [index, [name, file, before, after, testFile, testName, expected]] of mutations.entries()) {
    const dir = join(root, `mutation-${index}`);
    cpSync(baseline, dir, { recursive: true });
    const path = join(dir, file); const source = readFileSync(path, 'utf8');
    if (source.split(before).length !== 2) throw new Error(`${name}: mutation anchor not unique`);
    writeFileSync(path, source.replace(before, after));
    const result = run(dir, testFile, testName);
    if (result.status === 0 || !expected.test(result.output)) throw new Error(`${name}: mutation not detected as intended:\n${result.output}`);
    console.log(`${name}: detected (${expected.source})`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
