import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { formatSkillsForPrompt, loadSkillsFromDir, type ExtensionAPI, type ExtensionContext, type Skill, type ToolInfo } from '@earendil-works/pi-coding-agent';
import { defaults, loadConfig, saveConfig } from '../src/profiles.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { registerToolInventory, renderTools } from '../src/tool-inventory.ts';
import { DEFAULT_SKILL_BUDGET_BYTES, estimateSkillTokens, renderSkillBudget, skillBudget } from '../src/skill-budget.ts';
import { tempDir } from './support.ts';

function writeSkill(root: string, name: string, description: string, body: string, extraFrontmatter = '') {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const content = `---\nname: ${name}\ndescription: ${description}\n${extraFrontmatter}---\n\n${body}\n`;
  const filePath = join(dir, 'SKILL.md');
  writeFileSync(filePath, content, 'utf8');
  return { filePath, content, bytes: Buffer.byteLength(content, 'utf8') };
}

function promptWithSkills(skills: readonly Skill[]) {
  const formatted = formatSkillsForPrompt([...skills]).trim();
  return formatted ? `Base system prompt.\n\n<skills>\n${formatted}\n</skills>\n` : 'Base system prompt.\n';
}

function fakeTools(): ToolInfo[] {
  const sourceInfo = { path: 'builtin:read', source: 'builtin', scope: 'user', origin: 'package' } as unknown as ToolInfo['sourceInfo'];
  return [{ name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } }, exposure: 'direct', sourceInfo } as unknown as ToolInfo];
}

test('measures Pi skills list and on-disk SKILL.md sizes under and over budget', () => {
  const t = tempDir('skill-budget-list-');
  try {
    const alpha = writeSkill(t.dir, 'alpha', 'Compact helper skill.', 'Step 1: check status.');
    const beta = writeSkill(t.dir, 'beta', 'Larger workflow skill with detailed triggers and constraints.', 'x'.repeat(2400));
    const loaded = loadSkillsFromDir({ dir: t.dir, source: 'user' }).skills;
    const systemPrompt = promptWithSkills(loaded);
    const skillsTagMatch = /<skills>[\s\S]*?<\/skills>/.exec(systemPrompt);
    assert.ok(skillsTagMatch, 'Pi system prompt contains <skills> section');
    const exactListBytes = Buffer.byteLength(skillsTagMatch[0], 'utf8');

    const under = skillBudget({ systemPrompt, budgetBytes: exactListBytes + 500 });
    assert.equal(under.listBytes, exactListBytes);
    assert.equal(under.listOverheadBytes + under.skills.reduce((sum, s) => sum + s.listBytes, 0), exactListBytes);
    assert.equal(under.loadedBytes, 0);
    assert.equal(under.totalBytes, exactListBytes);
    assert.equal(under.estimatedTokens, estimateSkillTokens(exactListBytes));
    assert.equal(under.fileBytes, alpha.bytes + beta.bytes);
    assert.equal(under.exceeded, false);
    assert.equal(under.overByBytes, 0);
    assert.deepEqual(under.skills.map(s => s.name), ['beta', 'alpha'], 'sorted largest prompt bytes first');
    assert.equal(under.skills.find(s => s.name === 'alpha')!.fileBytes, alpha.bytes);
    assert.equal(under.skills.find(s => s.name === 'beta')!.fileBytes, beta.bytes);
    assert.match(renderSkillBudget(under), /beta:/);
    assert.match(renderSkillBudget(under), /\(ok\)/);
    assert.doesNotMatch(renderSkillBudget(under), /OVER BUDGET/);

    const tightBudget = exactListBytes - 50;
    const over = skillBudget({ systemPrompt, budgetBytes: tightBudget });
    assert.equal(over.exceeded, true);
    assert.equal(over.overByBytes, 50);
    assert.match(renderSkillBudget(over), /OVER BUDGET/);

    const disabled = skillBudget({ systemPrompt, budgetBytes: 0 });
    assert.equal(disabled.exceeded, false);
    assert.equal(disabled.overByBytes, 0);
    assert.equal(disabled.budgetTokens, 0);
  } finally { t.close(); }
});

