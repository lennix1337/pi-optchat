import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Every temp dir made through os.tmpdir() lands in this root, removed at exit. It also takes what a test's own cleanup misses: Pi rewrites auth.json after a test removed its dir, and a worker thread loads this file again but is terminated before 'exit'.
// macOS's default tmpdir is ~49 chars, and the extra level would push profile lock-socket paths past the 103-byte limit, so the outermost root goes under /tmp there. A child process or worker thread nests inside its parent's root, so it goes away with it even if it never reaches 'exit'.
const nested = basename(tmpdir()).startsWith('optchat-test-');
const root = mkdtempSync(join(process.platform === 'darwin' && !nested ? '/tmp' : tmpdir(), 'optchat-test-'));
for (const name of ['TMPDIR', 'TEMP', 'TMP']) process.env[name] = root;
// os.homedir() reads HOME on POSIX and USERPROFILE on Windows, so both are sandboxed: no test may touch the user's real ~/.optchat or ~/.pi.
for (const name of ['HOME', 'USERPROFILE', 'OPTCHAT_HOME', 'PI_CODING_AGENT_DIR']) process.env[name] = mkdtempSync(join(root, `optchat-${name.toLowerCase()}-`));
// The operator's own settings must not change test behavior; OPTCHAT_EFFECT_APPROVALS=risk would gate fixture subagent calls.
for (const name of ['OPTCHAT_PROFILE', 'OPTCHAT_REFRESH_AT', 'OPTCHAT_EFFECT_APPROVALS']) delete process.env[name];

/** Removes a test's temp dir. On Windows a process that just exited can hold its cwd a moment longer than `process.kill(pid, 0)` admits, so rmdir fails with EBUSY (#164). rmSync's own `maxRetries` doesn't cover that: it retries only after ENOTEMPTY, not a first rmdir that fails EBUSY. Under the full suite's load the hold outlasted ten 100 ms waits (headless.test.ts EPERM, 2026-10-25), so each wait grows: 5.5 s in all. */
export function removeDir(path: string) {
  for (let attempt = 1; ; attempt++) {
    try { return rmSync(path, { recursive: true, force: true }); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === 10 || !(code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * attempt);
    }
  }
}

/** A fresh temp dir under the sandboxed root for one test; `close` removes it, and a test that fails before closing is still swept at exit. */
export function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, close: () => removeDir(dir) };
}

/** Runs `run` with a fresh temp dir and removes it afterwards, whether `run` is synchronous or returns a promise, and whether it throws or rejects. */
export function withTempDir<T>(prefix: string, run: (dir: string) => T): T {
  const { dir, close } = tempDir(prefix);
  let result: T;
  try { result = run(dir); } catch (error) { close(); throw error; }
  if (!(result instanceof Promise)) { close(); return result; }
  return result.finally(close) as T;
}

/** Whether a fixture model's call is a compaction: it has the same system prompt as a turn, so only its task marks it. */
export const isCompaction = (context: { messages: readonly { role: string; content?: unknown }[] }) =>
  context.messages.some(message => message.role === 'user' && /Compaction: (?:compress message|merge lines)/.test(JSON.stringify(message.content)));

process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* EBUSY on Windows: leave it */ } });
