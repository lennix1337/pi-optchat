import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boundedText as bounded } from '../contracts/validation.ts';
import { sha256 } from '../hash.ts';

/**
 * A read/correct view over memory that lives elsewhere. The chat (zoom) and ABOUT-ME stay the authority:
 * this module never copies their text into its own store; it keeps only operator corrections bound to the
 * exact original they correct, so the original is always shown next to the correction and a changed
 * original makes the correction stale instead of silently reapplying it.
 */
export type MemoryKind = 'fact' | 'summary' | 'hypothesis';
export type Original = { ref: string; text: string; observedAt: string; author: string; kind: MemoryKind };
export type MemorySource = { sourceId: string; profileId: string; get(ref: string): Original | undefined };
export type Correction = { id: string; text: string; kind: MemoryKind; reason: string; author: 'operator'; correctedAt: string };
export type MemoryEntry = {
  profileId: string; sourceId: string; ref: string; original: Original; originalHash: string;
  current: { text: string; kind: MemoryKind; from: 'original' | 'correction' };
  corrections: Correction[]; stale: Correction[]; correctionCount: number; staleCount: number; nextCorrectionOffset?: number;
};
export type MemoryOptions = { databasePath: string; profileId: string; operatorAuthority: object; sources: MemorySource[]; now?: () => number };

const KINDS: readonly string[] = ['fact', 'summary', 'hypothesis'];
const MAX_TEXT = 8192;
const fail = (code: string): never => { throw new Error(code); };
const boundedText = bounded(MAX_TEXT);

function validOriginal(o: Original | undefined, ref: string): Original | undefined {
  if (o === undefined) return undefined;
  const ok = o.ref === ref && typeof o.text === 'string' && o.text.isWellFormed() && o.text.trim().length > 0 && boundedText(o.author) && KINDS.includes(o.kind) && Number.isFinite(Date.parse(o.observedAt));
  return ok ? Object.freeze({ ref: o.ref, text: o.text, observedAt: o.observedAt, author: o.author, kind: o.kind }) : fail('memory_source_invalid');
}

export class MemoryView {
  private readonly db: DatabaseSync;
  private readonly profileId: string;
  private readonly authority: object;
  private readonly sources: Map<string, MemorySource>;
  private readonly now: () => number;
  constructor(options: MemoryOptions) {
    if (!options.operatorAuthority || typeof options.operatorAuthority !== 'object' || !boundedText(options.profileId) || !Array.isArray(options.sources)) fail('invalid_options');
    this.profileId = options.profileId;
    this.authority = options.operatorAuthority;
    this.now = options.now ?? Date.now;
    this.sources = new Map();
    for (const source of options.sources) {
      if (source.profileId !== options.profileId) fail('memory_profile_mismatch');
      if (!boundedText(source.sourceId) || this.sources.has(source.sourceId)) fail('invalid_options');
      this.sources.set(source.sourceId, source);
    }
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS memory_corrections (id TEXT PRIMARY KEY, profile TEXT NOT NULL, source TEXT NOT NULL, ref TEXT NOT NULL,
        original_hash TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, corrected_at TEXT NOT NULL);`);
  }

  /** Corrections are returned in bounded chronological pages; current always reflects the latest applicable correction. */
  read(sourceId: string, ref: string, offset = 0, limit = 32): MemoryEntry {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) fail('invalid_page');
    const source = this.sources.get(sourceId) ?? fail('memory_not_found');
    const original = validOriginal(source.get(ref), ref) ?? fail('memory_not_found');
    // Binds corrections to what was said, by whom and as what; not to when, so touching an unrelated line of a file does not stale them.
    const originalHash = sha256(JSON.stringify([original.ref, original.text, original.author, original.kind]));
    const key = [this.profileId, sourceId, ref] as const;
    const counts = this.db.prepare('SELECT COUNT(*) AS total, COUNT(CASE WHEN original_hash = ? THEN 1 END) AS matching FROM memory_corrections WHERE profile = ? AND source = ? AND ref = ?').get(originalHash, ...key) as { total: number; matching: number };
    const rows = this.db.prepare('SELECT * FROM memory_corrections WHERE profile = ? AND source = ? AND ref = ? ORDER BY rowid LIMIT ? OFFSET ?').all(...key, limit, offset) as Record<string, string>[];
    const toCorrection = (r: Record<string, string>): Correction => ({ id: r.id, text: r.text, kind: r.kind as MemoryKind, reason: r.reason, author: 'operator', correctedAt: r.corrected_at });
    const corrections = rows.filter(r => r.original_hash === originalHash).map(toCorrection);
    const stale = rows.filter(r => r.original_hash !== originalHash).map(toCorrection);
    const last = this.db.prepare('SELECT * FROM memory_corrections WHERE profile = ? AND source = ? AND ref = ? AND original_hash = ? ORDER BY rowid DESC LIMIT 1').get(...key, originalHash) as Record<string, string> | undefined;
    const current = last ? { text: last.text, kind: last.kind as MemoryKind, from: 'correction' as const } : { text: original.text, kind: original.kind, from: 'original' as const };
    return { profileId: this.profileId, sourceId, ref, original, originalHash, current, corrections, stale, correctionCount: counts.matching, staleCount: counts.total - counts.matching, ...(offset + rows.length < counts.total ? { nextCorrectionOffset: offset + rows.length } : {}) };
  }

  /**
   * Only the operator corrects, and only the original they saw: `originalHash` must match what the source holds now.
   * The original is never touched; the correction is appended and shown alongside it.
   */
  correct(input: { sourceId: string; ref: string; originalHash: string; text: string; kind: MemoryKind; reason: string }, authority: object): Correction {
    if (authority !== this.authority) fail('unauthorized');
    if (!boundedText(input.text) || !boundedText(input.reason) || !KINDS.includes(input.kind)) fail('invalid_correction');
    const entry = this.read(input.sourceId, input.ref);
    if (input.originalHash !== entry.originalHash) fail('memory_original_changed');
    const correction: Correction = { id: randomUUID(), text: input.text, kind: input.kind, reason: input.reason, author: 'operator', correctedAt: new Date(this.now()).toISOString() };
    this.db.prepare('INSERT INTO memory_corrections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(correction.id, this.profileId, input.sourceId, input.ref, entry.originalHash, correction.text, correction.kind, correction.reason, correction.correctedAt);
    return correction;
  }

  close(): void { this.db.close(); }
}

/**
 * ABOUT-ME as a source: each `- ` bullet is a durable fact written by the operator, addressed by line
 * (`ABOUT-ME.md#L12`). The file is read on every lookup, so it stays the single place those facts live.
 * `observedAt` is the file's modification time: the file keeps no per-line date. A line moved by an edit
 * reads as different text at that ref, so its corrections turn stale rather than attach to another fact.
 */
export function markdownFactSource(options: { path: string; sourceId: string; profileId: string; author: string }): MemorySource {
  const name = basename(options.path);
  return {
    sourceId: options.sourceId, profileId: options.profileId,
    get(ref) {
      const match = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}#L([1-9]\\d*)$`).exec(ref);
      if (!match) return undefined;
      let content: string; let observedAt: string;
      try { content = readFileSync(options.path, 'utf8'); observedAt = statSync(options.path).mtime.toISOString(); } catch { return undefined; }
      const line = content.split(/\r?\n/)[Number(match[1]) - 1];
      if (line === undefined || !line.startsWith('- ')) return undefined;
      return { ref, text: line.slice(2).trim(), observedAt, author: options.author, kind: 'fact' };
    },
  };
}
