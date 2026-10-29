import { join } from 'node:path';
import { MemoryView, type MemorySource, type Original } from '../src/memory/projection.ts';
import { withDir } from './runtime-support.ts';

/** A chat-like source: originals live here (the stand-in for the OptChat store); the view only references them. */
export function chatSource(profileId: string, entries: Original[], sourceId = 'chat'): MemorySource & { entries: Map<string, Original> } {
  const map = new Map(entries.map(e => [e.ref, e]));
  return { sourceId, profileId, entries: map, get: ref => map.get(ref) };
}

export const hypothesis: Original = { ref: '74527', text: 'The operator prefers completed tasks pinned in the dashboard', observedAt: '2026-10-29T13:02:00.000Z', author: 'assistant', kind: 'hypothesis' };
export const userFact: Original = { ref: '74514', text: 'Projects live in C:/projetos', observedAt: '2026-10-29T12:40:00.000Z', author: 'user', kind: 'fact' };
export const summary: Original = { ref: '74000+512', text: 'Holding dashboard verified locally', observedAt: '2026-10-28T20:00:00.000Z', author: 'compactor', kind: 'summary' };

export type MemoryRig = { dir: string; authority: object; open: (profileId: string, sources: MemorySource[]) => MemoryView };

export function withMemory(fn: (rig: MemoryRig) => void | Promise<void>): Promise<void> {
  return withDir('memory-', async dir => {
    const authority = {};
    const views: MemoryView[] = [];
    const open = (profileId: string, sources: MemorySource[]) => {
      const view = new MemoryView({ databasePath: join(dir, 'assistant.db'), profileId, operatorAuthority: authority, sources, now: () => Date.parse('2026-10-29T14:00:00.000Z') });
      views.push(view);
      return view;
    };
    try { await fn({ dir, authority, open }); } finally { for (const v of views) v.close(); }
  });
}
