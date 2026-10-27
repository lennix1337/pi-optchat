// Load the installed SDK in a child before support.ts sandboxes HOME. No live profile or provider credentials.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const version = readFileSync(join(homedir(), '.pi/agent/install/current-version'), 'utf8').trim();
if (!/^[\w.+-]+$/.test(version)) throw new Error('Invalid installed SDK version');
const entry = join(homedir(), '.pi/agent/install/releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js');
const env = { ...process.env, OPTCHAT_TEST_PI_ENTRY: entry };
for (const key of Object.keys(env)) if (/TOKEN|API_KEY|SECRET|PASSWORD/i.test(key)) delete env[key];
const child = spawnSync(process.execPath, ['--import', 'tsx', '--import', './test/support.ts', '--test', 'test/self-reload-runtime.test.ts'], {
  cwd: new URL('..', import.meta.url), env, stdio: 'inherit', timeout: 30000,
});
if (child.error) throw child.error;
if (child.signal || child.status === null) throw new Error(`Installed reload fixture did not complete: ${child.signal ?? 'unknown status'}`);
process.exitCode = child.status;
