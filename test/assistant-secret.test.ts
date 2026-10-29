import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerAssistantSecrets } from '../src/assistant-secret.ts';
import { Vault, VaultError } from '../assistant/src/secrets/vault.ts';
import { osKeyProtector } from '../assistant/src/secrets/protector.ts';
import { CANARY, contains, diskBytes, memoryProtector, privateDir } from '../assistant/test/vault-support.ts';

const PASTE = (s: string) => `\u001b[200~${s}\u001b[201~`;

function harness(vault: Vault) {
  let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  const other: string[] = [];
  // Any API other than registerCommand (sendMessage, appendEntry, ...) would put text in the session or model context.
  const pi = new Proxy({ registerCommand: (_: string, o: { handler: typeof handler }) => { handler = o.handler; } }, {
    get: (target, key) => key in target ? (target as Record<string | symbol, unknown>)[key] : (...args: unknown[]) => { other.push(`${String(key)} ${JSON.stringify(args)}`); },
  }) as unknown as ExtensionAPI;
  registerAssistantSecrets(pi, () => ({ vault, profileId: 'p' }));
  const notices: string[] = [], screens: string[] = [];
  let keys: string[] = [];
  const ctx = (mode = 'tui', hasUI = true) => ({ mode, hasUI, ui: {
    notify: (text: string) => notices.push(text),
    custom: async (factory: (...a: unknown[]) => { render(w: number): string[]; handleInput(d: string): void }) => {
      let result: unknown, finished = false;
      const tui = { requestRender: () => screens.push(component.render(80).join('\n')) };
      const component = await factory(tui, {}, {}, (value: unknown) => { result = value; finished = true; });
      screens.push(component.render(80).join('\n'));
      for (const key of keys) { if (finished) break; component.handleInput(key); }
      return result;
    },
  } }) as unknown as ExtensionCommandContext;
  return { notices, screens, other, ctx, typing: (k: string[]) => { keys = k; }, run: (args: string, c = ctx()) => handler(args, c) };
}

async function loopback() {
  const received: string[] = [];
  const server = createServer((req, res) => { received.push(String(req.headers.authorization ?? '')); res.end('ok'); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { received, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(r => server.close(() => r())) };
}

const login = (origin: string) => async (value: Buffer) => {
  const res = await fetch(`${origin}/login`, { method: 'POST', headers: { authorization: `Bearer ${value.toString('utf8')}` } });
  if (!res.ok) throw new Error('login failed');
};

test('a secret typed in the masked dialog reaches only the consented origin and never the screen, session or notices', () => privateDir('secret-cmd-', async dir => {
  const vault = await Vault.open({ databasePath: join(dir, 'vault.db'), protector: process.platform === 'win32' ? osKeyProtector() : memoryProtector().protector });
  const bank = await loopback(), evil = await loopback();
  const h = harness(vault);
  try {
    h.typing([PASTE(CANARY), 'x', '\u007f', '\r']);
    await h.run(`add ${bank.origin} login`);
    const stored = /Stored as (sec_[A-Za-z0-9_-]{22})/.exec(h.notices.at(-1)!);
    assert.ok(stored, h.notices.at(-1));
    const ref = stored[1]!;
    assert.ok(h.screens.some(s => s.includes('•'.repeat(32))), 'the dialog shows a mask');
    for (const text of [...h.screens, ...h.notices, ...h.other]) assert.ok(!contains(text, CANARY), 'the value is never displayed or emitted');
    assert.deepEqual(h.other, [], 'nothing was sent to the session or the model');

    await vault.inject(ref, { profileId: 'p', origin: bank.origin, action: 'login' }, login(bank.origin));
    assert.deepEqual(bank.received, [`Bearer ${CANARY}`], 'the consented origin received exactly the typed value (paste, then x deleted)');
    await assert.rejects(vault.inject(ref, { profileId: 'p', origin: evil.origin, action: 'login' }, login(evil.origin)), (e: unknown) => e instanceof VaultError && e.code === 'binding_mismatch');
    await assert.rejects(vault.inject(ref, { profileId: 'agent-2', origin: bank.origin, action: 'login' }, login(bank.origin)), (e: unknown) => e instanceof VaultError && e.code === 'binding_mismatch');
    assert.deepEqual(evil.received, [], 'a changed origin receives nothing'); assert.equal(bank.received.length, 1, 'another profile cannot use it');

    await h.run('list');
    assert.match(h.notices.at(-1)!, new RegExp(ref)); assert.ok(!contains(h.notices.at(-1)!, CANARY));
    h.typing([PASTE('rotated-value'), '\r']); await h.run(`rotate ${ref}`); assert.match(h.notices.at(-1)!, /Rotated/);
    await vault.inject(ref, { profileId: 'p', origin: bank.origin, action: 'login' }, login(bank.origin));
    assert.equal(bank.received.at(-1), 'Bearer rotated-value');
    await h.run(`revoke ${ref}`); assert.match(h.notices.at(-1)!, /Revoked/);
    await assert.rejects(vault.inject(ref, { profileId: 'p', origin: bank.origin, action: 'login' }, login(bank.origin)), (e: unknown) => e instanceof VaultError && e.code === 'secret_revoked');
  } finally { vault.close(); await bank.close(); await evil.close(); }
  assert.ok(!contains(diskBytes(dir), CANARY), 'nothing readable left on disk');
}));

test('entry is interactive-terminal only; cancel, empty and bad origins store nothing', () => privateDir('secret-cmd-', async dir => {
  const vault = await Vault.open({ databasePath: join(dir, 'vault.db'), protector: memoryProtector().protector });
  const h = harness(vault);
  try {
    h.typing([PASTE(CANARY), '\r']);
    for (const c of [h.ctx('rpc', true), h.ctx('print', false), h.ctx('tui', false)]) {
      await h.run('add https://bank.example login', c); assert.match(h.notices.at(-1)!, /only in the interactive terminal/);
    }
    assert.deepEqual(h.screens, [], 'no dialog opened outside the terminal');
    h.typing([PASTE(CANARY), '\u001b']); await h.run('add https://bank.example login'); assert.match(h.notices.at(-1)!, /Cancelled/);
    h.typing(['\r']); await h.run('add https://bank.example login'); assert.match(h.notices.at(-1)!, /Cancelled/);
    h.typing([PASTE(CANARY), '\r']); await h.run('add https://bank.example/path login'); assert.match(h.notices.at(-1)!, /refused \(invalid_binding\)/);
    await h.run('add https://bank.example'); assert.match(h.notices.at(-1)!, /Usage/);
    await h.run('revoke sec_AAAAAAAAAAAAAAAAAAAAAA'); assert.match(h.notices.at(-1)!, /refused \(secret_unknown\)/);
    assert.deepEqual(vault.list('p'), []);
    for (const text of [...h.screens, ...h.notices, ...h.other]) assert.ok(!contains(text, CANARY));
  } finally { vault.close(); }
}));
