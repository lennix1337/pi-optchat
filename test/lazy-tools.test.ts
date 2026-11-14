import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolInfo } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '../src/profiles.ts';
import { LAZY_TOOLS, lazyLoadout, lazySet } from '../src/lazy-tools.ts';
import { inventory, onDemandIndex, renderTools, unnamed } from '../src/tool-inventory.ts';

const info = { path: 'C:/projetos/pi-web-access/index.ts', source: 'npm:pi-web-access@1.0.0', scope: 'user', origin: 'package' } as ToolInfo['sourceInfo'];
const parameters: Record<string, object> = {
  web_search: { type: 'object', properties: { q: { type: 'string' }, n: { type: 'number' } }, required: ['q'] },
};
const tool = (name: string, exposure: ToolInfo['exposure'] = 'direct') =>
  ({ name, description: `${name} does one thing. More detail.`, parameters: parameters[name] ?? { type: 'object', properties: { q: { type: 'string' } } }, exposure, sourceInfo: info }) as unknown as ToolInfo;

test('the default list holds rarely used tools only, never the ones a turn depends on', () => {
  for (const hot of ['bash', 'read', 'edit', 'write', 'codemode', 'zoom', 'date', 'commitments', 'spawn', 'tell', 'subagent', 'crew', 'shell_start',
    'shell_status', 'shell_stop', 'project_checks', 'read_many', 'ripwire', 'browser_harness', 'operational_state', 'operation_state', 'self_reload', 'output_read', 'slack_send', 'gitwatch',
    // pi-subagents registers these two as model-only: no script can call them, so only their declarations reach them.
    'subagent_supervisor', 'contact_supervisor'])
    assert.equal(LAZY_TOOLS.includes(hot), false, `${hot} stays declared`);
  assert.ok(LAZY_TOOLS.includes('web_search') && LAZY_TOOLS.includes('lsp'));
  assert.equal(new Set(LAZY_TOOLS).size, LAZY_TOOLS.length);
});

test('a profile list replaces the default; an empty one turns the feature off', () => {
  assert.deepEqual([...lazySet(undefined)], [...LAZY_TOOLS]);
  assert.deepEqual([...lazySet(['a', 'b'])], ['a', 'b']);
  assert.equal(lazySet([]).size, 0);
});

test('the loadout hides the declarations of listed tools that are declared, and nothing else', () => {
  const declared = ['bash', 'codemode', 'web_search', 'lsp', 'zoom'].map(name => ({ name })) as never;
  const changes = lazyLoadout(() => new Set(['web_search', 'lsp', 'vault_run']))({ declared, callable: declared } as never);
  assert.deepEqual(changes?.hiddenDeclarations, ['web_search', 'lsp']);
  assert.equal(lazyLoadout(() => new Set())({ declared, callable: declared } as never), undefined);
});

test('without codemode nothing is hidden: a hidden tool would have no way to be called', () => {
  const declared = ['bash', 'web_search', 'lsp'].map(name => ({ name })) as never;
  assert.equal(lazyLoadout(() => new Set(['web_search', 'lsp']))({ declared, callable: declared } as never), undefined);
});

test('a listed tool that scripts cannot call keeps its declaration: hidden, nothing could reach it', () => {
  // Pi leaves model-only tools out of what `ctx.executeTool()` can call, so `tools.<name>()` in a script does not exist for them.
  const named = (names: string[]) => names.map(name => ({ name }));
  const declared = named(['bash', 'codemode', 'web_search', 'subagent_supervisor']);
  const callable = named(['bash', 'codemode', 'web_search', 'context_metrics']);
  const lazy = () => new Set(['web_search', 'subagent_supervisor', 'context_metrics']);
  assert.deepEqual(lazyLoadout(lazy)({ declared, callable } as never)?.hiddenDeclarations, ['web_search']);
  // Nothing left to hide once the only listed tool is one no script can call.
  assert.equal(lazyLoadout(() => new Set(['subagent_supervisor']))({ declared, callable } as never), undefined);
});

test('a listed model-only tool is declared in the inventory and stays out of the on-demand index', () => {
  const tools = [tool('bash'), tool('web_search'), tool('subagent_supervisor', 'model-only')];
  const rows = inventory(tools, ['bash', 'web_search', 'subagent_supervisor'], 'bash only', new Set(['web_search', 'subagent_supervisor']));
  const supervisor = rows.find(r => r.name === 'subagent_supervisor')!;
  assert.deepEqual([supervisor.declared, supervisor.lazy], [true, false]);
  assert.deepEqual(rows.filter(r => r.lazy).map(r => r.name), ['web_search']);
  assert.doesNotMatch(onDemandIndex(rows), /subagent_supervisor/, 'the index tells the model to call its entries from a script');
  assert.deepEqual(unnamed(rows), ['subagent_supervisor'], 'a declared tool the instructions never name is still reported');
});

test('a hidden declaration is on demand: not declared, indexed, and never flagged as unnamed', () => {
  const tools = [tool('bash'), tool('web_search'), tool('lsp'), tool('context_metrics', 'deferred')];
  const rows = inventory(tools, ['bash', 'web_search', 'lsp'], 'bash only', new Set(['web_search', 'lsp']));
  assert.deepEqual(rows.filter(r => r.declared).map(r => r.name), ['bash']);
  assert.deepEqual(rows.filter(r => r.lazy).map(r => r.name), ['lsp', 'web_search']);
  assert.deepEqual(unnamed(rows), [], 'a tool outside the declarations needs no routing line to be remembered');
  const index = onDemandIndex(rows);
  assert.match(index, /^- lsp\(q\?\): lsp does one thing\.$/m, 'the arguments are listed, so a script can call it without describeTool');
  assert.match(index, /^- web_search\(q, n\?\): web_search does one thing\.$/m);
  assert.match(index, /^- context_metrics /m);
  assert.match(renderTools(rows), /on demand: .*lsp \(declaration hidden\)/);
  assert.match(renderTools(rows), /1 declared to the model/);
});

test('a listed tool that is not active is not marked lazy', () => {
  const rows = inventory([tool('bash'), tool('lsp')], ['bash'], '', new Set(['lsp']));
  assert.equal(rows.find(r => r.name === 'lsp')!.lazy, false);
  assert.equal(onDemandIndex(rows), '', 'inactive direct tools are unreachable, so they stay out of the index');
});

test('a profile config keeps lazyTools (an empty list too) and refuses anything that is not a list of text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-lazy-'));
  const model = { provider: 'anthropic', model: 'claude-sonnet-5-5', thinking: 'high' };
  const load = (extra: object) => { writeFileSync(join(dir, 'config.json'), JSON.stringify({ compactor: model, subagent: model, ...extra })); return loadConfig(dir); };
  try {
    assert.deepEqual(load({ lazyTools: ['lsp', 'repl'] }).lazyTools, ['lsp', 'repl']);
    assert.deepEqual(load({ lazyTools: [] }).lazyTools, []);
    assert.equal(load({}).lazyTools, undefined);
    assert.throws(() => load({ lazyTools: 'lsp' }), /Invalid profile config/);
    assert.throws(() => load({ lazyTools: [1] }), /Invalid profile config/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
