// Disposable-source negative controls: removing each honesty guard in setup.ts must fail a setup test.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'assistant-setup-mutants-'));
const variants = [
  ['present-is-ready', "observation.kind === 'present' ? 'not_verified' : 'needs_setup'", "observation.kind === 'present' ? 'ready' : 'needs_setup'"],
  ['no-evidence', 'if (!observation.evidence) return', 'if (false) return'],
  ['stale', 'if (!(now - observation.at <= maxAgeMs)) return', 'if (false) return'],
  ['timeout-is-ready', "? { status: 'not_verified', detail: `Sem resposta", "? { status: 'ready', detail: `Sem resposta"],
  ['identity-mismatch', ' || (s.expectedAccount !== undefined && s.observedAccount !== s.expectedAccount)', ''],
  ['revoked', "if (s.revoked) return { kind: 'failed'", "if (false) return { kind: 'failed'"],
  ['url-credentials', ' || parsed.username || parsed.password', ''],
  ['http-status', "if (!res.ok) return { kind: 'failed'", "if (false) return { kind: 'failed'"],
  ['inference-consent', "if (options.consent !== true) throw", 'if (false) throw'],
  ['declined-label', 'if (declined.has(component.id)) return', 'if (false) return'],
  ['correct-authority', 'this.view.correct({ sourceId: item.sourceId, ref: item.ref, originalHash: item.originalHash, text, kind: \'fact\', reason }, authority)', 'this.view.correct({ sourceId: item.sourceId, ref: item.ref, originalHash: item.originalHash, text, kind: \'fact\', reason }, (this.view as any).authority)'],
];
let killed = 0;
try {
  for (const [name, before, after] of variants) {
    const dir = join(root, name); mkdirSync(join(dir, 'test'), { recursive: true });
    cpSync(join(sourceRoot, 'src'), join(dir, 'src'), { recursive: true });
    cpSync(join(sourceRoot, 'package.json'), join(dir, 'package.json'));
    for (const file of ['setup.test.ts', 'onboarding.test.ts']) cpSync(join(sourceRoot, 'test', file), join(dir, 'test', file));
    const file = join(dir, 'src', 'setup.ts');
    const source = readFileSync(file, 'utf8'); assert.equal(source.split(before).length, 2, `nonunique mutant ${name}`);
    writeFileSync(file, source.replace(before, after));
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', join(dir, 'test', 'setup.test.ts'), join(dir, 'test', 'onboarding.test.ts')], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 1, `${name} survived: ${result.error ?? ''}`);
    assert.match(result.stdout, /AssertionError|ERR_ASSERTION|Missing expected exception/, `${name}: failed for an unexpected reason`);
    killed++; console.log(`killed ${name}`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify({ mutants: variants.length, killed, survivors: variants.length - killed }));
