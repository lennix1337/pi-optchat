// Offline prefix, tool-declaration bytes, and synthetic context assembly benchmark.
import '../../test/support.ts';
import optchat from '../../src/index.ts';
import { runPerformanceBenchmark } from '../../test/performance-benchmark.ts';

const tools = new Map();
optchat({
  on() {},
  events: { on: () => () => {} },
  registerTool: tool => tools.set(tool.name, tool),
  registerFlag() {},
  registerCommand() {},
  registerShortcut() {},
  registerMessageRenderer() {},
});

const toolBytes = tool => Buffer.byteLength(tool.description) + Buffer.byteLength(JSON.stringify(tool.parameters));
let extensionToolBytes = 0;
for (const tool of tools.values()) extensionToolBytes += toolBytes(tool);

const bookkeepingNames = ['commitments', 'crew', 'tell'];
const bookkeepingBytes = bookkeepingNames.reduce((sum, name) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`missing expected tool: ${name}`);
  return sum + toolBytes(tool);
}, 0);

const perf = await runPerformanceBenchmark(9);
const base = perf.sizes.base;

console.log(JSON.stringify([
  { metric: 'prefix.extension_tools_bytes', value: extensionToolBytes, unit: 'bytes', lowerIsBetter: true, tolerancePct: 5 },
  { metric: 'prefix.extension_tool_count', value: tools.size, unit: 'count', lowerIsBetter: true, tolerancePct: 0 },
  { metric: 'prefix.bookkeeping_tools_bytes', value: bookkeepingBytes, unit: 'bytes', lowerIsBetter: true, tolerancePct: 5 },
  { metric: 'prefix.system_bytes', value: base.systemBytes, unit: 'bytes', lowerIsBetter: true, tolerancePct: 5 },
  { metric: 'prefix.request_bytes', value: base.requestBytes, unit: 'bytes', lowerIsBetter: true, tolerancePct: 5 },
  { metric: 'prefix.estimated_context_tokens', value: base.estimatedContextTokens, unit: 'tokens', lowerIsBetter: true, tolerancePct: 5 },
  { metric: 'context.memory_construction_ms', value: perf.timings.memoryConstruction.medianMs, unit: 'ms', lowerIsBetter: true, tolerancePct: 50, runs: 3 },
  { metric: 'context.memory_render_ms', value: perf.timings.memoryRender.medianMs, unit: 'ms', lowerIsBetter: true, tolerancePct: 50, runs: 3 },
  { metric: 'context.base_assembly_ms', value: perf.timings.baseContextAssemblyAndTelemetry.medianMs, unit: 'ms', lowerIsBetter: true, tolerancePct: 50, runs: 3 },
]));
