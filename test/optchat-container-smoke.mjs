import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { freemem, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// This entry point is deliberately offline-only. Never copy credentials or mount the checkout.
export const contextFiles = ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'test/headless.test.ts', 'test/support.ts',
  'test/optchat-container-agent.ts', 'test/optchat-model-bridge.ts'];
export const dockerfile = `FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
USER node
ENV HOME=/tmp/home PI_CODING_AGENT_DIR=/tmp/agent OPTCHAT_HOME=/tmp/optchat
CMD ["node", "--import", "tsx", "--test", "test/headless.test.ts"]
`;

export function assertSmokeGate(activeContainers, freeBytes, sharedOfflineSmoke = false) {
  if (activeContainers.trim() && !sharedOfflineSmoke) throw new Error('Blocked: another Docker container is running; leave it untouched.');
  if (!Number.isFinite(freeBytes) || freeBytes < 5 * 1024 ** 3) throw new Error('Blocked: at least 5 GiB free host RAM required.');
}

export function smokeArgs(image, name) {
  if (!/^optchat-smoke-[a-f0-9-]+$/.test(name) || image !== `${name}:local`) throw new Error('Invalid disposable smoke identity');
  return ['run', '--name', name, '--network', 'none', '--memory', '4g', '--memory-swap', '4g', '--cpus', '4',
    '--pids-limit', '256', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,size=512m', image];
}

export function stageContext(repo, destination) {
  for (const file of contextFiles) {
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    cpSync(join(repo, file), join(destination, file), { recursive: true, dereference: false });
  }
  writeFileSync(join(destination, 'Dockerfile'), dockerfile);
}

export function main(args) {
  if (args.length !== 1 || !['--preflight', '--run', '--run-offline-shared'].includes(args[0])) throw new Error('Use --preflight, --run or --run-offline-shared (synthetic provider only; no inference).');
  // Functional acceptance may coexist with services; this mode never produces benchmark measurements.
  const sharedOfflineSmoke = args[0] === '--run-offline-shared';
  const docker = (args, timeout = 30_000) => execFileSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 ** 2 });
  assertSmokeGate(docker(['ps', '-q']), freemem(), sharedOfflineSmoke);
  console.log(sharedOfflineSmoke
    ? 'Shared-host functional smoke only: no performance comparison, OAuth or model requests; other containers untouched.'
    : 'Isolation gate passed; synthetic real-OptChat smoke only, no OAuth or model requests.');
  if (args[0] === '--preflight') return;
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const context = mkdtempSync(join(tmpdir(), 'optchat-container-'));
  const name = `optchat-smoke-${randomUUID()}`, image = `${name}:local`;
  try {
    stageContext(repo, context);
    console.log(docker(['build', '--tag', image, context], 600_000));
    // Recheck immediately before execution: building does not reserve the isolation slot.
    assertSmokeGate(docker(['ps', '-q']), freemem(), sharedOfflineSmoke);
    console.log(docker(smokeArgs(image, name), 120_000));
  } finally {
    // Only unique task-created identities are touched, including after timeouts.
    try { docker(['rm', '--force', name]); } catch (error) { console.error('Container cleanup:', error.message); }
    try { docker(['image', 'rm', image]); } catch (error) { console.error('Image cleanup:', error.message); }
    rmSync(context, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
