#!/usr/bin/env node

import { cli } from './cli.mjs';
import { readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { serviceHealth } from '../src/ops/service.ts';

const usage = `Usage: node assistant/scripts/health.mjs [--config <absolute-path>]
Without --config it reads the only ~/.optchat-assistant/<profile>/server.json (refuses when there are several).
Reports state (healthy, unhealthy, stopped, stale_record, foreign_listener), pid, memory, database and log size.
Exit 0 = healthy.`;
cli(usage, { config: { type: 'string', path: true } }, async values => {
  const report = await serviceHealth({ configPath: values.config ?? soleConfig() });
  return { ...report, exitCode: report.state === 'healthy' ? 0 : 1 };
});

function soleConfig() {
  const root = join(homedir(), '.optchat-assistant');
  const found = existsSync(root) ? readdirSync(root).map(name => join(root, name, 'server.json')).filter(existsSync) : [];
  if (found.length !== 1) throw new Error(found.length ? 'config_ambiguous' : 'config_missing');
  return found[0];
}