test('counts loaded SKILL.md files from /skill expansion, read, read_many and skills_on_disk, ignoring errors and non-skills', () => {
  const t = tempDir('skill-budget-loaded-');
  try {
    const alpha = writeSkill(t.dir, 'alpha', 'Alpha skill.', 'Alpha body text.');
    const beta = writeSkill(t.dir, 'beta', 'Beta skill.', 'B'.repeat(1600));
    const manual = writeSkill(t.dir, 'manual', 'Manual-only skill.', 'M'.repeat(400), 'disable-model-invocation: true\n');
    const loaded = loadSkillsFromDir({ dir: t.dir, source: 'user' }).skills;
    const systemPrompt = promptWithSkills(loaded);
    const listOnly = skillBudget({ systemPrompt, budgetBytes: 100_000 });

    const expanded = `<skill name="alpha" location="${alpha.filePath}">\nReferences are relative to ${t.dir}.\n\nAlpha body text.\n</skill>`;
    const manualExpanded = `<skill name="manual" location="${manual.filePath}">\nReferences are relative to ${t.dir}.\n\n${'M'.repeat(400)}\n</skill>`;
    const messages = [
      { role: 'user', content: `${expanded}\nRun it.`, timestamp: 1 },
      {
        role: 'assistant', timestamp: 2, api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'toolUse',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [
          { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: beta.filePath } },
          { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: join(t.dir, 'README.md') } },
          { type: 'toolCall', id: 'c3', name: 'read', arguments: { path: join(t.dir, 'missing', 'SKILL.md') } },
          { type: 'toolCall', id: 'c4', name: 'read_many', arguments: { files: [{ path: join(t.dir, 'README.md') }, { path: alpha.filePath }] } },
          { type: 'toolCall', id: 'c5', name: 'skills_on_disk', arguments: { name: 'manual' } },
        ],
      },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: beta.content }], isError: false, timestamp: 3 },
      { role: 'toolResult', toolCallId: 'c2', toolName: 'read', content: [{ type: 'text', text: 'Not a skill file.' }], isError: false, timestamp: 4 },
      { role: 'toolResult', toolCallId: 'c3', toolName: 'read', content: [{ type: 'text', text: 'ENOENT' }], isError: true, timestamp: 5 },
      { role: 'toolResult', toolCallId: 'c4', toolName: 'read_many', content: [
        { type: 'text', text: `== ${join(t.dir, 'README.md')}` },
        { type: 'text', text: 'Readme body.' },
        { type: 'text', text: `== ${alpha.filePath}` },
        { type: 'text', text: alpha.content },
      ], isError: false, timestamp: 6 },
      { role: 'toolResult', toolCallId: 'c5', toolName: 'skills_on_disk', content: [{ type: 'text', text: manualExpanded }], isError: false, timestamp: 7 },
    ] as unknown as AgentMessage[];

    const budget = listOnly.listBytes + 500;
    const report = skillBudget({
      systemPrompt,
      messages,
      registeredSkills: loaded.map(s => ({ name: s.name, location: s.filePath })),
      budgetBytes: budget,
    });

    const alphaRow = report.skills.find(s => s.name === 'alpha')!;
    const betaRow = report.skills.find(s => s.name === 'beta')!;
    const manualRow = report.skills.find(s => s.name === 'manual')!;
    assert.equal(alphaRow.loadedBytes, Buffer.byteLength(expanded, 'utf8') + alpha.bytes);
    assert.equal(betaRow.loadedBytes, beta.bytes);
    assert.equal(manualRow.listBytes, 0, 'disable-model-invocation skill adds 0 list bytes');
    assert.equal(manualRow.loadedBytes, Buffer.byteLength(manualExpanded, 'utf8'));
    assert.equal(manualRow.fileBytes, manual.bytes);
    assert.equal(report.skills.find(s => s.name === 'missing'), undefined, 'errored read is not counted');
    assert.equal(report.skills.find(s => s.name === 'README.md'), undefined, 'non-skill read is not counted');
    assert.equal(report.totalBytes, report.listBytes + report.loadedBytes);
    assert.equal(report.exceeded, true, 'loaded SKILL.md files push total over budget');
    assert.equal(report.overByBytes, report.totalBytes - budget);
  } finally { t.close(); }
});

test('handles prototype-property skill names and non-list <skills> prose safely', () => {
  const systemPrompt = 'Docs mention <skills>placeholder</skills> earlier.\n<skills>\n<available_skills>\n  <skill>\n    <name>constructor</name>\n    <description>Built-in key name.</description>\n    <location>/tmp/constructor/SKILL.md</location>\n  </skill>\n  <skill>\n    <name>toString</name>\n    <description>Another Object.prototype name.</description>\n    <location>/tmp/toString/SKILL.md</location>\n  </skill>\n</available_skills>\n</skills>';
  const report = skillBudget({ systemPrompt, budgetBytes: 10_000 });
  assert.deepEqual(report.skills.map(s => s.name).sort(), ['constructor', 'toString']);
  assert.ok(report.skills.every(s => s.listBytes > 0 && s.bytes === s.listBytes));
  const standalone = skillBudget({ systemPrompt: '<available_skills><skill><name>solo</name><description>Only tag.</description></skill></available_skills>', budgetBytes: 10_000 });
  assert.equal(standalone.skills.length, 1);
  assert.equal(standalone.skills[0]!.name, 'solo');
  assert.ok(standalone.listOverheadBytes > 0);
});

