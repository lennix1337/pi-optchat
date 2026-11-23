import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import optchat from '../src/index.ts';
import { defaults, loadConfig, saveConfig } from '../src/profiles.ts';
import {
  DEFAULT_STOCKTAKE_DAYS,
  parseStocktakeDays,
  registerSkillStocktake,
  renderSkillStocktake,
  skillStocktake,
} from '../src/skill-stocktake.ts';
import { tempDir } from './support.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-23T12:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function writeSkill(root: string, name: string, description = `${name} skill`): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'SKILL.md');
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions for ${name}.\n`);
  return file;
}

const assistantCall = (offsetMs: number, calls: { id?: string; name: string; arguments: Record<string, unknown> }[]) => ({
  type: 'message',
  timestamp: iso(offsetMs),
  message: {
    role: 'assistant',
    stopReason: 'toolUse',
    content: calls.map(c => ({ type: 'toolCall', ...c })),
  },
});

const toolResult = (offsetMs: number, toolCallId: string, isError: boolean, text = isError ? 'ENOENT' : 'ok') => ({
  type: 'message',
  timestamp: iso(offsetMs),
  message: {
    role: 'toolResult',
    toolCallId,
    isError,
    content: [{ type: 'text', text }],
  },
});

test('skillStocktake counts SKILL.md reads across Pi session logs over last N days and flags never-used skills without deleting them', () => {
  const t = tempDir('skill-stocktake-');
  try {
    const home = join(t.dir, 'home');
    const agentDir = join(home, '.pi', 'agent');
    const skillsRoot = join(home, '.agents', 'skills');
    const cwd = join(t.dir, 'project');
    const projectSkills = join(cwd, '.agents', 'skills');
    const sessionsDir = join(agentDir, 'sessions');
    mkdirSync(join(sessionsDir, '--project-a--'), { recursive: true });
    mkdirSync(join(sessionsDir, '--project-b--'), { recursive: true });

    const alphaFile = writeSkill(skillsRoot, 'alpha');
    const betaFile = writeSkill(skillsRoot, 'beta');
    const gammaFile = writeSkill(projectSkills, 'gamma');
    const unusedFile = writeSkill(skillsRoot, 'unused-old');
    const protoFile = writeSkill(skillsRoot, 'constructor');

    const sessionA = [
      { type: 'session', version: 3, id: 's-a', timestamp: iso(-20 * DAY), cwd },
      assistantCall(-10 * DAY, [{ id: 'c1', name: 'read', arguments: { path: alphaFile } }]),
      toolResult(-10 * DAY + 100, 'c1', false),
      assistantCall(-5 * DAY, [{ id: 'c2', name: 'read', arguments: { path: '~/.agents/skills/alpha/SKILL.md' } }]),
      assistantCall(-4 * DAY, [{
        id: 'c3',
        name: 'multi_tool_use.parallel',
        arguments: {
          tool_uses: [
            { recipient_name: 'functions.read', parameters: { path: '.agents/skills/gamma/SKILL.md' } },
            { recipient_name: 'functions.read', parameters: { path: join(cwd, 'README.md') } },
          ],
        },
      }]),
      assistantCall(-3 * DAY, [{ id: 'c4', name: 'read_many', arguments: { files: [{ path: betaFile }, { path: join(skillsRoot, 'removed-skill', 'SKILL.md') }] } }]),
      assistantCall(-2 * DAY, [{ id: 'c5', name: 'skills_on_disk', arguments: { name: 'constructor' } }]),
      assistantCall(-1 * DAY, [{ id: 'c6', name: 'read', arguments: { path: unusedFile } }]),
      toolResult(-1 * DAY + 50, 'c6', true, 'Not run: refused'),
      assistantCall(-12 * 3600_000, [{ id: 'c6b', name: 'read', arguments: { path: alphaFile } }]),
      toolResult(-12 * 3600_000 + 50, 'c6b', true, 'ENOENT'),
      assistantCall(-40 * DAY, [{ id: 'c7', name: 'read', arguments: { path: unusedFile } }]),
    ];
    writeFileSync(
      join(sessionsDir, '--project-a--', 'session-a.jsonl'),
      `${sessionA.map(e => JSON.stringify(e)).join('\n')}\n{"type":"truncated`,
    );

    const sessionB = [
      {
        type: 'message',
        timestamp: iso(-2 * DAY),
        message: {
          role: 'user',
          content: [{ type: 'text', text: `<skill name="alpha" location="${alphaFile}">\nInstructions for alpha.\n</skill>\n\nRun it.` }],
        },
      },
    ];
    writeFileSync(join(sessionsDir, '--project-b--', 'session-b.jsonl'), `${sessionB.map(e => JSON.stringify(e)).join('\n')}\n`);

    const stalePath = join(sessionsDir, 'stale.jsonl');
    writeFileSync(stalePath, `${JSON.stringify(assistantCall(-50 * DAY, [{ id: 'old', name: 'read', arguments: { path: unusedFile } }]))}\n`);
    const oldDate = new Date(NOW - 45 * DAY);
    utimesSync(stalePath, oldDate, oldDate);

    const report = skillStocktake({ cwd, agentDir, home, sessionsDir, days: 30, now: NOW });
    assert.equal(report.days, 30);
    assert.equal(report.sessionsMissing, false);
    assert.equal(report.sessionsScanned, 2);

    assert.deepEqual(
      report.skills.map(s => ({ name: s.name, reads: s.reads, pruneCandidate: s.pruneCandidate })),
      [
        { name: 'alpha', reads: 3, pruneCandidate: false },
        { name: 'beta', reads: 1, pruneCandidate: false },
        { name: 'constructor', reads: 1, pruneCandidate: false },
        { name: 'gamma', reads: 1, pruneCandidate: false },
        { name: 'unused-old', reads: 0, pruneCandidate: true },
      ],
    );
    assert.deepEqual(report.pruneCandidates.map(s => s.name), ['unused-old']);
    assert.equal(report.skills.find(s => s.name === 'alpha')?.lastReadAt, NOW - 2 * DAY);
    assert.equal(report.skills.find(s => s.name === 'unused-old')?.lastReadAt, undefined);

    const output = renderSkillStocktake(report);
    assert.match(output, /last 30d/);
    assert.match(output, /alpha: 3 reads/);
    assert.match(output, /beta: 1 read\b/);
    assert.match(output, /unused-old: 0 reads \[prune candidate\]/);
    assert.match(output, /Prune candidates \(1.*report only.*\): unused-old/i);

    assert.equal(existsSync(unusedFile), true, 'stocktake is report-only and must never delete unused skills');
  } finally {
    t.close();
  }
});

