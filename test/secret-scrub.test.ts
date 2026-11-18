import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../src/secret-scrub.ts';
import { Memory, type Compression } from '../src/memory.ts';
import { FileStore } from '../src/store.ts';
import { Crew } from '../src/crew.ts';

function withTempDir(fn: (dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), 'optchat-scrub-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('scrubSecrets masks all supported secret formats with [segredo:tipo] and is idempotent', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['slack xoxb', 'token=xo' + 'xb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx', /\[segredo:slack\]/],
    ['slack xoxp', 'xo' + 'xp-998877665544-112233445566-ZyXwVuTsRqPoNmLkJiHgFeDc', /\[segredo:slack\]/],
    ['github ghp', 'ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD', /\[segredo:github\]/],
    ['github pat', 'github_pat_11ABCDEFG0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', /\[segredo:github\]/],
    ['openai sk', 'sk-proj-AbCdEf123456GhIjKl789012MnOpQr345678StUvWx', /\[segredo:api_key\]/],
    ['aws akia', 'AKIAIOSFODNN7EXAMPLE', /\[segredo:aws\]/],
    ['google aiza', 'AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGew123', /\[segredo:api_key\]/],
    ['jwt', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', /\[segredo:jwt\]/],
    ['bearer', 'Authorization: Bearer tok_live_9876543210fedcbaABCDEF', /Authorization: Bearer \[segredo:bearer\]/],
    ['env line', 'DATABASE_SECRET=my_super_secret_db_pass_9911', /DATABASE_SECRET=\[segredo:env\]/],
    ['export env', 'export SENTRY_AUTH_TOKEN="sntrys_AbCdEf1234567890"', /export SENTRY_AUTH_TOKEN=\[segredo:env\]/],
    ['url auth', 'https://deploy:s3cr3tP4ssw0rd@registry.example.com/pkg', /https:\/\/\[segredo:url_auth\]@registry\.example\.com\/pkg/],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----', /\[segredo:private_key\]/],
    ['high entropy', 'key is 9fK2mP8xQ4vL7nR3wZ6yB1cT5jH0dG8sA end', /key is \[segredo:entropy\] end/],
  ];

  for (const [label, input, expected] of cases) {
    const scrubbed = scrubSecrets(input);
    assert.match(scrubbed, expected, `${label}: expected ${expected}, got ${scrubbed}`);
    assert.equal(scrubSecrets(scrubbed), scrubbed, `${label}: scrubSecrets must be idempotent`);
  }
});

test('scrubSecrets preserves paths, 40-hex commit hashes, UUIDs, PR IDs, and credential-free URLs', () => {
  const safeInputs = [
    'C:\\Projetos\\pi-optchat\\worktrees\\agy-oh-scrub\\src\\memory.ts',
    '/home/user/projects/pi-optchat/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
    'commit a3f5b8c9d1e2f4a6b7c8d9e0f1a2b3c4d5e6f7a8',
    'sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    '550e8400-e29b-41d4-a716-446655440000',
    'PR #288 and PR-1234 merged cleanly',
    'https://github.com/jonaslsaa/pi-optchat/pull/288?w=1&tab=files',
    'PWD=/home/user/pi-optchat\nNODE_ENV=production\nPORT=3000\nSSL_KEY_PATH=/etc/ssl/key.pem\nMAX_TOKENS=4096',
    'package sk-configuration-manager-service loaded',
  ];

  for (const sample of safeInputs) {
    assert.equal(scrubSecrets(sample), sample, `must not alter safe text: ${sample}`);
  }
});

test('Memory scrubs echo leaves before persisting to FileStore and before compactor summarization', async () => {
  await withTempDir(async dir => {
    const seenByCompactor: Compression[] = [];
    const memory = new Memory(dir, async input => {
      seenByCompactor.push(input);
      return input.source.slice(0, 120);
    });
    const secret = 'ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD';
    const bearer = 'Bearer tok_live_9876543210fedcbaABCDEF';
    const commit = 'a3f5b8c9d1e2f4a6b7c8d9e0f1a2b3c4d5e6f7a8';

    memory.append('tool', `bash: curl ${commit} ${'y'.repeat(550)}`);
    memory.append('echo', `bash: ${commit} ${secret} ${bearer} ${'x'.repeat(600)}`);
    await memory.settle(undefined, 'tree');
    await memory.close();

    // 1. Persisted log on disk must not contain the raw secrets, but must keep commit hash.
    const mainDir = join(dir, 'main');
    const logFiles = readdirSync(mainDir).filter(f => f.endsWith('.jsonl'));
    assert.equal(logFiles.length, 1);
    const diskLog = readFileSync(join(mainDir, logFiles[0]), 'utf8');
    assert.doesNotMatch(diskLog, new RegExp(secret));
    assert.doesNotMatch(diskLog, /tok_live_9876543210fedcbaABCDEF/);
    assert.match(diskLog, /\[segredo:github\]/);
    assert.match(diskLog, /\[segredo:bearer\]/);
    assert.match(diskLog, new RegExp(commit));

    // 2. Compactor inputs (both echo source and tool result) must never see raw secrets.
    assert.ok(seenByCompactor.length >= 2);
    for (const call of seenByCompactor) {
      assert.doesNotMatch(call.source, new RegExp(secret));
      assert.doesNotMatch(call.result ?? '', new RegExp(secret));
      assert.doesNotMatch(call.source, /tok_live_9876543210fedcbaABCDEF/);
      assert.doesNotMatch(call.result ?? '', /tok_live_9876543210fedcbaABCDEF/);
    }
  });
});

