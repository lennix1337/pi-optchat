// Disposable worker process for the ops journey: node ops-worker-child.ts <dataDir> <sinkFile>
// Runs every queued job on the service data directory once, sending effects to an external sink file outside it,
// so a restore of that directory cannot hide a repeated send.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGateway } from '../src/policy/gateway.ts';
import { createRuntime } from '../src/runtime/worker.ts';

const [dataDir, sink] = process.argv.slice(2);
const gateway = createGateway({ databasePath: join(dataDir, 'gateway.sqlite'), profileId: 'p', operatorAuthority: {}, policy: () => 'allow', inspect: () => ({ decision: 'allow', reasons: [] }) });
const runtime = createRuntime({ databasePath: join(dataDir, 'runtime.sqlite'), owner: `journey-${process.pid}`, gateway, leaseMs: 60_000,
  adapters: { mail: { invoke: bytes => { appendFileSync(sink, `${Buffer.from(bytes).toString()}\n`); return { accepted: true }; } } } });
if (!await runtime.acquire()) { runtime.close(); gateway.close(); process.exit(3); }
while (await runtime.runOnce());
await runtime.stop();
runtime.close(); gateway.close();