test('skillStocktake matches reads through a directory junction or symlink to the skill root', () => {
  const t = tempDir('skill-stocktake-link-');
  try {
    const home = join(t.dir, 'home');
    const agentDir = join(home, '.pi', 'agent');
    const realSkills = join(t.dir, 'dotfiles-skills');
    const realSkillFile = writeSkill(realSkills, 'linked-skill');
    const agentsSkills = join(home, '.agents', 'skills');
    mkdirSync(agentsSkills, { recursive: true });
    symlinkSync(join(realSkills, 'linked-skill'), join(agentsSkills, 'linked-skill'), 'junction');

    const sessionsDir = join(agentDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 's.jsonl'),
      `${JSON.stringify(assistantCall(-1 * DAY, [{ id: 'l1', name: 'read', arguments: { path: realSkillFile } }]))}\n`,
    );

    const report = skillStocktake({ cwd: t.dir, agentDir, home, sessionsDir, days: 7, now: NOW });
    const row = report.skills.find(s => s.name === 'linked-skill');
    assert.ok(row);
    assert.equal(row.reads, 1);
    assert.equal(row.pruneCandidate, false);
  } finally {
    t.close();
  }
});

test('skillStocktake handles a missing sessions directory and empty skill installs honestly', () => {
  const t = tempDir('skill-stocktake-empty-');
  try {
    const home = join(t.dir, 'home');
    const agentDir = join(home, '.pi', 'agent');
    const missingSessions = join(agentDir, 'sessions');
    const cwd = join(t.dir, 'empty-cwd');
    mkdirSync(cwd, { recursive: true });

    const emptyReport = skillStocktake({ cwd, agentDir, home, sessionsDir: missingSessions, now: NOW });
    assert.equal(emptyReport.sessionsMissing, true);
    assert.equal(emptyReport.skills.length, 0);
    assert.match(renderSkillStocktake(emptyReport), /no installed skills found/i);

    writeSkill(join(home, '.agents', 'skills'), 'lonely');
    const missingReport = skillStocktake({ cwd, agentDir, home, sessionsDir: missingSessions, now: NOW });
    assert.equal(missingReport.sessionsMissing, true);
    assert.deepEqual(missingReport.pruneCandidates.map(s => s.name), ['lonely']);
    assert.match(renderSkillStocktake(missingReport), /sessions directory not found/i);
  } finally {
    t.close();
  }
});

