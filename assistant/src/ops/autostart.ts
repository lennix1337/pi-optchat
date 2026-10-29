import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../hash.ts';
import { OpsError, loadConfig, servicePaths } from './service.ts';

/**
 * Opt-in Windows autostart for one config: a launcher in the current user's Startup folder that runs start.mjs at
 * logon. It is a plain file, reversible by deleting it; no scheduled task, service or registry entry is created.
 * Without `yes` every command is a dry run that only prints the plan.
 */
export type AutostartResult = { result: 'dry_run' | 'installed' | 'already_installed' | 'uninstalled' | 'not_installed'; launcher: string; plan: string };

const scriptsDir = fileURLToPath(new URL('../../scripts/', import.meta.url));
// cmd.exe expands or splits on these even inside quotes, so such paths are refused rather than escaped.
const CMD_UNSAFE = /["%!^&|<>\r\n]/;

function startupDirectory(): string {
  const appData = process.env.APPDATA;
  if (!appData) throw new OpsError('autostart_unavailable', 'APPDATA is not set');
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function autostartPlan(configPath: string): { launcher: string; content: string; plan: string } {
  if (process.platform !== 'win32') throw new OpsError('autostart_unsupported', 'only the Windows Startup folder is supported');
  const paths = servicePaths(configPath);
  const config = loadConfig(configPath);
  const node = process.execPath, start = join(scriptsDir, 'start.mjs'), stop = join(scriptsDir, 'stop.mjs'), self = join(scriptsDir, 'autostart.mjs');
  if ([node, start, paths.config].some(p => CMD_UNSAFE.test(p))) throw new OpsError('autostart_unsafe_path', 'a path contains characters cmd.exe would reinterpret');
  const launcher = join(startupDirectory(), `optchat-assistant-${sha256(paths.config).slice(0, 12)}.cmd`);
  const content = [
    '@echo off',
    `rem OptChat assistant autostart for ${paths.config}`,
    `rem Remove with: node "${self}" uninstall --config "${paths.config}" --yes`,
    `"${node}" "${start}" --config "${paths.config}"`,
    '',
  ].join('\r\n');
  const plan = [
    'OptChat assistant autostart (Windows, current user, explicit opt-in)',
    `  writes: ${launcher}`,
    `  runs at your logon: "${node}" "${start}" --config "${paths.config}"`,
    `  consumption: one Node.js process for this profile, idle CPU near zero; health.mjs reports its memory and database size. Network: only ${config.endpoint} (loopback). No model or paid calls.`,
    `  retention: service log ${paths.log} is rotated above 1 MiB at each start (one previous copy, .1); databases stay until you delete them; backups exist only when you run backup.mjs.`,
    `  stop now: node "${stop}" --config "${paths.config}"`,
    `  remove autostart: node "${self}" uninstall --config "${paths.config}" --yes`,
    'No scheduled task, service or registry entry is created.',
  ].join('\n');
  return { launcher, content, plan };
}

export function installAutostart(options: { configPath: string; yes: boolean }): AutostartResult {
  const { launcher, content, plan } = autostartPlan(options.configPath);
  if (existsSync(launcher)) {
    if (readFileSync(launcher, 'utf8') !== content) throw new OpsError('autostart_conflict', `${launcher} exists and was not written by this command; left untouched`);
    return { result: 'already_installed', launcher, plan };
  }
  if (!options.yes) return { result: 'dry_run', launcher, plan };
  writeFileSync(launcher, content, { flag: 'wx' });
  return { result: 'installed', launcher, plan };
}

/** Removes only the exact launcher this command writes for this config. */
export function uninstallAutostart(options: { configPath: string; yes: boolean }): AutostartResult {
  const { launcher, content, plan } = autostartPlan(options.configPath);
  if (!existsSync(launcher)) return { result: 'not_installed', launcher, plan };
  if (readFileSync(launcher, 'utf8') !== content) throw new OpsError('autostart_conflict', `${launcher} was not written by this command; left untouched`);
  if (!options.yes) return { result: 'dry_run', launcher, plan };
  rmSync(launcher);
  return { result: 'uninstalled', launcher, plan };
}