test('FileStore.append scrubs echo entries directly', async () => {
  await withTempDir(dir => {
    const store = new FileStore(dir);
    store.load();
    const secret = 'xo' + 'xb-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx';
    store.append({ i: 0, kind: 'echo', text: `slack=${secret}`, date: '2026-11-18T00:00:00.000Z', size: 80 });
    store.close();

    const mainDir = join(dir, 'main');
    const logFiles = readdirSync(mainDir).filter(f => f.endsWith('.jsonl'));
    const raw = readFileSync(join(mainDir, logFiles[0]), 'utf8');
    assert.doesNotMatch(raw, new RegExp(secret));
    assert.match(raw, /\[segredo:slack\]/);
  });
});

test('Crew scrubs specialist memory writes, proposals, and worker run digests', async () => {
  await withTempDir(async dir => {
    const crew = new Crew(dir);
    const sk = 'sk-proj-AbCdEf123456GhIjKl789012MnOpQr345678StUvWx';
    const akia = 'AKIAIOSFODNN7EXAMPLE';
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const commit = 'a3f5b8c9d1e2f4a6b7c8d9e0f1a2b3c4d5e6f7a8';

    crew.propose('harness', 'run-1', `Keep ${sk} out; commit ${commit}`);
    const pendingRaw = readFileSync(join(dir, 'pending.json'), 'utf8');
    assert.doesNotMatch(pendingRaw, new RegExp(sk));
    assert.match(pendingRaw, /\[segredo:api_key\]/);
    assert.match(pendingRaw, new RegExp(commit));

    crew.write('harness', 'memory', `AWS=${akia}\nCommit=${commit}\n`);
    const memoryMd = readFileSync(join(dir, 'harness', 'memory.md'), 'utf8');
    assert.doesNotMatch(memoryMd, new RegExp(akia));
    assert.match(memoryMd, /\[segredo:aws\]/);
    assert.match(memoryMd, new RegExp(commit));

    crew.record({
      id: 'run-1',
      kind: 'code',
      project: 'harness',
      state: 'completed',
      task: 'Goal: test',
      cwd: 'C:\\Projetos\\pi-optchat',
      model: 'test-model',
      thinking: 'medium',
      parentSession: 'main',
      depth: 1,
      guidance: [],
      started: 1000,
      ended: 2000,
      report: `Token was ${jwt} on commit ${commit}`,
    });
    const tree = crew.memory('harness');
    assert.equal(tree.root.length, 1);
    assert.doesNotMatch(tree.root[0].text, /eyJhbGci/);
    assert.match(tree.root[0].text, /\[segredo:jwt\]/);
    assert.match(tree.root[0].text, new RegExp(commit));
    await crew.closeAll();
  });
});

test('identifiers memory needs verbatim are not taken for secrets', () => {
  const ids = [
    'crates/gxengine-core/src/Parser2_spec_reader_tests.rs',
    'toolu_01AbCdEf2GhIjKl3MnOpQr4StU',
    'WriteRecordV2_IsAtomic_UnderConcurrentWriters8',
    'fix/evo3-generator-parity-shared-cache-2045',
    'Settings/Profiles/Default7/Workspace-2026x11',
    'SharedHostRecordReadResult7Tests',
    'Issue599ReproDoesNotThrowWhenEmpty',
  ];
  for (const id of ids) assert.equal(scrubSecrets(`see ${id} here`), `see ${id} here`, id);
});

test('a Sentry user token is scrubbed', () => {
  assert.equal(scrubSecrets('--access-token sntryu_9f3a7c2e1b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8 x'), '--access-token [segredo:api_key] x');
});
