import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const assistant = fileURLToPath(new URL('../', import.meta.url));
const cases = [
  ['relay-connect-early-data', '../../computer/relay-policy.mjs', 'if (head.length) return undefined;', ''],
  ['relay-connect-authority', '../../computer/relay-policy.mjs', 'contexts.get(authority?.toLowerCase())', 'contexts.values().next().value'],
  ['relay-host-count', '../../computer/relay-policy.mjs', 'hosts.length !== 1', 'false'],
  ['relay-host-binding', '../../computer/relay-policy.mjs', "req.headers.host?.toLowerCase() !== new URL(origin).host", 'false'],
  ['relay-method', '../../computer/relay-policy.mjs', "!['GET', 'HEAD'].includes(req.method)", 'false'],
  ['relay-path', '../../computer/relay-policy.mjs', "!req.url?.startsWith('/')", 'false'],
  ...['transfer-encoding', 'content-length', 'proxy-authorization'].map(header => [`relay-${header}`, '../../computer/relay-policy.mjs', `req.headers['${header}'] !== undefined`, 'false']),
  ...['authorization', 'cookie', 'upgrade'].map(header => [`relay-${header}`, '../../computer/relay-policy.mjs', `req.headers.${header} !== undefined`, 'false']),
  ['relay-concurrency', '../../computer/relay-policy.mjs', 'pending >= 16', 'false'],
  ['relay-burst', '../../computer/relay-policy.mjs', 'issued >= 512', 'false'],
  ['target-owner', 'manager.ts', "info.Config?.Labels?.[OWNER_LABEL] !== this.options.owner", 'false'],
  ['target-network-none', 'manager.ts', "info.HostConfig?.NetworkMode !== 'none'", 'false'],
  ['target-host-mount', 'manager.ts', 'info.Mounts?.length !== 0', 'false'],
  ['target-read-only', 'manager.ts', 'info.HostConfig?.ReadonlyRootfs !== true', 'false'],
  ['target-immutable-id', 'manager.ts', "!/^[a-f0-9]{64}$/.test(info.Id ?? '')", 'false'],
  ['target-inspection', 'manager.ts', "if (result.code !== 0) fail('computer_inspection_failed');", ''],
  ['target-postawait', 'manager.ts', '    this.usable(id, row.container);\n    return info.Id;', '    return info.Id;'],
  ['origin-grant', 'network.ts', "if (!grantedOrigins.includes(url.origin)) return { ok: false, reason: 'origin_not_granted' };", ''],
  ['method', 'egress.ts', "!['GET', 'HEAD'].includes(r.method)", 'false'],
  ['header-allowlist', 'egress.ts', '!safeHeaders.has(name)', 'false'],
  ['header-framing', 'egress.ts', '/[\\r\\n\\0]/.test(value)', 'false'],
  ['credentials', 'network.ts', "if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' };", ''],
  ['dns-mixed-answer', 'network.ts', 'resolved.some(address => isIP(address) === 0 || isInternalHost(address))', 'false'],
  ['empty-dns', 'egress.ts', "if (!addresses.length) throw new Error('egress_unresolved');", ''],
  ['admission-after-dns', 'egress.ts', '  policy.admit();\n  if (!addresses.length)', '  if (!addresses.length)'],
  ['tls-verification', 'egress.ts', 'rejectUnauthorized: true', 'rejectUnauthorized: false'],
  ['single-address-family', 'egress.ts', 'family: isIP(address)', 'family: undefined'],
  ['pin-address', 'egress.ts', 'callback(null, address, isIP(address))', "callback(null, '8.8.8.8', 4)"],
  ['no-pooling', 'egress.ts', 'agent: false', 'agent: true'],
  ['response-cookie', 'egress.ts', 'responseHeaders.has(name)', 'true'],
  ['response-bound', 'egress.ts', 'size > MAX_RESPONSE_BYTES', 'false', 2],
  ['response-admission', 'egress.ts', '          policy.admit();', ''],
  ['response-encoding', 'egress.ts', "response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity'", 'false'],
];
const dir = mkdtempSync(join(tmpdir(), 'browser-egress-mutants-'));
try {
  cpSync(join(assistant, 'src'), join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'test'));
  mkdirSync(join(dir, 'computer'));
  cpSync(join(assistant, 'computer', 'relay-policy.mjs'), join(dir, 'computer', 'relay-policy.mjs'));
  const tests = ['computer-egress.test.ts', 'computer-egress-response.test.ts', 'computer-relay-policy.test.mjs', 'computer-egress-target.test.ts'];
  for (const name of tests) cpSync(join(assistant, 'test', name), join(dir, 'test', name));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const run = () => spawnSync(process.execPath, ['--test', ...tests.map(t => `test/${t}`)], { cwd: dir, encoding: 'utf8', timeout: 10_000, windowsHide: true });
  const baseline = run(); assert.ifError(baseline.error); assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  for (const [name, file, from, to, count = 1] of cases) {
    const path = join(dir, 'src', 'computer', file);
    const original = readFileSync(path, 'utf8');
    assert.equal(original.split(from).length - 1, count, `anchor ${name}`);
    try {
      writeFileSync(path, original.replaceAll(from, to));
      const result = run(); assert.ifError(result.error);
      assert.equal(result.status, 1, `${name}: survived/crashed ${result.stdout}${result.stderr}`);
      assert.match(result.stdout + result.stderr, /ERR_ASSERTION/, `${name}: not an assertion failure`);
      console.log(`killed ${name}`);
    } finally { writeFileSync(path, original); }
  }
  console.log(`${cases.length}/${cases.length} killed; baseline passed`);
} finally { rmSync(dir, { recursive: true }); }
