// Offline turn-start latency and prompt-cache prefix stability benchmark.
import { runTurnStartBenchmark } from '../turn-start-benchmark.ts';

const result = await runTurnStartBenchmark({ messages: 20_000, turns: 10, warmup: 2, gapMs: 0 });
const req = result.request;

console.log(JSON.stringify([
  { metric: 'turn_start.prompt_to_provider_p50_ms', value: result.promptToProvider.p50Ms, unit: 'ms', lowerIsBetter: true, tolerancePct: 35 },
  { metric: 'turn_start.prompt_to_provider_p95_ms', value: result.promptToProvider.p95Ms, unit: 'ms', lowerIsBetter: true, tolerancePct: 40 },
  { metric: 'turn_start.whole_turn_p50_ms', value: result.wholeTurn.p50Ms, unit: 'ms', lowerIsBetter: true, tolerancePct: 35 },
  { metric: 'prompt_cache.prefix_changes', value: req.prefixChanges, unit: 'count', lowerIsBetter: true, tolerancePct: 0 },
  { metric: 'prompt_cache.system_bytes', value: req.systemBytes, unit: 'bytes', lowerIsBetter: true, tolerancePct: 5 },
  { metric: 'prompt_cache.tool_schema_bytes', value: req.toolSchemaBytes, unit: 'bytes', lowerIsBetter: true, tolerancePct: 5 },
]));
