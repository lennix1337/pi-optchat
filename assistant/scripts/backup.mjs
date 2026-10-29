#!/usr/bin/env node
// Encrypted backup of the config's data directory (all SQLite databases except the vault).
import { cli } from './cli.mjs';
import { loadConfig } from '../src/ops/service.ts';
import { createBackup } from '../src/ops/backup.ts';
import { osKeyProtector } from '../src/secrets/protector.ts';

const usage = `Usage: node assistant/scripts/backup.mjs --config <absolute-path> --out <absolute-new-file>
Snapshots every SQLite database in the task database's directory except the vault, sealed with AES-256-GCM.
The data key is wrapped with Windows DPAPI for the current user and stored only in wrapped form; other platforms refuse.
Never overwrites an existing file. Safe while the service runs.`;
cli(usage, { config: { type: 'string', required: true, path: true }, out: { type: 'string', required: true, path: true } }, async values => {
  const config = loadConfig(values.config);
  const summary = await createBackup({ databasePath: config.databasePath, profileId: config.profileId, out: values.out, protector: osKeyProtector() });
  return { result: 'backed_up', out: summary.out, entries: summary.entries.map(e => ({ name: e.name, bytes: e.bytes })), excluded: summary.excluded };
});
