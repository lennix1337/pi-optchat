import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('snapshot summary groups string references by owner and safe property without exposing contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heap-retainers-'));
  try {
    const file = join(dir, 'test.heapsnapshot');
    const snapshot = {
      snapshot: { node_count: 4, meta: { node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'], node_types: [['synthetic', 'object', 'string']], edge_fields: ['type', 'name_or_index', 'to_node'], edge_types: [['property', 'weak']] } },
      nodes: [0, 0, 1, 0, 1, 1, 1, 2, 16, 3, 2, 2, 3, 80, 0, 2, 3, 4, 40, 0],
      edges: [0, 4, 5, 0, 5, 10, 0, 6, 15, 1, 0, 10],
      strings: ['root', 'Object', 'private content', 'more private content', 'root', 'text', 'private-key'],
    };
    writeFileSync(file, JSON.stringify(snapshot));
    const child = spawnSync(process.execPath, ['src/heap-snapshot-summary.mjs', file], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.deepEqual(result.stringRetainers, [
      { ownerType: 'object', edge: 'text', references: 1, referencedSelfBytes: 80 },
      { ownerType: 'object', edge: '(other property)', references: 1, referencedSelfBytes: 40 },
    ]);
    assert.doesNotMatch(child.stdout, /private/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
