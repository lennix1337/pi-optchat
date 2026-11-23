import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// external: Pi can rewrite auth.json after test cleanup, and terminated worker threads do not emit exit.
// external: macOS Unix socket paths have a short length limit.
const nested = basename(tmpdir()).startsWith('optchat-test-');
const root = mkdtempSync(join(process.platform === 'darwin' && !nested ? '/tmp' : tmpdir(), 'optchat-test-'));
for (const name of ['TMPDIR', 'TEMP']) process.env[name] = root;
// external: Git Bash shares the /tmp mount chosen by the first running shell; Node tmpdir reads TEMP.
process.env.TMP = process.env.TMP || root;
// external: Node os.homedir reads HOME on POSIX and USERPROFILE on Windows.
for (const name of ['HOME', 'USERPROFILE', 'OPTCHAT_HOME', 'PI_CODING_AGENT_DIR']) process.env[name] = mkdtempSync(join(root, `optchat-${name.toLowerCase()}-`));


process.env.OPTCHAT_WINPATH_GUARD = 'off';
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

/** A stand-in for Pi's extension API that records `pi.on` handlers; `fire` runs the one registered for an event. */
export function hookedPi() {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const pi = { on: (name: string, handler: (event: unknown) => unknown) => { handlers.set(name, handler); }, registerTool: () => {}, sendUserMessage: () => {} };
  return { pi: pi as never, fire: (name: string, event: unknown = {}) => handlers.get(name)!(event) };
}

/** Fires an ordinary successful `read` result and returns what the hooks appended to it, if anything. */
export const plainToolResult = (fire: (name: string, event: Record<string, unknown>) => unknown) =>
  fire('tool_result', { toolName: 'read', toolCallId: 'r', input: {}, isError: false, content: [{ type: 'text', text: 'x' }] }) as { content: { text: string }[] } | undefined;

/** Whether a fixture model's call is a compaction: it has the same system prompt as a turn, so only its task marks it. */
export const isCompaction = (context: { messages: readonly { role: string; content?: unknown }[] }) =>
  context.messages.some(message => message.role === 'user' && /Compaction: (?:compress message|merge lines)/.test(JSON.stringify(message.content)));

process.on('exit', () => { try { rmSync(root, { recursive: true, force: true }); } catch {    } });

/** Event-loop stall meter for a hang dump: the largest gap (ms) between 50 ms ticks tells a starved runner from a real deadlock. */
export function loopLag() {
  let last = Date.now(), max = 0;
  const timer = setInterval(() => { const now = Date.now(); max = Math.max(max, now - last - 50); last = now; }, 50); timer.unref();
  return { max: () => max, stop: () => clearInterval(timer) };
}
