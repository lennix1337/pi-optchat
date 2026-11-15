// Full local suites share an OS-owned lock across worktrees; no stale PID files.
import { createServer, createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { availableParallelism } from 'node:os';

const PORT = 47821;
const OWNER = 'pi-optchat-suite-v1\n';
export const TEST_CONCURRENCY = Math.min(4, Math.max(1, availableParallelism() - 1));

async function listen(port) {
  const server = createServer(socket => { socket.on('error', () => socket.destroy()); socket.end(OWNER, () => socket.destroy()); });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
    });
    server.removeAllListeners('error');
    return server;
  } catch (error) {
    server.close();
    throw error;
  }
}

async function checkOwner(port) {
  await new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let text = '';
    socket.setTimeout(2000, () => socket.destroy(new Error(`Suite lock on port ${port} did not respond`)));
    socket.on('data', data => { text += data; if (text.length > OWNER.length) socket.destroy(new Error(`Port ${port} is not a pi-optchat suite lock`)); });
    socket.on('end', () => { socket.destroy(); text === OWNER ? resolve() : reject(new Error(`Port ${port} is not a pi-optchat suite lock`)); });
    socket.on('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error)); // Owner exited between bind and probe.
  });
}

export async function withSuiteLock(work, { port = PORT, waiting = () => console.error('Another pi-optchat suite is running; waiting for it to finish...') } = {}) {
  let server, announced = false;
  while (!server) {
    try { server = await listen(port); }
    catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      await checkOwner(port);
      if (!announced) { waiting(); announced = true; }
      await delay(250);
    }
  }
  try { return await work(server.address().port); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

export function commands(testOnly, extra = []) {
  return [
    ...testOnly ? [] : [[fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '--noEmit']],
    ['--experimental-transform-types', '--import', './test/support.ts', '--test', `--test-concurrency=${TEST_CONCURRENCY}`, ...extra, 'test/*.test.ts'],
  ];
}

async function runNode(args) {
  const child = spawn(process.execPath, args, { stdio: 'inherit' });
  const interrupt = signal => child.kill(signal);
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => signal ? reject(new Error(`Verification interrupted by ${signal}`)) : resolve(code));
    });
  } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }
}

export async function verify(testOnly, extra = [], run = runNode) {
  return withSuiteLock(async () => {
    for (const args of commands(testOnly, extra)) {
      const code = await run(args);
      if (code !== 0) return code;
    }
    return 0;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const testOnly = args[0] === '--test-only';
  if (testOnly) args.shift();
  process.exitCode = await verify(testOnly, args);
}
