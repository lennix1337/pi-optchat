/**
 * Where the open profile is in its life. index.ts keeps six independent facts (a profile is open, a connected window or a
 * joined headless run owns the chat instead, the profile is closing, an import dialog is open, an import is paused on
 * disk); every feature used to decide from its own conjunction of them, and two of the conjunctions disagreed about a
 * paused import. One derivation, ordered so that the first fact that holds names the phase.
 */
export type ProfilePhase = 'none' | 'remote' | 'importing' | 'closing' | 'import-paused' | 'open';

export interface ProfileFacts {
  active: boolean;
  /** A connected window or a joined headless run owns the chat; no local profile is opened for it. */
  remote: boolean;
  stopping: boolean;
  /** The import dialog is open. */
  importing: boolean;
  /** An import journal is on disk. Read only when no earlier fact decided. */
  importPending: () => boolean;
}

export function profilePhase({ active, remote, stopping, importing, importPending }: ProfileFacts): ProfilePhase {
  if (!active) return 'none';
  if (remote) return 'remote';
  if (importing) return 'importing';
  if (stopping) return 'closing';
  return importPending() ? 'import-paused' : 'open';
}
