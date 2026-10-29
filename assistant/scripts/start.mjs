#!/usr/bin/env node
// Starts the manual assistant server for one private config, once. Refuses a port it does not own; waits for an
// authenticated loopback health read. Activation remains an operator decision: nothing here installs a service.
import { cli } from './cli.mjs';
import { startService } from '../src/ops/service.ts';

const usage = `Usage: node assistant/scripts/start.mjs --config <absolute-path> [--web]
Starts the assistant (detached, loopback only) unless this config's recorded process is already running.
Writes assistant-service.json (pid + OS start time), assistant-service.log beside the config. Exit 0 = running.`;
cli(usage, { config: { type: 'string', required: true, path: true }, web: { type: 'boolean' } },
  async values => startService({ configPath: values.config, web: values.web === true }));
