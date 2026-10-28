#!/usr/bin/env node
// Restores a backup into an empty private directory, with integrity, schema and profile checks and no-replay fences.
import { cli } from './cli.mjs';
import { restoreBackup } from '../src/ops/backup.ts';
import { osKeyProtector } from '../src/secrets/protector.ts';

const usage = `Usage: node assistant/scripts/restore.mjs --backup <absolute-file> --into <absolute-empty-private-dir> --profile <profileId>
Never restores in place. Unfinished jobs become effect_uncertain/blocked (restored_unreconciled), approvals and
connector grants are revoked and active routines paused, so nothing executed after the backup runs again.
Point a config's databasePath at the reported tasksDatabase, then start it.`;
cli(usage, { backup: { type: 'string', required: true, path: true }, into: { type: 'string', required: true, path: true }, profile: { type: 'string', required: true } }, async values => {
  const report = await restoreBackup({ backup: values.backup, into: values.into, profileId: values.profile, protector: osKeyProtector() });
  return { result: 'restored', ...report };
});
