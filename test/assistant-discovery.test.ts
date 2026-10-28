import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import { withTempDir } from './support.ts';

test('fresh native loader discovers assistant commands and manual activation guidance without this chat', async () => withTempDir('assistant-discovery-', async dir => {
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: join(dir, 'agent'), settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noContextFiles: true, noPromptTemplates: true, additionalSkillPaths: [fileURLToPath(new URL('../skills/personal-assistant', import.meta.url))] });
  await loader.reload();
  const skill = loader.getSkills().skills.find(value => value.name === 'personal-assistant');
  assert.ok(skill);
  assert.match(skill.description, /inbox.*tasks.*input.*evidence/i);
  assert.match(skill.description, /start.*stop.*health.*back up.*restore/i);
  assert.equal(fileURLToPath(new URL('../skills/personal-assistant/SKILL.md', import.meta.url)), skill.filePath);
  // A fresh session gets the exact operation commands and their limits from the skill alone.
  const body = readFileSync(skill.filePath, 'utf8');
  for (const name of ['start', 'stop', 'health', 'backup', 'restore', 'autostart']) {
    assert.match(body, new RegExp(`node assistant/scripts/${name}\\.mjs`), name);
    assert.ok(readFileSync(fileURLToPath(new URL(`../assistant/scripts/${name}.mjs`, import.meta.url)), 'utf8').length, `${name} script exists`);
  }
  assert.match(body, /operator permission/i);
  assert.match(body, /--yes/);
}));
