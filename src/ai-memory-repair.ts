import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FileStore } from './store.ts';
import { isEntry, type Entry, type Summary } from './memory.ts';
import { AI_MEMORY_FORMAT, aiMemoryWriter, blockPage, type PageWriter } from './ai-memory.ts';

/** Read-only snapshot: never opens Memory's scheduler, rewrites its view, or changes its forward-sync cursor. */
export function repairSnapshot(directory: string) {
  if (!existsSync(join(directory, 'main')) || !existsSync(join(directory, 'tree'))) throw new Error('Existing OptChat main/tree directories required.');
  const saved = new FileStore(directory, warning => { throw new Error(warning); }).load();
  if (!saved.entries.every(isEntry)) throw new Error('Invalid OptChat original records; repair refused.');
  const root: Entry[] = saved.entries.sort((a, b) => a.i - b.i);
  if (root.some((entry, index) => entry.i !== index)) throw new Error('Noncontiguous OptChat originals; repair refused.');
  const tree = new Map<string, Summary>();
  for (const value of saved.tree) {
    if (typeof value !== 'object' || !value) continue;
    const node = value as Summary;
    if (Number.isSafeInteger(node.l) && Number.isSafeInteger(node.i) && typeof node.text === 'string') tree.set(`${node.l}/${node.i}`, node);
  }
  return { root, node: ({ l, i }: { l: number; i: number }) => tree.get(`${l}/${i}`) };
}

/** Explicit bounded repair; ai-memory retains old versions. It does not reset or replay the normal sync cursor. */
export async function repairAiMemoryBlocks(directory: string, profile: string, blocks: number[], apply = false, writePage: PageWriter = aiMemoryWriter()) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profile) || !blocks.length || blocks.length > 16 || new Set(blocks).size !== blocks.length || blocks.some(block => !Number.isSafeInteger(block) || block < 0)) throw new Error('Use a valid profile and 1–16 distinct nonnegative block indexes.');
  const snapshot = repairSnapshot(directory);
  const pages = blocks.map(block => {
    const page = blockPage(profile, snapshot, block);
    if (!page) throw new Error(`Block ${block} has no finished summary; nothing repaired.`);
    return page;
  });
  if (apply) for (const page of pages) await writePage(page);
  return { apply, format: AI_MEMORY_FORMAT, paths: pages.map(page => page.path), cursorChanged: false, note: 'Only the named blocks are repaired; other legacy pages remain lossy and must be checked against originals.' };
}
