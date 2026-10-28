#!/usr/bin/env node
// Explicit opt-in Windows autostart through a launcher in the current user's Startup folder. Dry run unless --yes.
import { cli } from './cli.mjs';
import { installAutostart, uninstallAutostart } from '../src/ops/autostart.ts';

const usage = `Usage: node assistant/scripts/autostart.mjs install|uninstall --config <absolute-path> [--yes]
Without --yes, prints what would be written and changes nothing. Creates no scheduled task, service or registry entry.`;
cli(usage, { config: { type: 'string', required: true, path: true }, yes: { type: 'boolean' } }, async (values, positionals) => {
  if (positionals.length !== 1 || !['install', 'uninstall'].includes(positionals[0])) { console.error(usage); return { result: 'error', code: 'usage', exitCode: 2 }; }
  const action = positionals[0] === 'install' ? installAutostart : uninstallAutostart;
  const outcome = action({ configPath: values.config, yes: values.yes === true });
  console.log(outcome.plan);
  return { result: outcome.result, launcher: outcome.launcher };
});
