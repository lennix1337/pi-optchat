import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutSlug } from '../src/checkout-slug.ts';
import { withTempDir } from './support.ts';

const withDirectory = (run: (directory: string) => void) => withTempDir('optchat-checkout-slug-', run);
const config = (origin: string) => `[core]\n\trepositoryformatversion = 0\n[remote "fork"]\n\turl = https://github.com/lennix1337/dentai.git\n[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;

test("a checkout's origin decides its GitHub slug, read from that checkout's own .git/config", () => withDirectory(directory => {
  const checkout = join(directory, 'dentai-mono');
  mkdirSync(join(checkout, '.git'), { recursive: true });
  writeFileSync(join(checkout, '.git', 'config'), config('https://github.com/tecnologia-ai/dentai.git'));
  assert.equal(checkoutSlug(checkout), 'tecnologia-ai/dentai', 'the origin, not the fork');
  assert.equal(checkoutSlug(join(directory, 'missing')), undefined, 'a folder that does not exist');
  assert.equal(checkoutSlug(directory), undefined, 'a folder that is not a checkout (no walking up)');
}));

test('a linked worktree reads the origin of the repository it was made from', () => withDirectory(directory => {
  const main = join(directory, 'dentai-mono'), worktree = join(main, 'worktrees', 'denta-102');
  const gitDir = join(main, '.git', 'worktrees', 'denta-102');
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(main, '.git', 'config'), config('git@github.com:tecnologia-ai/dentai.git'));
  writeFileSync(join(gitDir, 'commondir'), '../..\n');
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  assert.equal(checkoutSlug(worktree), 'tecnologia-ai/dentai');
}));

test('a non-GitHub origin has no slug, and a changed origin is read again', () => withDirectory(directory => {
  const checkout = join(directory, 'gitlab');
  mkdirSync(join(checkout, '.git'), { recursive: true });
  const file = join(checkout, '.git', 'config');
  writeFileSync(file, config('https://gitlab.com/team/app.git'));
  assert.equal(checkoutSlug(checkout), undefined);
  writeFileSync(file, config('https://github.com/tecnologia-ai/dentai.git'));
  const later = new Date(Date.now() + 5_000);
  utimesSync(file, later, later);
  assert.equal(checkoutSlug(checkout), 'tecnologia-ai/dentai');
}));
