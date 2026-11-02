import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The assistant package root. `npm test` runs from here while checks.json and CI run from the repository root,
 * so tests address their own files through this constant instead of the working directory.
 */
export const ASSISTANT_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Absolute path of a file in the assistant package, e.g. `assistantPath('scripts/artifact.mjs')`. */
export function assistantPath(relative: string): string {
  return join(ASSISTANT_ROOT, relative);
}
