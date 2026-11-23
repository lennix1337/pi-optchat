import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultMonitors } from '../src/prod-health.ts';
import { headTime, loadedCodeProbe, localPackages } from '../src/loaded-code-health.ts';

const LOADED = Date.parse('2026-11-20T22:00:00Z');
const sec = (iso: string) => Date.parse(iso) / 1000;

test('a package committed after the session loaded its code is a problem naming it and both times', () => {
  const times: Record<string, number> = { '/p/pi-optchat': sec('2026-11-20T23:51:00Z'), '/p/pi-gitwatch': sec('2026-11-20T21:00:00Z') };
  const result = loadedCodeProbe(() => ['/p/pi-optchat', '/p/pi-gitwatch', '/p/not-git'], LOADED, repo => times[repo]).check() as { ok: boolean; problem?: string };
  assert.equal(result.ok, false);
  assert.match(result.problem!, /pi-optchat \(commit 20\/11 20:51\)/);
  assert.match(result.problem!, /carregou às 20\/11 19:00/);
  assert.doesNotMatch(result.problem!, /pi-gitwatch|not-git/);
});

test('code loaded after the newest commit, or no repositories, is fine', () => {
  assert.equal((loadedCodeProbe(() => ['/p/a'], LOADED, () => sec('2026-11-20T22:00:00Z')).check() as { ok: boolean }).ok, true);
  assert.equal((loadedCodeProbe(() => [], LOADED, () => undefined).check() as { ok: boolean }).ok, true);
});

test('localPackages keeps path packages only and headTime reads a real repository', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lcode-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ packages: ['/home/x/pi-optchat', 'npm:pi-web-access@1', 'C:/projetos/pi-lsp', 5] }));
  assert.deepEqual(localPackages(file), ['/home/x/pi-optchat', 'C:/projetos/pi-lsp']);
  assert.deepEqual(localPackages(join(dir, 'missing.json')), []);
  assert.equal(headTime(dir), undefined);
  assert.ok((headTime(process.cwd()) ?? 0) > 1_700_000_000);
});

test('the monitor wakes the agent to reload and posts nothing to Slack', () => {
  const monitor = defaultMonitors().find(m => /loaded-code/.test(String(m.health.file ?? '')));
  assert.ok(monitor, 'registered');
  assert.equal(monitor.wakes, true);
  assert.equal(monitor.slack, false);
  assert.match(monitor.wakeNote!, /self_reload/);
});

test('headTime ignores commits that only touch documentation: a reload would load nothing new', t => {
  const dir = mkdtempSync(join(tmpdir(), 'lcode-git-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (date: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: 'ignore' });
  git('2026-11-20T10:00:00Z', 'init', '-q');
  writeFileSync(join(dir, 'index.ts'), 'export {};\n'); git('2026-11-20T10:00:00Z', 'add', '.'); git('2026-11-20T10:00:00Z', 'commit', '-qm', 'code');
  writeFileSync(join(dir, 'README.md'), 'doc\n'); git('2026-11-22T10:00:00Z', 'add', '.'); git('2026-11-22T10:00:00Z', 'commit', '-qm', 'docs');
  assert.equal(headTime(dir), sec('2026-11-20T10:00:00Z'));
});

test('a green probe names when the session loaded its code, which is what proves a reload', () => {
  const result = loadedCodeProbe(() => ['/p/a'], Date.parse('2026-11-22T22:00:00-03:00'), () => sec('2026-11-20T22:00:00Z')).check() as { ok: boolean; detail?: string };
  assert.match(result.detail ?? '', /Pi carregou às 22\/11 22:00; o HEAD de todos os pacotes locais é anterior/);
});

test('a checkout parked on a feature branch says so, so the alert is not read as an unreloaded merge', () => {
  const run = (branch: string | undefined) => loadedCodeProbe(() => ['/p/pi-optchat'], LOADED, () => sec('2026-11-20T23:51:00Z'), () => branch).check() as { problem?: string };
  assert.match(run('fix/x').problem!, /checkout no branch fix\/x: volte a main/);
  assert.doesNotMatch(run('main').problem!, /checkout no branch/);
  assert.doesNotMatch(run(undefined).problem!, /checkout no branch/);
});
