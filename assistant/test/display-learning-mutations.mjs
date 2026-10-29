import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'display-learning-mutations-'));
const source = readFileSync('assistant/src/memory/display-learning.ts', 'utf8');
const mutations = [
  ['profile-binding', "if (b.profileId !== this.profile) fail('stale_binding');", 'void b;'],
  ['authority', "if (authority !== this.authority) fail('unauthorized');", 'void authority;'],
  ['decision-authority', "this.authorized(authority); if (!validText(reason)) fail('invalid_reason');\n    return immediate(this.db, () => {\n      const p = this.checked(binding); this.baseCurrent(p);", "if (!validText(reason)) fail('invalid_reason');\n    return immediate(this.db, () => {\n      const p = this.checked(binding); this.baseCurrent(p);"],
  ['apply-authority', "  apply(binding: DisplayBinding, authority: object): DisplayProposal {\n    this.authorized(authority);", "  apply(binding: DisplayBinding, authority: object): DisplayProposal {\n    void authority;"],
  ['revert-authority', "this.authorized(authority); if (!validText(reason)) fail('invalid_reason');\n    return immediate(this.db, () => {\n      const p = this.checked(binding); if (p.state !== 'applied')", "if (!validText(reason)) fail('invalid_reason');\n    return immediate(this.db, () => {\n      const p = this.checked(binding); if (p.state !== 'applied')"],
  ['candidate', "if (!validText(candidate)) fail('invalid_candidate');", 'void candidate;'],
  ['no-improvement', 'measurement.candidate.score > measurement.baseline.score', 'measurement.candidate.score >= measurement.baseline.score'],
  ['binding', "if (p.baseRevision !== b.baseRevision || p.baseHash !== b.baseHash || p.candidateHash !== b.candidateHash || p.datasetHash !== b.datasetHash || b.datasetHash !== RETAINED_DATASET_HASH) fail('stale_binding');", 'void b;'],
  ['baseline', "if (current.revision !== p.baseRevision || current.hash !== p.baseHash) fail('stale_baseline');", 'void current; void p;'],
  ['measure-replay', "if (p.state !== 'proposed') fail('proposal_not_measurable');", 'void p;'],
  ['decision-state', "if (p.state !== 'measured' || !['approve', 'reject'].includes(decision)) fail('proposal_not_decidable');", 'void p;'],
  ['apply-state', "if (p.state !== 'approved') fail('proposal_not_approved');", 'void p;'],
  ['revert-state', "if (p.state !== 'applied') fail('proposal_not_applied');", 'void p;'],
  ['reason', "if (!validText(reason)) fail('invalid_reason');", 'void reason;'],
  ['revert-reason', "this.authorized(authority); if (!validText(reason)) fail('invalid_reason');\n    return immediate(this.db, () => {\n      const p = this.checked(binding); if (p.state !== 'applied')", "this.authorized(authority);\n    return immediate(this.db, () => {\n      const p = this.checked(binding); if (p.state !== 'applied')"],
  ['stale-applied', "if (current.revision !== p.appliedRevision || current.hash !== p.candidateHash) fail('stale_applied');", 'void current;'],
  ['invalid-decision', "p.state !== 'measured' || !['approve', 'reject'].includes(decision)", "p.state !== 'measured'"],
];
try {
  mkdirSync(join(root, 'src', 'memory'), { recursive: true }); mkdirSync(join(root, 'src', 'store'), { recursive: true }); mkdirSync(join(root, 'test'), { recursive: true });
  for (const file of ['hash.ts', 'memory/retained-evaluator.ts', 'store/transaction.ts']) copyFileSync(join('assistant', 'src', file), join(root, 'src', file));
  copyFileSync('assistant/test/display-learning.test.ts', join(root, 'test/display-learning.test.ts'));
  copyFileSync('assistant/test/display-learning-guards.test.ts', join(root, 'test/display-learning-guards.test.ts'));
  for (const [name, before, after] of mutations) {
    if (!source.includes(before)) throw new Error(`missing mutation anchor ${name}`);
    writeFileSync(join(root, 'src/memory/display-learning.ts'), source.replace(before, after));
    const result = spawnSync(process.execPath, ['--test', join(root, 'test/display-learning.test.ts'), join(root, 'test/display-learning-guards.test.ts')], { encoding: 'utf8', timeout: 30000 });
    if (result.error || result.status === 0 || !/AssertionError|ERR_ASSERTION/.test(result.stdout + result.stderr)) throw new Error(`mutation not killed by assertion: ${name}: ${result.stdout} ${result.stderr}`);
    console.log(`${name}: killed`);
  }
} finally { rmSync(root, { recursive: true, force: true }); }
