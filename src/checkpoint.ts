import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from './store.ts';
const exec = promisify(execFile);
// external: Git auto gc counts loose objects rather than bytes.
const LOOSE_LIMIT_KIB = 16_384;

export async function checkpoint(directory: string) {
  const git = (args: string[]) => exec('git', ['-C', directory, ...args], { maxBuffer: 1_000_000 });
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
  const status = await git(['diff', '--cached', '--name-only']);
  if (!status.stdout.trim()) return;
  await git(['-c', 'user.name=OptChat', '-c', 'user.email=optchat@localhost', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Save OptChat memory']);
  const loose = Number(/^size: (\d+)$/m.exec((await git(['count-objects', '-v'])).stdout)?.[1]);
  // external: Git defaults to cruft packs from version 2.40.

  if (loose > LOOSE_LIMIT_KIB) await git(['-c', 'gc.cruftPacks=true', 'gc', '--quiet']).catch(() => {});
}
