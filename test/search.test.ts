import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/memory.ts';
import { SEARCH_PAGE, searchPage } from '../src/tools.ts';
import { removeDir } from './support.ts';

test('search finds original messages newest first, pages backwards, and never returns summaries or copies of memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-search-'));
  // Every summary the compactor writes mentions a trip no message talks about.
  const memory = new Memory(dir, async () => 'user: planned the Lisbon trip', () => {});
  try {
    memory.append('user', `${'filler '.repeat(100)}then the Banner moved, then the\nfinal line`);
    for (let i = 1; i <= 24; i++) memory.append(i % 2 ? 'user' : 'talk', `note ${i} about the banner`);
    memory.append('tool', 'zoom {"id":3,"n":1}');
    memory.append('echo', 'zoom: 3+1|user: note 3 about the banner');
    memory.append('tool', 'search {"text":"banner"}');
    await memory.settle(undefined, 'tree');
    assert.ok([...memory.tree.values()].some(s => s.text.includes('Lisbon')));
    assert.equal(searchPage(memory, 'lisbon'), 'No messages contain "lisbon".', 'summaries are not searched');

    const first = searchPage(memory, 'BANNER').split('\n');
    assert.equal(first[0], '25 messages contain "BANNER", newest first:');
    assert.deepEqual(first.slice(1, -1).map(line => Number(line.split(' ')[0])), Array.from({ length: SEARCH_PAGE }, (_, k) => 24 - k));
    assert.match(first[1], /^24 · \w{3} \w{3} \d\d \d{4} \d\d:\d\d · talk: note 24 about the banner$/);
    assert.equal(first.at(-1), 'Older matches: search again with before: 5.');

    const rest = searchPage(memory, 'banner', 5).split('\n');
    assert.equal(rest[0], '5 older messages contain "banner", newest first:');
    assert.deepEqual(rest.slice(1).map(line => Number(line.split(' ')[0])), [4, 3, 2, 1, 0]);
    assert.match(rest[5], /^0 · .* · user: …[a-z ]{40,} then the Banner moved, then the final line$/, 'a long message is cut around its match');
    assert.equal(searchPage(memory, 'banner', 0), 'No older messages contain "banner".');
    assert.match(searchPage(memory, 'the\nfinal line', 1), /\n0 · .* · user: …[\w ,]+ the final line$/, 'a match across lines is shown, flattened');
  } finally { await memory.close(); removeDir(dir); }
});

test('paged search reuses complete hit indexes and append invalidates them without changing page order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-search-cache-'));
  const memory = new Memory(dir, async () => 'summary', () => {});
  try {
    memory.append('user', 'needle oldest');
    memory.append('talk', 'needle middle');
    assert.deepEqual(memory.search('NEEDLE').map(entry => entry.i), [1, 0]);
    assert.deepEqual(memory.search('needle', 1).map(entry => entry.i), [0]);

    memory.append('user', 'needle newest');
    assert.deepEqual(memory.search('needle').map(entry => entry.i), [2, 1, 0]);
    assert.deepEqual(memory.search('NEEDLE', 2).map(entry => entry.i), [1, 0]);
  } finally { await memory.close(); removeDir(dir); }
});

test('query-hit cache bounds both retained queries and total message indexes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-search-cache-bounds-'));
  const memory = new Memory(dir, async () => 'summary', () => {});
  const cache = memory as unknown as { searchCache: Map<string, number[]>; searchCacheHits: number };
  try {
    for (let i = 0; i < 20_002; i++) memory.root.push({ i, kind: 'user', text: `common bucket-${i % 7}`, date: '2026-01-01', size: 12 });
    assert.equal(memory.search('common').length, 20_002);
    assert.equal(cache.searchCache.has('common'), false, 'a broad result is not retained');
    assert.equal(cache.searchCacheHits, 0);

    for (let i = 0; i < 7; i++) memory.search(`bucket-${i}`);
    assert.ok(cache.searchCacheHits <= 20_000, 'the combined cached result indexes stay within their budget');
    assert.equal(cache.searchCache.has('bucket-0'), false, 'the oldest result is evicted when the index budget is full');
    for (let i = 0; i < 9; i++) memory.search(`absent-${i}`);
    assert.equal(cache.searchCache.size, 8);
    assert.equal(cache.searchCache.has('absent-0'), false, 'the least recently used query is evicted');
    assert.equal(cache.searchCache.has('absent-8'), true);
    assert.ok(cache.searchCacheHits <= 20_000);
  } finally { await memory.close(); removeDir(dir); }
});

test('a search hit names the view line that holds it, so the agent can zoom from there; a hit that is its own line does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-search-line-'));
  // 300-byte summaries in a 1,500-byte view: the four oldest messages fold into one line.
  const memory = new Memory(dir, async input => input.part.l ? 's'.repeat(300) : `user: ${'s'.repeat(294)}`, () => {}, 1500);
  try {
    // Each message is summarized before the next, as each turn waits for summaries, so the batch finds its parents built.
    for (let i = 0; i < 8; i++) { memory.append('user', `${i} banner ${'.'.repeat(600)}`); await memory.settle(undefined, 'tree'); }
    assert.match(memory.render(), /^0\+4\|/m);
    const ids = searchPage(memory, 'banner').split('\n').slice(1).map(line => line.split(' · ')[0]);
    assert.deepEqual(ids, ['7', '6', '5', '4', '3 (in 0+4)', '2 (in 0+4)', '1 (in 0+4)', '0 (in 0+4)']);
  } finally { await memory.close(); removeDir(dir); }
});
