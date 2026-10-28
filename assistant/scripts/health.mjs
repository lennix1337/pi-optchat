#!/usr/bin/env node
// Read-only diagnostics: ownership record, process, port and one authenticated loopback read. No model or paid calls.
import { cli } from './cli.mjs';
import { serviceHealth } from '../src/ops/service.ts';

const usage = `Usage: node assistant/scripts/health.mjs --config <absolute-path>
Reports state (healthy, unhealthy, stopped, stale_record, foreign_listener), pid, memory, database and log size.
Exit 0 = healthy.`;
cli(usage, { config: { type: 'string', required: true, path: true } }, async values => {
  const report = await serviceHealth({ configPath: values.config });
  return { ...report, exitCode: report.state === 'healthy' ? 0 : 1 };
});
