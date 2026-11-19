import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { existsSync, lstatSync } from 'node:fs';
import { commandWords, segments } from './effect-classifier.ts';

const exec = promisify(execFile);
const unquote = (word: string) => word.replace(/^(['"])([^]*)\1$/, '$2');

function gitCommand(command: string, cwd: string) {
  const words = commandWords(command).map(unquote);
  if (words.shift()?.toLowerCase() !== 'git') return;
  while (words[0] === '-C' && words[1]) cwd = resolve(cwd, words.splice(0, 2)[1]);
  return { words, cwd };
}

async function git(cwd: string, ...args: string[]): Promise<string | undefined> {
  try { return (await exec('git', args, { cwd, timeout: 2000, encoding: 'utf8', windowsHide: true })).stdout.trim(); }
  catch { return undefined; }
}

/** Refuse literal destructive Git commands when local tracked work or commits would be lost. */
export async function discardRefusal(text: string, cwd: string): Promise<string | undefined> {
  const parts = segments(text, cwd, true);
  for (let i = 0; i < parts.length; i++) {
    const parsed = gitCommand(parts[i].command, parts[i].dir);
    if (!parsed) continue;
    const { words, cwd: repo } = parsed;
    const [sub, ...args] = words;
    const reset = sub === 'reset' && args.includes('--hard');
    const checkout = sub === 'checkout' && (args.includes('--') || args.includes('.'));
    const restore = sub === 'restore' && (!args.some(a => a === '--staged' || /^-[^-]*S/.test(a)) || args.some(a => a === '--worktree' || /^-[^-]*W/.test(a)));
    const clean = sub === 'clean' && args.some(a => a === '--force' || /^-[^-]*f/.test(a)) && !args.some(a => a === '--dry-run' || /^-[^-]*n/.test(a));
    const stash = sub === 'stash' && (args[0] === 'drop' || args[0] === 'clear');
    const forced = args.some(a => a === '--force' || /^-[^-]*f/.test(a));
    const deleting = args.some(a => a === '--delete' || /^-[^-]*[dD]/.test(a));
    const branchDelete = sub === 'branch' && deleting && (forced || args.some(a => /^-[^-]*D/.test(a)));
    if (branchDelete) {
      const names = args.filter(a => !a.startsWith('-'));
      for (const name of names) {
        const lost = await git(repo, 'for-each-ref', '--count=1', '--contains', `refs/heads/${name}`, '--format=%(refname)', 'refs/remotes/origin') === '';
        if (lost && await git(repo, 'rev-parse', '--verify', '-q', `refs/heads/${name}`)) return `Não executado: os commits da branch ${name} não publicados em nenhuma origin podem ser perdidos. Publique a branch ou use git branch -d depois de mesclar.`;
      }
      continue;
    }
    if (!reset && !checkout && !restore && !clean && !stash) continue;
    if (await git(repo, 'rev-parse', '--git-dir') === undefined) continue;
    const status = await git(repo, 'status', '--porcelain', '--untracked-files=no');
    if (status === undefined) return 'Não executado: não foi possível verificar alterações locais. Faça commit ou stash antes.';
    // Only an immediately preceding, successful full stash or patch can preserve tracked changes.
    const previous = i > 0 ? gitCommand(parts[i - 1].command, parts[i - 1].dir) : undefined;
    const prefix = i > 0 ? text.indexOf(parts[i - 1].command) : -1;
    const between = prefix < 0 ? '' : text.slice(prefix + parts[i - 1].command.length, text.indexOf(parts[i].command, prefix + parts[i - 1].command.length));
    const patchPath = /^git\s+diff\s+HEAD\s*>\s*([\w./-]+)\s*$/.exec(parts[i - 1]?.command ?? '')?.[1];
    const patchFile = patchPath && resolve(repo, patchPath);
    // Never overwrite an existing file (including a dangling symlink) with the patch.
    const exists = patchFile && (existsSync(patchFile) || (() => { try { lstatSync(patchFile); return true; } catch { return false; } })());
    const patch = patchPath && !exists && !clean && !stash && await git(repo, 'ls-files', '--', patchPath) === '';
    const saved = previous?.cwd === repo && /^\s*&&\s*$/.test(between) && (previous.words.join(' ') === 'stash' || previous.words.join(' ') === 'stash push' || patch);
    if (status && (!saved || stash)) {
      const loss = stash ? 'alterações guardadas no stash' : clean ? 'arquivos não rastreados' : 'alterações locais rastreadas';
      return `Não executado: ${loss} podem se perder. Há alterações locais; faça commit ou stash antes e preserve os arquivos ou stashes necessários.`;
    }
    if (reset) {
      const target = args.find(a => a !== '--hard' && !a.startsWith('-')) ?? 'HEAD';
      const contained = await git(repo, 'merge-base', '--is-ancestor', 'HEAD', target) !== undefined;
      const remote = await git(repo, 'for-each-ref', '--count=1', '--contains', 'HEAD', '--format=%(refname)', 'refs/remotes/origin');
      if (!contained && !remote) return 'Não executado: commits locais não publicados podem ser perdidos. Faça commit ou stash das alterações e publique ou preserve os commits antes.';
    }
  }
  return undefined;
}