test('tool_inventory and /tools report per-skill bytes, total vs budget, and flag over-budget loaded skills', async () => {
  const t = tempDir('skill-budget-tool-');
  try {
    const small = writeSkill(t.dir, 'small', 'Short fixture skill.', 'Tiny body.');
    const large = writeSkill(t.dir, 'large', 'Heavy fixture skill.', 'L'.repeat(3000));
    const skills = loadSkillsFromDir({ dir: t.dir, source: 'user' }).skills;
    const systemPrompt = promptWithSkills(skills);

    const handlers = new Map<string, Function[]>(), commands = new Map<string, any>(), registered = new Map<string, any>(), notices: string[] = [];
    let budget = 2000;
    const pi = {
      on: (event: string, fn: Function) => handlers.set(event, [...handlers.get(event) ?? [], fn]),
      registerCommand: (name: string, definition: unknown) => commands.set(name, definition),
      registerTool: (definition: any) => registered.set(definition.name, definition),
      getAllTools: () => fakeTools(),
      getActiveTools: () => ['read'],
      getCommands: () => skills.map(s => ({ name: `skill:${s.name}`, source: 'skill', sourceInfo: { path: s.filePath } })),
    } as unknown as ExtensionAPI;
    const ctx = { getSystemPrompt: () => systemPrompt, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;

    registerToolInventory(pi, () => new Set(), { skillBudgetBytes: () => budget });
    const runTool = async () => JSON.parse((await registered.get('tool_inventory').execute('id', {}, undefined, undefined, ctx)).content[0].text);

    const under = await runTool();
    assert.equal(under.skills.exceeded, false);
    assert.equal(under.skills.budgetBytes, 2000);
    assert.equal(under.skills.skills.length, 2);
    assert.equal(under.skills.skills.find((s: any) => s.name === 'small').fileBytes, small.bytes);
    assert.ok(under.skills.totalBytes > 0 && under.skills.totalBytes <= 2000);

    const messages = [
      {
        role: 'assistant', timestamp: 1, api: 'openai-completions', provider: 'fixture', model: 'fixture', stopReason: 'toolUse',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: [{ type: 'toolCall', id: 'r1', name: 'read', arguments: { path: large.filePath } }],
      },
      { role: 'toolResult', toolCallId: 'r1', toolName: 'read', content: [{ type: 'text', text: large.content }], isError: false, timestamp: 2 },
    ] as unknown as AgentMessage[];
    for (const fn of handlers.get('context_with_system') ?? []) fn({ messages }, ctx);

    const over = await runTool();
    assert.equal(over.skills.exceeded, true);
    assert.equal(over.skills.loadedBytes, large.bytes);
    assert.equal(over.skills.totalBytes, over.skills.listBytes + large.bytes);
    assert.equal(over.skills.overByBytes, over.skills.totalBytes - 2000);
    assert.equal(over.skills.skills[0].name, 'large');
    assert.equal(over.skills.skills[0].loadedBytes, large.bytes);

    await commands.get('tools').handler('', ctx);
    const rendered = notices.pop()!;
    assert.match(rendered, /OVER BUDGET/);
    assert.match(rendered, /large:/);

    budget = over.skills.totalBytes + 100;
    const raised = await runTool();
    assert.equal(raised.skills.exceeded, false);
    assert.equal(raised.skills.overByBytes, 0);

    for (const fn of handlers.get('session_shutdown') ?? []) fn({}, ctx);
    const afterShutdown = await runTool();
    assert.equal(afterShutdown.skills.loadedBytes, 0, 'session shutdown clears tracked loaded skills');
    assert.match(renderTools([], over.skills), /OVER BUDGET/);
  } finally { t.close(); }
});

test('skillBudgetBytes config option has a neutral default, round-trips, accepts 0 and rejects invalid values', () => {
  const t = tempDir('skill-budget-config-');
  try {
    assert.equal(DEFAULT_SETTINGS.skillBudgetBytes, DEFAULT_SKILL_BUDGET_BYTES);
    assert.ok(DEFAULT_SKILL_BUDGET_BYTES > 0);
    writeFileSync(join(t.dir, 'config.json'), JSON.stringify({ compactor: defaults.compactor, subagent: defaults.subagent }));
    const loaded = loadConfig(t.dir);
    assert.equal(loaded.skillBudgetBytes, DEFAULT_SKILL_BUDGET_BYTES);
    for (const valid of [0, 4096, 65_536]) {
      saveConfig(t.dir, { ...loaded, skillBudgetBytes: valid });
      assert.equal(loadConfig(t.dir).skillBudgetBytes, valid);
    }
    for (const bad of [-1, 1.5, '4096', null]) {
      writeFileSync(join(t.dir, 'config.json'), JSON.stringify({ ...loaded, skillBudgetBytes: bad }));
      assert.throws(() => loadConfig(t.dir), /Invalid profile config/, String(bad));
    }
  } finally { t.close(); }
});
