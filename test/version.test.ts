import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import optchat, { version } from '../src/index.ts';

test('the version shown in /optchat is the one in package.json', async () => {
  const manifest: { version: string } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(version, manifest.version);
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  optchat({ on() {}, events: { on: () => () => {} }, registerTool() {}, registerFlag() {}, registerShortcut() {}, registerMessageRenderer() {},
    registerCommand: (name: string, command: Parameters<ExtensionAPI['registerCommand']>[1]) => commands.set(name, command) } as unknown as ExtensionAPI);
  const titles: string[] = [];
  await commands.get('optchat')!.handler('', { mode: 'rpc', ui: {
    select: async (title: string) => { titles.push(title.split('\n')[0]); return undefined; },
  } } as unknown as ExtensionCommandContext);
  assert.deepEqual(titles, [`OptChat v${manifest.version}`]);
});
