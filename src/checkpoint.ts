import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './store.ts';
const exec = promisify(execFile);
// external: Git auto gc counts loose objects rather than bytes.
const LOOSE_LIMIT_KIB = 16_384;
const LOOSE_LIMIT_BYTES = LOOSE_LIMIT_KIB * 1024;

const packing = new Map<string, Promise<void>>();

export const packingRun = (directory: string) => packing.get(directory);

function looseObjectsExceed(directory: string, limitBytes: number): boolean {
  const objects = join(directory, '.git', 'objects');
  let subs: string[];
  try { subs = readdirSync(objects); } catch { return false; }
  let total = 0;
  for (const sub of subs) {
    if (!/^[0-9a-f]{2}$/.test(sub)) continue;
    let files: string[];
    try { files = readdirSync(join(objects, sub)); } catch { continue; }
    for (const file of files) {
      try { total += statSync(join(objects, sub, file)).size; } catch { continue; }
      if (total > limitBytes) return true;
    }
  }
  return false;
}

function pack(directory: string, git: (args: string[]) => Promise<unknown>) {
  let run = packing.get(directory);
  if (!run) {
    run = git(['-c', 'gc.cruftPacks=true', 'gc', '--quiet']).then(() => {}, () => {}).finally(() => packing.delete(directory));
    packing.set(directory, run);
  }
  return run;
}

export async function checkpoint(directory: string, options: { background?: boolean } = {}) {
  const git = (args: string[]) => exec('git', ['-C', directory, ...args], { maxBuffer: 1_000_000, env: { ...process.env, LC_ALL: 'C' } });
  if (!existsSync(join(directory, '.git'))) await git(['init', '-q', '-b', 'main']);
  if (!existsSync(join(directory, '.gitignore'))) atomicWrite(join(directory, '.gitignore'), '/runs/\n/memory.html\n/usage.jsonl\n/usage.db*\nload-index/\n*.tmp\n');



  const exclude = join(directory, '.git', 'info', 'exclude'), excluded = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
  const missing = ['/usage.db*', 'load-index/'].filter(pattern => !excluded.split('\n').includes(pattern));
  if (missing.length) {
    mkdirSync(join(directory, '.git', 'info'), { recursive: true });
    appendFileSync(exclude, `${excluded && !excluded.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  }
  await git(['add', '-A', '--', '.', ':!compactor-diagnostics.jsonl', ':!compactor-diagnostics.jsonl.1', ':!recovery-diagnostics.jsonl', ':!recovery-diagnostics.jsonl.1',
    ':!cache-diagnostics.jsonl', ':!cache-diagnostics.jsonl.1', ':!cache-entries.json']);
  try {
    await git(['-c', 'user.name=OptChat', '-c', 'user.email=optchat@localhost', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Save OptChat memory']);
  } catch (error) {
    const out = `${(error as { stdout?: string }).stdout ?? ''}\n${(error as { stderr?: string }).stderr ?? ''}`;
    if (/nothing to commit|nothing added to commit/i.test(out)) return;
    if (!(await git(['diff', '--cached', '--name-only'])).stdout.trim()) return;
    throw error;
  }
  // external: Git defaults to cruft packs from version 2.40.

  const packed = looseObjectsExceed(directory, LOOSE_LIMIT_BYTES) ? pack(directory, git) : packing.get(directory);
  if (!options.background) await packed;
}
