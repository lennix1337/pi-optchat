import { existsSync, readFileSync, statSync } from 'node:fs';

/**
 * `parse` of a file's text, re-read only when the file's modification time changes. A missing file is undefined; a file
 * that fails to parse throws, so callers decide what that means (a contract fails closed, a remote is simply unknown).
 */
export function parseWhenChanged<T>(cache: Map<string, { mtime: number; value: T }>, file: string, parse: (text: string) => T): T | undefined {
  if (!existsSync(file)) return undefined;
  const mtime = statSync(file).mtimeMs, hit = cache.get(file);
  if (hit?.mtime === mtime) return hit.value;
  const value = parse(readFileSync(file, 'utf8'));
  cache.set(file, { mtime, value });
  return value;
}
