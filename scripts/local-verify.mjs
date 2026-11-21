#!/usr/bin/env node



import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';


const localVerifyDir = () => process.env.PI_LOCAL_VERIFY_DIR ?? join(homedir(), '.pi', 'agent', 'local-verify');

function verifyRecipe(pkg, pnpm) {
  const scripts = pkg?.scripts ?? {};
  const name = ['verify', 'verify:fast', 'test'].find(script => typeof scripts[script] === 'string');
  return name ? [pnpm ? 'pnpm' : 'npm', 'run', name] : undefined;
}

const dir = resolve(process.argv[2] ?? '.');
const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
const sha = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--untracked-files=no');
if (dirty) { console.error(`local_verify_rc=3 ${dir} has uncommitted changes; the receipt must describe ${sha.slice(0, 8)} exactly.`); process.exit(3); }
const pkgPath = join(dir, 'package.json');
const recipe = verifyRecipe(existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath, 'utf8')) : undefined, existsSync(join(dir, 'pnpm-lock.yaml')));
if (!recipe) { console.error('local_verify_rc=2 no verify, verify:fast or test script in package.json: add one before merging without CI.'); process.exit(2); }
console.log(`running ${recipe.join(' ')} on ${sha.slice(0, 8)} in ${dir}`);
const run = spawnSync(recipe[0], recipe.slice(1), { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
const rc = run.status ?? 1;
if (rc === 0 && git('rev-parse', 'HEAD') === sha && !git('status', '--porcelain', '--untracked-files=no')) {
  mkdirSync(localVerifyDir(), { recursive: true });
  writeFileSync(join(localVerifyDir(), `${sha}.json`), JSON.stringify({ sha, dir, command: recipe.join(' '), at: new Date().toISOString() }) + '\n');
}
console.log(`local_verify_rc=${rc} sha=${sha}`);
process.exit(rc);
