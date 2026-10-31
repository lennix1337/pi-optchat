import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelChoice } from './compactor.ts';
import { atomicWrite } from './store.ts';

/** The main model a wake switched away from. On disk, so a /reload or crash in the middle of a wake still puts it back. */
export const WAKE_RESTORE_FILE = 'wake-restore.json';

export interface WakeHost<M> {
  current(): (M & { provider: string; id: string }) | undefined;
  find(provider: string, model: string): M | undefined;
  setModel(model: M): Promise<boolean>;
  thinking(): ThinkingLevel;
  setThinking(level: ThinkingLevel): void;
  notify(text: string, level: 'warning' | 'error'): void;
}

const saved = (dir: string): ModelChoice | undefined => {
  const file = join(dir, WAKE_RESTORE_FILE);
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<ModelChoice>;
  return typeof value.provider === 'string' && typeof value.model === 'string' && typeof value.thinking === 'string' ? value as ModelChoice : undefined;
};

/** Switches to `choice` for a wake, recording the main model first; a wake while already switched keeps the first record. */
export async function wakeOn<M>(dir: string, choice: ModelChoice | undefined, host: WakeHost<M>) {
  const current = host.current();
  if (!choice || !current) return;
  const model = host.find(choice.provider, choice.model);
  const first = !saved(dir);
  if (first) atomicWrite(join(dir, WAKE_RESTORE_FILE), JSON.stringify({ provider: current.provider, model: current.id, thinking: host.thinking() }));
  if (model && await host.setModel(model)) { host.setThinking(choice.thinking); return; }
  if (first) rmSync(join(dir, WAKE_RESTORE_FILE), { force: true });
  host.notify(`Wake model ${choice.provider}/${choice.model} is unavailable; this wake runs on ${current.provider}/${current.id}.`, 'warning');
}

/** Puts back the model a wake switched away from, if any. The record stays when that fails, so the next settle tries again. */
export async function wakeOff<M>(dir: string, host: WakeHost<M>) {
  const back = saved(dir);
  if (!back) return;
  const model = host.find(back.provider, back.model);
  if (!model || !await host.setModel(model)) {
    host.notify(`Could not switch back to ${back.provider}/${back.model} after the wake; choose it with /model.`, 'error');
    return;
  }
  host.setThinking(back.thinking);
  rmSync(join(dir, WAKE_RESTORE_FILE), { force: true });
}
