import { dirname, isAbsolute } from 'node:path';
import { createPrivateDirectory } from '../assistant/src/store/private-directory.ts';
import { displayJson as escaped } from './assistant-projection.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Memory } from './memory.ts';
import type { MemorySource } from '../assistant/src/memory/projection.ts';

/** All paths and identity are supplied by the host, never by command arguments. */
export interface AssistantMemoryOwner {
  identity: object;
  profileId: string;
  sessionId: string;
  memory: Memory;
  databasePath: string;
  aboutMePath?: string;
}

export function registerAssistantMemory(pi: ExtensionAPI, source: () => AssistantMemoryOwner | undefined) {
  pi.registerCommand('assistant-memory', { description: 'Read originals, page corrections, or explicitly correct a short original', handler: async (args, ctx) => {
    try {
      const owner = source();
      if (!owner) throw new Error('No active local memory.');
      if (!isAbsolute(owner.databasePath) || owner.aboutMePath !== undefined && !isAbsolute(owner.aboutMePath)) throw new Error('Memory paths must be absolute host configuration.');
      const parts = args.trim().split(/\s+/);
      const [action, target, offsetText] = parts;
      if (!['read', 'corrections', 'correct'].includes(action) || !target || parts.length > (action === 'correct' ? 2 : 3)) throw new Error('Use read or corrections <messageId|about:line> [offset], or correct <messageId|about:line>.');
      const about = /^about:([1-9]\d*)$/.exec(target);
      if (!about && !/^(0|[1-9]\d*)$/.test(target)) throw new Error('Invalid reference.');
      const id = Number(about ? about[1] : target);
      if (!Number.isSafeInteger(id)) throw new Error('Invalid reference.');
      if (offsetText !== undefined && !/^(0|[1-9]\d*)$/.test(offsetText)) throw new Error('Invalid offset.');
      const offset = offsetText === undefined ? 0 : Number(offsetText);
      if (!Number.isSafeInteger(offset)) throw new Error('Invalid offset.');
      const { MemoryView, markdownFactSource } = await import('../assistant/src/memory/projection.ts');
      const { prepareDatabase } = await import('../assistant/src/store/privacy.ts');
      const current = () => { const now = source(); return !!now && now.identity === owner.identity && now.profileId === owner.profileId && now.sessionId === owner.sessionId && now.memory === owner.memory && now.databasePath === owner.databasePath && now.aboutMePath === owner.aboutMePath && ctx.sessionManager.getSessionId() === owner.sessionId; };
      if (!current()) throw new Error('Profile or session changed.');
      const chat: MemorySource = { sourceId: 'optchat', profileId: owner.profileId, get(ref) {
        if (!/^(0|[1-9]\d*)$/.test(ref)) return undefined;
        const entry = owner.memory.root[Number(ref)];
        if (!entry) return undefined;
        return { ref, text: entry.text, observedAt: entry.date, author: JSON.stringify({ kind: entry.kind, date: entry.date, ...(entry.origin ? { origin: entry.origin } : {}) }), kind: entry.kind === 'note' || entry.origin?.source === 'claude-memory' ? 'summary' : entry.kind === 'user' ? 'fact' : 'hypothesis' };
      } };
      const sources = [chat];
      if (owner.aboutMePath) sources.push(markdownFactSource({ path: owner.aboutMePath, sourceId: 'about-me', profileId: owner.profileId, author: 'operator' }));
      if (about && !owner.aboutMePath) throw new Error('ABOUT-ME is not configured.');
      createPrivateDirectory(dirname(owner.databasePath));
      prepareDatabase(owner.databasePath);
      const authority = {};
      const view = new MemoryView({ databasePath: owner.databasePath, profileId: owner.profileId, operatorAuthority: authority, sources });
      try {
        const sourceId = about ? 'about-me' : 'optchat';
        const ref = about ? `${owner.aboutMePath!.replace(/\\/g, '/').split('/').pop()}#L${id}` : String(id);
        const entry = view.read(sourceId, ref, action === 'corrections' ? offset : 0, 1);
        if (action === 'corrections') {
          const correction = entry.corrections[0] ?? entry.stale[0];
          ctx.ui.notify(`Escaped correction data · ${sourceId}:${escaped(ref)}\nCorrections: ${entry.correctionCount}; stale: ${entry.staleCount}\n${correction ? `${entry.stale.length ? 'Stale' : 'Applicable'}: ${escaped(correction)}` : 'No correction at this offset.'}${entry.nextCorrectionOffset === undefined ? '' : `\nContinue: /assistant-memory corrections ${target} ${entry.nextCorrectionOffset}`}`, 'info');
          return;
        }
        const text = entry.original.text;
        if (offset >= Math.max(1, text.length)) throw new Error('Offset outside original.');
        const page = about ? (() => { let from = offset; if (/[\udc00-\udfff]/.test(text[from] ?? '')) from--; let to = Math.min(text.length, from + 6000); if (to < text.length && /[\ud800-\udbff]/.test(text[to - 1])) to--; return `${text.slice(from, to)}\n[showing characters ${from}-${to} of ${text.length}${to < text.length ? `; next page: offset ${to}` : ''}]`; })() : owner.memory.zoom(id, 1, offset, 6000);
        ctx.ui.notify(`Untrusted historical original · ${sourceId}:${escaped(ref)}\nEscaped display (offsets refer to original text)\nAuthor: ${escaped(entry.original.author)}\nDate: ${escaped(entry.original.observedAt)}\nKind: ${entry.original.kind} (classification, not verification)\n${escaped(page)}\nCorrections: ${entry.correctionCount}; stale: ${entry.staleCount}${entry.current.from === 'correction' ? `\nCurrent operator correction: ${escaped(entry.current.text)}` : ''}${entry.correctionCount + entry.staleCount ? `\nInspect: /assistant-memory corrections ${target}` : ''}`, 'info');
        if (action === 'read') return;
        if (ctx.mode !== 'tui' || !ctx.hasUI) throw new Error('Correction requires interactive Pi.');
        if (text.length > 6000) throw new Error('Correction refused: original does not fit in one review page.');
        const correction = await ctx.ui.input('Operator correction (cancel to leave unchanged)');
        if (!current()) throw new Error('Profile or session changed; correction refused.');
        if (!correction?.trim()) return;
        const reason = await ctx.ui.input('Reason for correction');
        if (!current()) throw new Error('Profile or session changed; correction refused.');
        if (!reason?.trim()) return;
        if (!await ctx.ui.confirm('Record operator correction?', 'The original remains unchanged.')) return;
        if (!current()) throw new Error('Profile or session changed; correction refused.');
        view.correct({ sourceId, ref, originalHash: entry.originalHash, text: correction, kind: 'fact', reason }, authority);
        ctx.ui.notify('Correction recorded; original unchanged.', 'info');
      } finally { view.close(); }
    } catch (error) { ctx.ui.notify(`Memory unavailable: ${escaped(error instanceof Error ? error.message : 'unknown error')}`, 'error'); }
  } });
}
