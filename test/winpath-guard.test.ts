import { test } from 'node:test';
import assert from 'node:assert/strict';
import { winPathRefusal } from '../src/winpath-guard.ts';
import { registerEffectApprovals } from '../src/authorization-hooks.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

for (const command of [
  'node C:/projetos/pi-optchat/scripts/ship.mjs --help',
  'cd ~/projetos/x && node --experimental-transform-types C:/projetos/pi-optchat/scripts/council.mjs',
  'ls C:\\projetos\\pi-optchat',
  'git -C "C:/projetos/Genexus18MCP" status',
])
  test(`refuses on Linux: ${command}`, () => assert.match(winPathRefusal(command, 'linux') ?? '', /~\/projetos.*projetos\/(pi-optchat|Genexus18MCP)/s));

for (const command of ['git commit -m "docs: C:/projetos/x vira ~/projetos/x"', 'echo C:/projetos/x', 'grep -rn "C:/projetos" src', 'node ~/projetos/pi-optchat/scripts/ship.mjs'])
  test(`allows on Linux: ${command}`, () => assert.equal(winPathRefusal(command, 'linux'), undefined));

test('Windows keeps its own paths', () => assert.equal(winPathRefusal('node C:/projetos/pi-optchat/scripts/ship.mjs', 'win32'), undefined));

test('the bash tool_call hook blocks a C:/projetos path before it runs on Linux', async () => {
  if (process.platform !== 'linux') return;
  delete process.env.OPTCHAT_WINPATH_GUARD;
  const hooks = new Map<string, (...args: any[]) => any>();
  registerEffectApprovals({ on(name: string, fn: (...args: any[]) => any) { hooks.set(name, fn); } } as unknown as ExtensionAPI, { enabled: false });
  const blocked = await hooks.get('tool_call')!({ toolName: 'bash', input: { command: 'node C:/projetos/pi-optchat/scripts/ship.mjs' } }, { cwd: '/tmp' });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /~\/projetos/);
});
