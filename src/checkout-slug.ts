import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { slugOf } from './autonomy.ts';
import { parseWhenChanged } from './mtime-cache.ts';

/** GitHub `owner/repo` of a folder's `origin`, read from its local git config: no git process, no network. */
export type FolderSlug = (folder: string) => string | undefined;

/** The config that names a checkout's remotes: its own `.git/config`, or the main repository's for a linked worktree. */
function configFile(folder: string): string | undefined {
  const dotGit = join(folder, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return join(dotGit, 'config');
    // A linked worktree's `.git` is a file: `gitdir: <main>/.git/worktrees/<name>`, whose `commondir` leads back to the config.
    const pointer = /^gitdir:[ \t]*(.+?)\s*$/m.exec(readFileSync(dotGit, 'utf8'))?.[1];
    if (!pointer) return undefined;
    const gitDir = resolve(folder, pointer);
    const common = join(gitDir, 'commondir');
    return join(existsSync(common) ? resolve(gitDir, readFileSync(common, 'utf8').trim()) : gitDir, 'config');
  } catch {
    return undefined;
  }
}

/** The `url` under `[remote "origin"]` in git config text, or undefined. */
export function originUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const line of config.split(/\r?\n/).map(text => text.trim())) {
    const section = /^\[\s*remote\s+"([^"]*)"\s*\]$/i.exec(line);
    if (section) { inOrigin = section[1] === 'origin'; continue; }
    if (line.startsWith('[')) { inOrigin = false; continue; }
    const url = /^url\s*=\s*(.+)$/i.exec(line);
    if (inOrigin && url) return url[1].trim();
  }
  return undefined;
}

/** Each config's slug, re-read only when its file changes. */
const cache = new Map<string, { mtime: number; value: string | undefined }>();

/** The GitHub slug of the folder's origin, or undefined when it has none or is not a checkout. */
export const checkoutSlug: FolderSlug = folder => {
  const file = configFile(folder);
  if (!file) return undefined;
  try {
    return parseWhenChanged(cache, file, text => slugOf(originUrl(text) ?? ''));
  } catch {
    return undefined;
  }
};
