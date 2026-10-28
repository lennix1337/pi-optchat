import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(fileURLToPath(new URL('../skills/personal-assistant/SKILL.md', import.meta.url)), skill.filePath);
}));
