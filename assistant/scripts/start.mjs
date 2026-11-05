#!/usr/bin/env node
// Starts the manual assistant server for one private config, once. Refuses a port it does not own; waits for an
// authenticated loopback health read. Activation remains an operator decision: nothing here installs a service.
import { cli } from './cli.mjs';
import { startService, startWithRetry } from '../src/ops/service.ts';

const usage = `Usage: node assistant/scripts/start.mjs --config <absolute-path> [--web] [--wait-seconds N]
Starts the assistant (detached, loopback only) unless this config's recorded process is already running.
Writes assistant-service.json (pid + OS start time), assistant-service.log beside the config. Exit 0 = running.
--wait-seconds N retries failures a busy machine causes (timed-out inspections, a concurrent start) for up to N seconds.`;
cli(usage, { config: { type: 'string', required: true, path: true }, web: { type: 'boolean' }, 'wait-seconds': { type: 'string' } }, async values => {
  const start = () => startService({ configPath: values.config, web: values.web === true });
  const wait = values['wait-seconds'];
  if (wait === undefined) return start();
  if (!/^\d{1,4}$/.test(wait)) { console.error(usage); return { result: 'error', code: 'usage', exitCode: 2 }; }
  return startWithRetry(start, { waitMs: Number(wait) * 1000 });
});
