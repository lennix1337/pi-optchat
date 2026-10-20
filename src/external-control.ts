import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The control inbox a pi-subagents runner watches inside its run directory.
 * A request file is the runner's own cross-process channel, so whoever writes
 * it reaches the run without owning its session.
 */
const MAX_STEER_MESSAGE_BYTES = 128 * 1024;

export interface ControlRequestOptions {
  /** Which step of a multi-step run the request is about; the runner counts steps by position. */
  stepIndex?: number;
  source?: string;
  reason?: string;
  mode?: 'steer' | 'follow_up' | 'auto';
}

export function controlInboxDir(asyncDir: string) { return join(asyncDir, 'control'); }
export function stopRequestsDir(asyncDir: string) { return join(controlInboxDir(asyncDir), 'stop-requests'); }
export function steerRequestsDir(asyncDir: string) { return join(controlInboxDir(asyncDir), 'steer-requests'); }
export function interruptRequestPath(asyncDir: string) { return join(controlInboxDir(asyncDir), 'interrupt.json'); }
export function stopInboxClosedPath(asyncDir: string) { return join(controlInboxDir(asyncDir), 'stop-inbox-closed.json'); }
export function steerInboxClosedPath(asyncDir: string) { return join(controlInboxDir(asyncDir), 'steer-inbox-closed.json'); }

function writeAtomicJson(file: string, payload: object) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(payload, null, 2), { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/** Asks the runner to stop a run, or one step of it. */
export function requestStop(asyncDir: string, options: ControlRequestOptions = {}): string {
  if (options.stepIndex !== undefined && (!Number.isInteger(options.stepIndex) || options.stepIndex < 0)) {
    throw new Error('A step index must be a non-negative whole number.');
  }
  if (existsSync(stopInboxClosedPath(asyncDir))) throw new Error('The runner closed its stop inbox, so this run can no longer be stopped.');
  const ts = Date.now();
  const request = {
    type: 'stop',
    ts,
    ...(options.source ? { source: options.source } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    ...(options.stepIndex !== undefined ? { targetIndex: options.stepIndex } : {}),
  };
  const file = join(stopRequestsDir(asyncDir), `${String(ts).padStart(13, '0')}-${randomUUID()}.json`);
  writeAtomicJson(file, request);
  if (existsSync(stopInboxClosedPath(asyncDir))) {
    rmSync(file, { force: true });
    throw new Error('The runner closed its stop inbox, so this run can no longer be stopped.');
  }
  return file;
}

/** Sends a message to a live run, or to one step of it. */
export function requestSteer(asyncDir: string, message: string, options: ControlRequestOptions = {}): string {
  const text = message.trim();
  if (!text) throw new Error('A steering message cannot be empty.');
  if (Buffer.byteLength(text, 'utf8') > MAX_STEER_MESSAGE_BYTES) throw new Error('A steering message cannot be larger than 128 KiB.');
  if (options.stepIndex !== undefined && (!Number.isInteger(options.stepIndex) || options.stepIndex < 0)) {
    throw new Error('A step index must be a non-negative whole number.');
  }
  const ts = Date.now(), id = `optchat-${ts}-${randomUUID()}`;
  const request = {
    type: 'steer',
    id,
    ts,
    message: text,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.stepIndex !== undefined ? { targetIndex: options.stepIndex } : {}),
    ...(options.source ? { source: options.source } : {}),
  };
  const file = join(steerRequestsDir(asyncDir), `${String(ts).padStart(13, '0')}-${Buffer.from(id).toString('base64url')}.json`);
  writeAtomicJson(file, request);
  return file;
}

/** Asks the runner to interrupt (pause) a run without ending it. */
export function requestInterrupt(asyncDir: string, options: ControlRequestOptions = {}): string {
  const ts = Date.now();
  const request = {
    type: 'interrupt',
    ts,
    ...(options.source ? { source: options.source } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
  };
  const file = interruptRequestPath(asyncDir);
  writeAtomicJson(file, request);
  return file;
}
