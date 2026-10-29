#!/usr/bin/env node
// Drains and stops only the process start.mjs launched for this config (matching pid and OS start time).
import { cli } from './cli.mjs';
import { stopService } from '../src/ops/service.ts';

const usage = `Usage: node assistant/scripts/stop.mjs --config <absolute-path>
Asks the recorded service to stop admission and drain, then waits; terminates it only if it still is the
process start.mjs launched. Never signals another process. Exit 0 = not running afterwards.`;
cli(usage, { config: { type: 'string', required: true, path: true } }, async values => stopService({ configPath: values.config }));
