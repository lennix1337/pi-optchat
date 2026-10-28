import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskStore } from '../src/store/db.ts';
import { processInfo } from '../src/ops/service.ts';

export const PROFILE = 'ops-profile';
export const TOKEN = 'OPS-TEST-TOKEN-5c1d';
export const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));

/** A task store with one queued task `task-1`, as the service would hold it. */
export function seedTask(path: string, title: string, taskId = 'task-1'): void {
  const store = new TaskStore(path, PROFILE);
  try { store.create(newTask(taskId, title), newTaskEvent(taskId, store.nextSequence())); } finally { store.close(); }
}
export function newTask(taskId: string, title: string) {
  return { version: 1 as const, profileId: PROFILE, taskId, title, status: 'queued' as const, verification: 'not_verified' as const, revision: 1, inputRevision: 1, sourceEventId: `source-${taskId}` };
}
function newTaskEvent(taskId: string, sequence: number) {
  return { version: 1 as const, eventId: `event-${taskId}`, correlationId: `correlation-${taskId}`, profileId: PROFILE, taskId, sessionId: 'session', channelId: 'channel', runId: 'run',
    source: { actorId: 'ops-test', sourceKind: 'trusted-local-human' as const, sourceEventId: `source-${taskId}` }, observedAt: '2026-10-28T12:00:00Z', sequence,
    evidence: { kind: 'observed' as const, reference: 'ops-test' } };
}

export async function freePort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/** A disposable service home: `<root>/home/config.json` and its database in `<root>/home/data/`. */
export function serviceHome(root: string, port: number, name = 'home') {
  const home = join(root, name), data = join(home, 'data');
  mkdirSync(data, { recursive: true });
  const config = join(home, 'config.json'), endpoint = `http://127.0.0.1:${port}`;
  writeConfig(config, join(data, 'tasks.sqlite'), endpoint);
  return { home, data, config, endpoint, database: join(data, 'tasks.sqlite') };
}
export function writeConfig(config: string, databasePath: string, endpoint: string): void {
  writeFileSync(config, JSON.stringify({ version: 1, profileId: PROFILE, databasePath, endpoint, token: TOKEN }));
}

export type ScriptResult = { status: number | null; stdout: string; stderr: string; json: Record<string, unknown> };
function parsed(status: number | null, stdout: string, stderr: string): ScriptResult {
  const last = stdout.trim().split('\n').at(-1) ?? '';
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(last) as Record<string, unknown>; } catch { /* left empty: the caller asserts on status and output */ }
  return { status, stdout, stderr, json };
}
/** Runs one ops script from `dir` (default: this checkout's scripts) and parses its final JSON line. */
export function runScript(name: string, args: string[], options: { dir?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): ScriptResult {
  const result = spawnSync(process.execPath, [join(options.dir ?? scripts, `${name}.mjs`), ...args], { encoding: 'utf8', timeout: options.timeout ?? 60_000, windowsHide: true, env: options.env ?? process.env });
  if (result.error) throw result.error;
  return parsed(result.status, result.stdout, result.stderr);
}
export function runScriptAsync(name: string, args: string[]): Promise<ScriptResult> {
  const child = spawn(process.execPath, [join(scripts, `${name}.mjs`), ...args], { windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
  return new Promise(resolve => child.on('close', status => resolve(parsed(status, stdout, stderr))));
}

/**
 * Test cleanup: terminates the service only if this test's start script recorded it and the recorded
 * pid still has the recorded start time, so a reused pid is never touched.
 */
export function killRecordedService(home: string): void {
  const record = join(home, 'assistant-service.json');
  if (!existsSync(record)) return;
  const { pid, processStartTime } = JSON.parse(readFileSync(record, 'utf8')) as { pid: number; processStartTime: string };
  if (processInfo(pid)?.startTime === processStartTime) process.kill(pid);
}
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
/**
 * One authenticated request on a fresh connection. The tests block their event loop in spawnSync between requests,
 * so a pooled keep-alive socket could be stale and reset; `agent: false` never reuses one.
 */
export function api(endpoint: string, path: string, body?: unknown): Promise<{ status: number; json(): Promise<unknown> }> {
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(endpoint + path, { method: data === undefined ? 'GET' : 'POST', agent: false, timeout: 5000,
      headers: { authorization: `Bearer ${TOKEN}`, ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }) } }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: async () => JSON.parse(text) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('request_timeout')));
    req.on('error', reject);
    req.end(data);
  });
}
export function createTaskBody(taskId: string, title: string) {
  return { task: newTask(taskId, title), context: { sessionId: 'session', channelId: 'channel', runId: 'run', sourceEventId: `source-${taskId}`, evidenceReference: 'ops-test' } };
}
