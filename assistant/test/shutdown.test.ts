import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { processInfo } from '../src/ops/service.ts';
import { privateDir } from './vault-support.ts';
import { PROFILE, alive, api, createTaskBody, freePort, killRecordedService, runScript, serviceHome, writeConfig } from './ops-support.ts';

const assistant = fileURLToPath(new URL('../', import.meta.url));

test('stop drains the service: admission closes, the database closes, no forced kill', { timeout: 60_000 }, () => privateDir('ops-drain-', async root => {
  const svc = serviceHome(root, await freePort());
  try {
    assert.equal(runScript('start', ['--config', svc.config]).json.result, 'started');
    assert.equal((await api(svc.endpoint, '/v1/tasks', createTaskBody('task-1', 'drain me'))).status, 200);
    const stopped = runScript('stop', ['--config', svc.config]);
    assert.deepEqual([stopped.json.result, stopped.json.mode], ['stopped', 'graceful']);
    assert.match(readFileSync(join(svc.home, 'assistant-service.log'), 'utf8'), /Assistant stopped: admission closed, requests drained, database closed\./);
    await assert.rejects(api(svc.endpoint, '/v1/tasks'));
    assert.equal(runScript('start', ['--config', svc.config]).json.result, 'started');
    const task = await (await api(svc.endpoint, '/v1/tasks/task-1')).json() as { title: string };
    assert.equal(task.title, 'drain me', 'state survives the restart');
    assert.equal(runScript('stop', ['--config', svc.config]).json.result, 'stopped');
  } finally { killRecordedService(svc.home); }
}));

test('stop and health never kill or trust a process this tool did not start', { timeout: 60_000 }, () => privateDir('ops-ownership-', async root => {
  const svc = serviceHome(root, await freePort());
  // A process this test spawned but the ops scripts did not: a stand-in for a reused pid.
  const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const info = processInfo(foreign.pid!);
    assert.ok(info, 'the foreign process is observable');
    const record = join(svc.home, 'assistant-service.json');
    writeFileSync(record, JSON.stringify({ version: 1, pid: foreign.pid, processStartTime: `${info.startTime}-earlier`, endpoint: svc.endpoint, configPath: svc.config }));
    const health = runScript('health', ['--config', svc.config]);
    assert.equal(health.status, 1); assert.equal(health.json.state, 'stale_record');
    const stopped = runScript('stop', ['--config', svc.config]);
    assert.equal(stopped.status, 0); assert.equal(stopped.json.result, 'stale_record_removed');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(alive(foreign.pid!), true, 'the foreign process is untouched');
    const started = runScript('start', ['--config', svc.config]);
    assert.equal(started.json.result, 'started', 'a stale record does not block a fresh start');
    assert.notEqual(started.json.pid, foreign.pid);
    assert.equal(runScript('stop', ['--config', svc.config]).json.result, 'stopped');
    assert.equal(alive(foreign.pid!), true);
  } finally { foreign.kill(); killRecordedService(svc.home); }
}));

/** A disposable copy of this package, optionally with a source edit, standing in for another installed version. */
function version(root: string, name: string, edits: [string, string, string][] = []): string {
  const dir = join(root, name);
  for (const part of ['src', 'scripts', 'package.json']) cpSync(join(assistant, part), join(dir, part), { recursive: true });
  for (const [file, before, after] of edits) {
    const path = join(dir, file), source = readFileSync(path, 'utf8');
    assert.equal(source.split(before).length, 2, `${file}: unique anchor`);
    writeFileSync(path, source.replace(before, after));
  }
  return join(dir, 'scripts');
}

test('safe update: drain, back up, migrate, health-check, then roll back to the compatible version and database', { skip: process.platform !== 'win32' && 'backups need the Windows DPAPI protector', timeout: 180_000 }, () => privateDir('ops-update-', async root => {
  const port = await freePort();
  const svc = serviceHome(root, port);
  const v1 = version(root, 'v1');
  // v2 migrates the task database to schema 2, then fails its health check.
  const v2 = version(root, 'v2', [
    ['src/store/db.ts', "if (version > 1) throw new Error('Unsupported database version');", "if (version > 2) throw new Error('Unsupported database version'); if (version === 1) this.db.exec('ALTER TABLE tasks ADD COLUMN v2 TEXT; PRAGMA user_version = 2');"],
    ['src/http/server.ts', "send(res, 200, store.list(cursor, numberParam(url, 'limit', 50, 1, 100))); return;", "throw new Error('v2 regression');"],
  ]);
  const restored = join(root, 'restored'); mkdirSync(restored);
  const backup = join(root, 'pre-update.backup');
  try {
    assert.equal(runScript('start', ['--config', svc.config], { dir: v1 }).json.result, 'started');
    assert.equal((await api(svc.endpoint, '/v1/tasks', createTaskBody('task-1', 'before update'))).status, 200);
    assert.deepEqual(runScript('stop', ['--config', svc.config], { dir: v1 }).json.mode, 'graceful', 'stop admission and drain');
    const saved = runScript('backup', ['--config', svc.config, '--out', backup], { dir: v1 });
    assert.equal(saved.status, 0, saved.stdout + saved.stderr); assert.equal(saved.json.result, 'backed_up');

    const upgraded = runScript('start', ['--config', svc.config], { dir: v2 });
    assert.equal(upgraded.status, 1); assert.equal(upgraded.json.code, 'start_unhealthy', upgraded.stdout);
    assert.equal(runScript('health', ['--config', svc.config], { dir: v2 }).json.state, 'stopped', 'a failed start leaves nothing running');

    const downgraded = runScript('start', ['--config', svc.config], { dir: v1 });
    assert.equal(downgraded.status, 1); assert.equal(downgraded.json.code, 'start_failed', 'the old version refuses the migrated database');

    const restore = runScript('restore', ['--backup', backup, '--into', restored, '--profile', PROFILE], { dir: v1 });
    assert.equal(restore.status, 0, restore.stdout + restore.stderr); assert.equal(restore.json.result, 'restored');
    writeConfig(svc.config, join(restored, 'tasks.sqlite'), svc.endpoint);
    assert.equal(runScript('start', ['--config', svc.config], { dir: v1 }).json.result, 'started');
    assert.equal(runScript('health', ['--config', svc.config], { dir: v1 }).json.state, 'healthy');
    assert.equal((await (await api(svc.endpoint, '/v1/tasks/task-1')).json() as { title: string }).title, 'before update');
    assert.equal(runScript('stop', ['--config', svc.config], { dir: v1 }).json.result, 'stopped');
  } finally { killRecordedService(svc.home); }
}));
