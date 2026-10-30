import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionContext, ToolInfo } from '@earendil-works/pi-coding-agent';
import { instructionText, inventory, names, onDemandIndex, registerToolInventory, renderTools, sourceOf, unnamed } from '../src/tool-inventory.ts';

const info = (path: string, source: string, baseDir?: string) => ({ path, source, scope: 'user', origin: 'package', ...(baseDir ? { baseDir } : {}) }) as ToolInfo['sourceInfo'];
const tool = (name: string, sourceInfo: ToolInfo['sourceInfo'], exposure: ToolInfo['exposure'] = 'direct', description = `${name} does one thing. More detail.`) =>
  ({ name, description, parameters: { type: 'object', properties: { repo: { type: 'string' } } }, exposure, sourceInfo }) as unknown as ToolInfo;

const tools = [
  tool('read', info('builtin:read', 'builtin')),
  tool('gitwatch', info('C:/projetos/pi-gitwatch/src/index.ts', 'C:/projetos/pi-gitwatch', 'C:/projetos/pi-gitwatch')),
  tool('repl', info('C:/projetos/pi-repl/src/index.ts', 'C:/projetos/pi-repl')),
  tool('web_search', info('/home/u/.pi/agent/npm/node_modules/pi-web-access/index.ts', 'npm:pi-web-access@1.2.3')),
  tool('context_metrics', info('C:/projetos/pi-optchat/src/index.ts', 'C:/projetos/pi-optchat'), 'deferred'),
  tool('old', info('C:/projetos/pi-optchat/src/index.ts', 'C:/projetos/pi-optchat'), 'hidden'),
];

test('sources name the package, npm version and builtins', () => {
  assert.deepEqual(tools.map(t => sourceOf(t.sourceInfo)), ['builtin', 'pi-gitwatch', 'pi-repl', 'pi-web-access', 'pi-optchat', 'pi-optchat']);
  assert.equal(sourceOf(undefined), 'unknown');
});

test('a tool counts as named only outside Pi\'s own tool list, and only as a whole word', () => {
  const prompt = 'Use `gitwatch` after a push.\n<tools>\n- repl: compute\n- web_search: search\n</tools>\n<rules>\n- prefer repl\n</rules>\nweb_searching is not a mention.';
  assert.equal(names(instructionText(prompt), 'gitwatch'), true);
  assert.equal(names(instructionText(prompt), 'repl'), false);
  assert.equal(names(instructionText(prompt), 'web_search'), false);
});

test('inventory reports declared tools, on-demand tools and unnamed declared tools, never hidden ones', () => {
  const rows = inventory(tools, ['read', 'gitwatch', 'repl', 'web_search'], 'Route PRs to gitwatch.');
  assert.deepEqual(rows.map(r => r.name), ['read', 'gitwatch', 'context_metrics', 'repl', 'web_search']);
  assert.deepEqual(rows.filter(r => !r.declared).map(r => `${r.name}:${r.exposure}`), ['context_metrics:deferred']);
  assert.deepEqual(unnamed(rows), ['repl', 'web_search'], 'builtins and named tools are not flagged');
  assert.ok(rows.every(r => r.bytes > 20));
  assert.equal(rows.find(r => r.name === 'gitwatch')!.summary, 'gitwatch does one thing.');
  const text = renderTools(rows);
  assert.match(text, /5 registered, 4 declared/);
  assert.match(text, /- pi-optchat: none declared; on demand: context_metrics \(deferred\)/);
  assert.match(text, /Not named in the instructions \(2\): repl, web_search/);
  assert.match(renderTools(inventory(tools, ['gitwatch'], 'gitwatch')), /Every declared tool is named/);
});

test('the on-demand index names deferred extension tools only, one line each', () => {
  const mcp = tool('mcp__plane__workitem', info('builtin:mcp', 'builtin'), 'deferred');
  const search = tool('list_mcp_resources', info('builtin:mcp', 'builtin'), 'deferred');
  const rows = inventory([...tools, mcp, search], ['read', 'gitwatch'], '');
  const index = onDemandIndex(rows);
  assert.equal(index.split('\n').length, 2);
  assert.match(index, /tools\.<name>\(args\)/);
  assert.match(index, /^- context_metrics \(pi-optchat\): context_metrics does one thing\.$/m);
  assert.doesNotMatch(index, /repl|mcp__|list_mcp_resources|old/, 'direct, MCP, builtin and hidden tools stay out');
  assert.equal(onDemandIndex(inventory(tools, tools.map(t => t.name), '')), '', 'nothing deferred and inactive, no section');
  assert.equal(onDemandIndex(inventory(tools, ['context_metrics'], '')), '', 'a deferred tool already declared is not indexed');
});

test('the command, the deferred tool and the one-time notice share the live inventory', async () => {
  const handlers = new Map<string, Function>(), commands = new Map<string, any>(), registered = new Map<string, any>(), notices: string[] = [];
  let active = ['gitwatch', 'repl'], prompt = 'gitwatch only';
  const pi = {
    on: (event: string, fn: Function) => handlers.set(event, fn),
    registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
    registerTool: (definition: any) => registered.set(definition.name, definition),
    getAllTools: () => tools, getActiveTools: () => active,
  } as unknown as ExtensionAPI;
  const ctx = { getSystemPrompt: () => prompt, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
  registerToolInventory(pi);
  assert.equal(registered.get('tool_inventory').exposure, 'deferred', 'costs no declaration until searched or scripted');
  const event = { systemPromptOptions: { sections: { on_demand_tools: 'stale' } as Record<string, string> } };
  handlers.get('before_agent_start')!(event, ctx);
  assert.match(event.systemPromptOptions.sections.on_demand_tools!, /- context_metrics \(pi-optchat\)/);
  active = [...active, 'context_metrics']; handlers.get('before_agent_start')!(event, ctx); active = ['gitwatch', 'repl'];
  assert.equal('on_demand_tools' in event.systemPromptOptions.sections, false, 'an emptied index removes its section');
  const json = JSON.parse((await registered.get('tool_inventory').execute('id', {}, undefined, undefined, ctx)).content[0].text);
  assert.deepEqual(json.unnamed, ['repl']);
  await commands.get('tools').handler('', ctx);
  assert.match(notices.pop()!, /Not named in the instructions \(1\): repl/);
  const start = handlers.get('agent_start')!;
  start({}, ctx); start({}, ctx);
  assert.deepEqual(notices, ['Tools the instructions never name: repl. /tools for details.'], 'same set is noticed once');
  prompt = 'gitwatch and repl'; start({}, ctx);
  active = ['gitwatch', 'repl', 'web_search']; start({}, ctx);
  assert.equal(notices.length, 2, 'a newly unnamed tool is noticed again');
  assert.match(notices[1]!, /web_search/);
});