test('parseStocktakeDays, /skill-stocktake command, profile config and optchat wiring work together', async () => {
  assert.equal(DEFAULT_STOCKTAKE_DAYS, 30);
  assert.equal(parseStocktakeDays(''), 30);
  assert.equal(parseStocktakeDays('14'), 14);
  assert.equal(parseStocktakeDays('7d'), 7);
  assert.equal(parseStocktakeDays('', 15), 15);
  for (const bad of ['0', '-5', '1.5', 'abc', '7 14']) {
    assert.throws(() => parseStocktakeDays(bad), /Usage: \/skill-stocktake/);
  }

  const t = tempDir('skill-stocktake-cmd-');
  try {
    const profileDir = join(t.dir, 'profile');
    mkdirSync(profileDir, { recursive: true });
    saveConfig(profileDir, { ...defaults, skillStocktakeDays: 14 });
    assert.equal(loadConfig(profileDir).skillStocktakeDays, 14);
    saveConfig(profileDir, defaults);
    assert.equal(loadConfig(profileDir).skillStocktakeDays, undefined);
    for (const invalid of [0, -1, 1.5, '14']) {
      writeFileSync(join(profileDir, 'config.json'), JSON.stringify({ ...defaults, skillStocktakeDays: invalid }));
      assert.throws(() => loadConfig(profileDir), /Invalid profile config/);
    }

    const home = join(t.dir, 'home');
    const agentDir = join(home, '.pi', 'agent');
    const sessionsDir = join(agentDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const usedFile = writeSkill(join(home, '.agents', 'skills'), 'used-recent');
    writeSkill(join(home, '.agents', 'skills'), 'never-used');
    writeFileSync(
      join(sessionsDir, 's.jsonl'),
      `${JSON.stringify(assistantCall(-10 * DAY, [{ id: 'r1', name: 'read', arguments: { path: usedFile } }]))}\n`,
    );

    const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
    const notices: { text: string; level: string }[] = [];
    const pi = {
      registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, def),
      getCommands: () => [{ name: 'skill:used-recent', source: 'skill', sourceInfo: { path: usedFile } }],
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd: t.dir,
      ui: { notify: (text: string, level = 'info') => notices.push({ text, level }) },
    } as unknown as ExtensionCommandContext;

    registerSkillStocktake(pi, { agentDir, home, sessionsDir, defaultDays: () => 14, now: () => NOW });
    assert.ok(commands.has('skill-stocktake'));

    await commands.get('skill-stocktake')!.handler('', ctx);
    assert.equal(notices.at(-1)?.level, 'info');
    assert.match(notices.at(-1)!.text, /last 14d/);
    assert.match(notices.at(-1)!.text, /used-recent: 1 read\b/);
    assert.match(notices.at(-1)!.text, /never-used: 0 reads \[prune candidate\]/);

    await commands.get('skill-stocktake')!.handler('5d', ctx);
    assert.match(notices.at(-1)!.text, /last 5d/);
    assert.match(notices.at(-1)!.text, /Prune candidates \(2.*never-used, used-recent/);

    await commands.get('skill-stocktake')!.handler('bogus', ctx);
    assert.equal(notices.at(-1)?.level, 'error');
    assert.match(notices.at(-1)!.text, /Usage: \/skill-stocktake/);

    const optchatCommands = new Set<string>();
    optchat({
      on() {},
      events: { on: () => () => {} },
      registerTool() {},
      registerFlag() {},
      registerCommand: (name: string) => optchatCommands.add(name),
      registerShortcut() {},
      registerMessageRenderer() {},
    } as unknown as ExtensionAPI);
    assert.equal(optchatCommands.has('skill-stocktake'), true, 'optchat extension must register /skill-stocktake');
  } finally {
    t.close();
  }
});
