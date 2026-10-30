import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runToolCall, type AgentTool } from '@earendil-works/pi-agent-core';
import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { emptyUsage } from '../src/usage.ts';
import { childToolSchemas } from '../src/child-resources.ts';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';

// Register the actual extension without opening a profile or invoking a lifecycle hook.
function registeredTools() {
  const tools = new Map<string, ToolDefinition>();
  optchat({ on() {}, events: { on: () => () => {} }, registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerFlag() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {} } as unknown as ExtensionAPI);
  return tools;
}
const validInputs: Record<string, Record<string, unknown>> = {
  zoom: { id: 0 }, date: { id: 0 }, search: { text: 'fixture' }, output_read: { ref: 'a'.repeat(64) },
  shell_start: { command: 'not executed', timeout: 1, notify: 'none' }, shell_status: {}, shell_stop: { id: 'fixture' },
  operation_state: {}, operational_state: {}, context_metrics: {}, spawn: { tasks: [{ task: 'not launched', cwd: '.' }] },
  tell: { id: 'fixture', message: 'not sent' }, catchup_report: {}, self_reload: { checkpoint: 'Verified fixture; next inspect receipt.' },
  slack_send: { text: 'not sent' }, tool_inventory: {},
};
// Pi's own tools that OptChat re-registers only to change how they run; their inputs stay exactly Pi's.
const nativeOverrides = process.platform === 'win32' ? ['bash'] : [];
const tools = registeredTools();
test('the registered tool set is completely covered by strict input cases', () => {
  assert.deepEqual([...tools.keys()].sort(), [...Object.keys(validInputs), ...nativeOverrides].sort());
});
test('a re-registered native tool keeps Pi\'s own input schema', () => {
  for (const name of nativeOverrides) assert.deepEqual(tools.get(name)!.parameters, createBashToolDefinition(process.cwd()).parameters);
});
const validate = (tool: Pick<ToolDefinition, 'name' | 'parameters'>, args: Record<string, unknown>) => validateToolArguments(tool as never,
  { type: 'toolCall', id: 'fixture', name: tool.name, arguments: args as never });

for (const [name, args] of Object.entries(validInputs)) test(`${name}: native registration rejects extra keys without changing documented inputs`, () => {
  const tool = tools.get(name)!;
  assert.ok(tool, `${name} must be registered`);
  assert.deepEqual(validate(tool, args), args);
  assert.throws(() => validate(tool, { ...args, misspelled_option: true }), /misspelled_option/);
});

test('spawn rejects a misspelled per-task directory instead of silently using the parent cwd', () => {
  assert.throws(() => validate(tools.get('spawn')!, { tasks: [{ task: 'not launched', cwdd: '.' }] }), /cwdd/);
});

test('parent and child delegation share strict schemas, including nested task directories', () => {
  assert.strictEqual(tools.get('spawn')!.parameters, childToolSchemas.spawn);
  assert.strictEqual(tools.get('tell')!.parameters, childToolSchemas.tell);
  for (const [name, parameters, args] of [
    ['spawn', childToolSchemas.spawn, validInputs.spawn],
    ['tell', childToolSchemas.tell, validInputs.tell],
    ['tell_parent', childToolSchemas.parent, { message: 'not sent' }],
  ] as const) {
    const tool = { name, parameters };
    assert.deepEqual(validate(tool, args), args);
    assert.throws(() => validate(tool, { ...args, misspelled_option: true }), /misspelled_option/);
  }
  assert.throws(() => validate({ name: 'spawn', parameters: childToolSchemas.spawn },
    { tasks: [{ task: 'not launched', cwdd: '.' }] }), /cwdd/);
});

test('native dispatch rejects a misspelled timeout before a shell body can run', async () => {
  let executions = 0;
  const tool = { ...tools.get('shell_start')!, execute: async () => { executions++; return { content: [{ type: 'text' as const, text: 'stubbed execution' }] }; } } as unknown as AgentTool;
  const assistantMessage = { role: 'assistant' as const, content: [], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage: emptyUsage(), stopReason: 'stop' as const, timestamp: 1 };
  const dispatch = (args: Record<string, unknown>) => runToolCall({ type: 'toolCall', id: 'dispatch', name: tool.name, arguments: args as never },
    { tools: [tool], assistantMessage, context: { messages: [], tools: [tool] } });
  const rejected = await dispatch({ command: 'not executed', timeot: 1 });
  assert.equal(rejected.isError, true);
  assert.equal(executions, 0, 'validation must precede side effects');
  assert.match(JSON.stringify(rejected.result.content), /timeot/);
  const accepted = await dispatch({ command: 'not executed', timeout: 1 });
  assert.equal(accepted.isError, false);
  assert.equal(executions, 1, 'valid input reaches only the in-memory stub');
});
