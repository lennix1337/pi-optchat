import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ModelChoice } from './compactor.ts';
import { record } from './cache.ts';
import { atomicWrite } from './memory.ts';
import { DEFAULT_SETTINGS, readSettings, type Settings } from './settings.ts';

export const dataHome = () => resolve(process.env.OPTCHAT_HOME ?? join(homedir(), '.optchat'));
export type Role = 'compactor' | 'subagent';
/** alternates: per-provider models a role uses while the main model is on that provider, e.g. a Codex model on a Codex account. */
export interface ProfileConfig extends Settings { compactor: ModelChoice; subagent: ModelChoice; alternates?: Partial<Record<Role, ModelChoice[]>> }
/** The main model the roles follow, as Pi's model_select reports it. */
export interface MainModel { provider: string; model: string }
export const defaults: ProfileConfig = {
  compactor: { provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'xhigh' }, // The recipe's: a cheap model at xhigh effort.
  subagent: { provider: 'anthropic', model: 'claude-opus-5-5', thinking: 'high' },
  ...DEFAULT_SETTINGS,
};
export const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export function profilePath(name: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Profile names: 1–64 lowercase letters, digits, hyphens, or underscores.');
  return join(dataHome(), 'profiles', name);
}
export function listProfiles() {
  const root = join(dataHome(), 'profiles');
  return existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(f => f.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.name)).map(f => f.name).sort() : [];
}
export function createProfile(name: string) {
  const dir = profilePath(name);
  if (existsSync(dir)) throw new Error(`Profile already exists: ${name}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  saveConfig(dir, defaults);
  atomicWrite(join(dir, 'AGENTS.md'), `# ${name}\n\nThis is the ${name} profile.\nAdd your personal instructions here.\n`);
}
export function saveConfig(dir: string, config: ProfileConfig) { atomicWrite(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n'); }
function modelChoice(value: unknown): value is ModelChoice {
  return record(value) && typeof value.provider === 'string' && typeof value.model === 'string'
    && THINKING.some(level => level === value.thinking);
}
const alternates = (value: unknown): value is ProfileConfig['alternates'] => value === undefined
  || record(value) && Object.entries(value).every(([role, list]) => (role === 'compactor' || role === 'subagent') && Array.isArray(list) && list.every(modelChoice));
/** Multi-account rotates a provider by publishing numbered accounts as their own providers (`openai-codex-account-2`); the base id is their shared family. */
export const accountGroup = (provider: string) => provider.replace(/-account-\d+$/, '');
/** The role's model for the account the main model is on: the matching alternate, the role's own choice when it is on that provider's family, all addressed at the live account — and, with neither, the main model itself at the lowest effort it takes. */
export function modelFor(config: ProfileConfig, role: Role, main: MainModel | undefined): ModelChoice {
  const own = config[role];
  if (main === undefined || own.provider === main.provider) return own;
  const group = accountGroup(main.provider);
  const alternates = config.alternates?.[role];
  const alternate = alternates?.find(choice => choice.provider === main.provider) ?? alternates?.find(choice => accountGroup(choice.provider) === group);
  const chosen = alternate ?? (accountGroup(own.provider) === group ? own : undefined);
  // A numbered account: the role follows the account the main model is already serving on, not the base one it was configured with.
  if (chosen) return accountGroup(chosen.provider) === group && main.provider !== group ? { ...chosen, provider: main.provider } : chosen;
  // No choice for this provider: the main model, at the lowest effort it takes (clamped by the caller).
  return { provider: main.provider, model: main.model, thinking: 'off' };
}
/** What a role will use right now: its configured model, and the effective one when the main model changes it. */
export function roleModel(config: ProfileConfig, role: Role, main: MainModel | undefined) {
  const show = (choice: ModelChoice) => `${choice.provider}/${choice.model} (${choice.thinking})`;
  const own = config[role], effective = modelFor(config, role, main);
  const same = (a: ModelChoice, b: ModelChoice) => a.provider === b.provider && a.model === b.model && a.thinking === b.thinking;
  return same(own, effective) ? show(own) : `${show(own)} → now ${show(effective)}`;
}
/** Adds or replaces a role's alternate for a provider family, so the role keeps one entry per family. */
export function setAlternate(list: ModelChoice[] | undefined, choice: ModelChoice): ModelChoice[] {
  const group = accountGroup(choice.provider);
  return [...(list ?? []).filter(entry => accountGroup(entry.provider) !== group), choice];
}
/** Removes a role's alternate for the same family. */
export function removeAlternate(list: ModelChoice[] | undefined, choice: ModelChoice): ModelChoice[] {
  const group = accountGroup(choice.provider);
  return (list ?? []).filter(entry => accountGroup(entry.provider) !== group);
}
export function loadConfig(dir: string): ProfileConfig {
  const value: unknown = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  if (!record(value) || !modelChoice(value.compactor) || !modelChoice(value.subagent) || !alternates(value.alternates)) throw new Error(`Invalid profile config: ${dir}/config.json`);
  try { return { compactor: value.compactor, subagent: value.subagent, ...(value.alternates ? { alternates: value.alternates } : {}), ...readSettings(value) }; }
  catch (error) { throw new Error(`Invalid profile config: ${dir}/config.json: ${error instanceof Error ? error.message : String(error)}`); }
}
export function instructions(dir: string) { return readFileSync(join(dir, 'AGENTS.md'), 'utf8'); }
export function lastProfile() {
  try { const name = readFileSync(join(dataHome(), 'last-profile'), 'utf8').trim(); return listProfiles().includes(name) ? name : undefined; }
  catch { return undefined; }
}
export function rememberProfile(name: string) { atomicWrite(join(dataHome(), 'last-profile'), name); }

export class ProfileBusyError extends Error {
  constructor(readonly owner: string) { super(`Profile already running: ${owner}`); }
}
/** Lives in the profile itself, so every Pi on this profile finds the same socket whatever its TMPDIR. Git skips sockets, so checkpoints never see it. */
export const profileSocket = (dir: string, purpose: 'lock' | 'windows' = 'lock') => WINDOWS
  ? `\\\\.\\pipe\\optchat-${createHash('sha256').update(resolve(dir).toLowerCase()).digest('hex').slice(0, 32)}-${purpose}`
  : join(dir, `${purpose}.sock`);
// Node on Windows listens only on named pipes. A pipe is named after the profile directory, is no file, and disappears with its owner, so nothing is ever stale.
const WINDOWS = process.platform === 'win32';

// sun_path is 104 bytes on macOS and 108 elsewhere, both including the NUL. Node 22 binds a truncated path instead of failing, so the length is checked before listen.
export const SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 103 : 107;
export function checkSocketPath(path: string) {
  if (WINDOWS) return;
  const length = Buffer.byteLength(path);
  if (length > SOCKET_PATH_LIMIT) throw new Error(`Cannot listen on the profile socket: its path is ${length} bytes, over this system's limit of ${SOCKET_PATH_LIMIT}. Set OPTCHAT_HOME to a shorter directory: ${path}`);
}

/** A socket that may be replaced; a file that only shares its name is refused, never deleted. */
function existingSocket(path: string) {
  if (WINDOWS) return undefined;
  let stat; try { stat = lstatSync(path); } catch { return undefined; }
  if (!stat.isSocket()) throw new Error(`${path} is not an OptChat socket. Move it out of the profile and try again.`);
  return stat;
}
/** Removes a dead socket left by a previous owner. */
export function removeStaleSocket(path: string) { if (existingSocket(path)) unlinkSync(path); }

/** OS-owned socket lifetime, no timeout-based stealing of a busy profile. */
export async function lockProfile(dir: string, description: string) {
  const socketPath = profileSocket(dir); checkSocketPath(socketPath);
  const server = createServer(socket => { socket.on('error', () => socket.destroy()); socket.end(description); });
  const listen = () => new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.off('listening', ready); reject(error); };
    const ready = () => { server.off('error', failed); resolve(); };
    server.once('error', failed); server.once('listening', ready); server.listen(socketPath);
  });
  try { await listen(); }
  catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    const before = existingSocket(socketPath);
    if (!before && !WINDOWS) throw new Error('Profile lock changed; try again.');
    const owner = await new Promise<string | undefined>((resolve, reject) => {
      const socket = createConnection(socketPath); let message = '';
      socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Profile lock did not respond; refusing to steal it.')); });
      socket.on('data', data => { message += data.toString(); });
      socket.on('end', () => resolve(message || 'another Pi instance'));
      // A pipe whose owner just exited is gone (ENOENT) rather than refusing.
      socket.on('error', e => { if ('code' in e && (e.code === 'ECONNREFUSED' || (WINDOWS && e.code === 'ENOENT'))) resolve(undefined); else reject(e); });
    });
    if (owner !== undefined) throw new ProfileBusyError(owner);
    if (before) {
      if (statSync(socketPath).ino !== before.ino) throw new Error('Profile lock changed; try again.');
      unlinkSync(socketPath);
    }
    await listen();
  }
  const unlock = () => new Promise<void>(resolve => server.close(() => resolve()));
  if (WINDOWS) return unlock;
  try { chmodSync(socketPath, 0o600); } catch (error) { await unlock(); throw error; }
  return unlock;
}
