import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';

/** What a request carries for one tool: its description and its parameter schema, as the provider receives them. */
const sent = (tool: Pick<ToolDefinition, 'description' | 'parameters'>) => Buffer.byteLength(tool.description) + Buffer.byteLength(JSON.stringify(tool.parameters));

function registeredTools() {
  const tools = new Map<string, ToolDefinition>();
  optchat({ on() {}, events: { on: () => () => {} }, registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerFlag() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {} } as unknown as ExtensionAPI);
  return tools;
}

/** Measured before the trim: commitments 1762 B, crew 1713 B, tell 329 B (description plus parameter schema). */
const BEFORE = 1760 + 1711 + 329;
const BOOKKEEPING = ['commitments', 'crew', 'tell'] as const;

test('the three bookkeeping tools stay at least 30% below their measured size, with the event links documented', () => {
  const tools = registeredTools();
  const bytes = Object.fromEntries(BOOKKEEPING.map(name => [name, sent(tools.get(name)!)]));
  const total = BOOKKEEPING.reduce((sum, name) => sum + bytes[name]!, 0);
  console.log(`tool bytes ${JSON.stringify(bytes)} total ${total} before ${BEFORE}`);
  assert.ok(total <= Math.floor(BEFORE * 0.7), `commitments+crew+tell send ${total} B; the ceiling is ${Math.floor(BEFORE * 0.7)} B (30% under ${BEFORE} B)`);
  assert.match(JSON.stringify(tools.get('commitments')!.parameters), /links/, 'the links parameter stays documented');
});
