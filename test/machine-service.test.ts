import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { retroPrompt } from '../src/daily-retro.ts';
import { machineTool, mcpSignatures, renderHistory, renderNow, renderTop } from '../src/machine-service.ts';
import type { LedgerRow } from '../src/machine-ledger.ts';
import { ShellJobs } from '../src/shells.ts';
import { tempDir } from './support.ts';

test('mcp.json entries become the package words their command lines hold, without versions, flags or generic words', () => {
  const { dir, close } = tempDir('optchat-machine-');
  try {
    writeFileSync(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: {
      sentry: { command: 'npx', args: ['-y', '@sentry/mcp-server@0.49.0'], env: { SENTRY_AUTH_TOKEN: 'never-read' } },
      plane: { command: 'uvx', args: ['plane-mcp-server', 'stdio'] },
      analytics: { command: 'uvx', args: ['--from', 'analytics-mcp==0.7.0', 'analytics-mcp'] },
      local: { command: 'C:\\tools\\my-server.exe', args: [] },
      bare: { command: 'npx' },
    } }));
    assert.deepEqual(mcpSignatures(join(dir, 'mcp.json')), [
      { name: 'sentry', tokens: ['@sentry/mcp-server'] },
      { name: 'plane', tokens: ['plane-mcp-server'] },
      { name: 'analytics', tokens: ['analytics-mcp'] },
      { name: 'local', tokens: ['my-server'] },
    ]);
    assert.deepEqual(mcpSignatures(join(dir, 'missing.json')), []);
    writeFileSync(join(dir, 'torn.json'), '{"mcpServers": {');
    assert.deepEqual(mcpSignatures(join(dir, 'torn.json')), []);
  } finally { close(); }
});

test('the shell inventory tells its observer when any job, foreground or background, begins and ends', async () => {
  const jobs = new ShellJobs(), seen: string[] = [];
  jobs.setLifecycleObserver({ began: job => { seen.push(`began ${job.mode} ${job.id}`); }, ended: job => { seen.push(`ended ${job.id} ${job.state}`); } });
  jobs.begin('tc-1', 'npm test', '.', 'foreground');
  jobs.end('tc-1', 'ok', false);
  jobs.end('tc-1', 'again', false); // a second end is not a second notice
  const id = jobs.start('sleep 1', '.', async () => ({ output: 'done', failed: false }));
  await jobs.settle(id, 1000);
  assert.deepEqual(seen, ['began foreground tc-1', 'ended tc-1 completed', `began background ${id}`, `ended ${id} completed`]);
  jobs.setLifecycleObserver({ began: () => { throw new Error('observer broke'); }, ended: () => { throw new Error('observer broke'); } });
  jobs.begin('tc-2', 'x', '.', 'foreground'); jobs.end('tc-2', 'ok', false);
  assert.equal(jobs.find('tc-2')?.state, 'completed', 'a throwing observer never owns the job');
});

const now = { t: Date.parse('2026-11-10T21:30:05Z'), cpu: 91.2, memUsedMb: 15_500, memTotalMb: 31_650, idleS: 46.6, threads: 16, processes: 289, lowered: 3,
  owners: [{ group: 'worker ed055130', kind: 'worker', detail: 'bash stress.sh', cpuPct: 88.4, rssMb: 1200, procs: 21 }, { group: 'Pi host', kind: 'host', cpuPct: 1.2, rssMb: 800, procs: 1 },
    { group: 'mcp sentry', kind: 'mcp', cpuPct: 0.1, rssMb: 380, procs: 3 }, { group: 'external chrome.exe', kind: 'external', cpuPct: 0.2, rssMb: 90, procs: 4 }] };

test('now renders machine numbers and a compact owner table, hiding owners that cost nothing', () => {
  assert.equal(renderNow(now, { state: 'running' }), [
    '18:30:05 cpu 91% of 16 threads, memory 15.1/30.9 GB (49%), 289 processes, operator idle 47 s, 3 of ours lowered to Idle',
    'owner | kind | cpu% of machine | MB | procs',
    'worker ed055130 bash stress.sh | worker | 88.4 | 1200 | 21',
    'Pi host | host | 1.2 | 800 | 1',
    'mcp sentry | mcp | 0.1 | 380 | 3',
    '(1 more owners under 0.5% CPU and 150 MB)',
  ].join('\n'));
  assert.equal(renderNow(undefined, { state: 'unsupported', detail: 'only Windows has a sampler' }), 'machine sampler: unsupported (only Windows has a sampler). No sample yet.');
});

const row = (minute: number, owner: string, cpuS: number, rssMb = 100, kind = 'own', detail?: string): LedgerRow => ({ t: Date.parse('2026-11-10T21:00:00Z') + minute * 60_000, owner, kind, ...detail ? { detail } : {}, cpuS, rssMb, procs: 3, wallS: 60, host: 1 });

test('top and history read the ledger rows', () => {
  const rows = [row(0, 'machine', 600, 15000, 'machine'), row(1, 'machine', 400, 15000, 'machine'), row(0, 'worker ed055130', 300, 1200, 'worker', 'bash stress.sh'), row(1, 'worker ed055130', 200, 1100, 'worker', 'bash stress.sh'), row(1, 'mcp sentry', 1, 380, 'mcp')];
  assert.equal(renderTop(rows, 60), ['last 60 min, 2 min recorded, machine 17 cpu-min', 'owner | kind | cpu-min | avg MB | peak procs | alive',
    'worker ed055130 bash stress.sh | worker | 8.3 | 1150 | 3 | 2 min', 'mcp sentry | mcp | 0.0 | 380 | 3 | 1 min'].join('\n'));
  assert.equal(renderTop(rows, 60, 8, 'mcp').split('\n').length, 3);
  assert.match(renderTop([], 60), /^No machine rows in the last 60 min\./);
  assert.equal(renderHistory(rows, 'STRESS', 60), ['worker ed055130: 10-min buckets', 'time | cpu-s | peak MB | peak procs', '11-10 18:00 | 500 | 1200 | 3'].join('\n'));
  assert.match(renderHistory(rows, 'nothing', 60), /^No rows for "nothing"/);
});

test('the machine tool is read-only, deferred, and says so when no sampler runs', async () => {
  const tool = machineTool(() => undefined);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.exposure, 'deferred');
  assert.ok(tool.description.length < 520, `compact description (${tool.description.length})`);
  const result = await tool.execute('x', {});
  assert.match(result.content[0].text, /not running in this session/);
});

test('the retro prompt carries the measured cost centres, and is unchanged without them', () => {
  assert.doesNotMatch(retroPrompt('2026-11-10'), /cost centres/);
  const text = retroPrompt('2026-11-10', ['cpu: worker ed055130 (bash stress.sh): 45 cpu-min over 3 min alive, up to 21 procs']);
  assert.match(text, /Measured cost centres of the last 24 h[^\n]*\n- cpu: worker ed055130 \(bash stress\.sh\): 45 cpu-min/);
  assert.ok(text.indexOf('cost centres') < text.indexOf('Finish with one short Slack DM'));
});
