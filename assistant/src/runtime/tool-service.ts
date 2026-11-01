import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Config } from '../main.ts';
import type { Task } from '../contracts/tasks.ts';
import { browserTextRequest } from '../computer/effects.ts';
import type { DockerRunner } from '../computer/docker.ts';
import { createComputers } from '../computer/manager.ts';
import { createGateway, type Gateway } from '../policy/gateway.ts';
import type { TaskStore } from '../store/db.ts';
import { prepareDatabase } from '../store/privacy.ts';
import { browserTextPort } from './tool-browser.ts';
import { ToolEffects } from './tool-effects.ts';
import { ToolTask } from './tool-task.ts';
import type { ExecutorOptions } from './task-executor.ts';

/** The one adapter the executor's opt-in tools reach: inert text in an offline, network-less browser container. */
export const TOOL_IMAGE = 'optchat-computer-browser:1';
const POLICY_VERSION = 'executor-tools-1';
/** How long an unanswered preview review stays decidable; afterwards the task fails instead of waiting. */
const REVIEW_WINDOW_MS = 60 * 60_000;

export const toolGatewayPath = (config: Pick<Config, 'databasePath'>) => join(dirname(config.databasePath), 'tool-gateway.sqlite');
const computersPath = (config: Pick<Config, 'databasePath'>) => join(dirname(config.databasePath), 'computer.sqlite');

/**
 * The preview gateway. Every executor tool request needs a review; the authority that can decide one is held by
 * whoever constructs this gateway, so the service keeps its own private and only the local operator's script holds another.
 */
export function openToolGateway(config: Pick<Config, 'profileId' | 'databasePath'>, operatorAuthority: object): Gateway {
  prepareDatabase(toolGatewayPath(config));
  return createGateway({ databasePath: toolGatewayPath(config), profileId: config.profileId, operatorAuthority,
    policy: metadata => metadata.adapter === 'computer' && metadata.action === 'browser_text' ? 'review' : 'deny', inspect: () => ({ decision: 'allow', reasons: [] }) });
}

/**
 * Host side of the executor's tools: one gateway, one offline computer, one effect table. Model text only ever becomes
 * a preview request; no decision API is reachable from here, so a review waits for the operator's `executor.mjs`.
 * Starting it checks Docker and the local image once (never pulls); failure refuses to start the executor.
 */
/**
 * A shutdown cleanup that failed (Docker down) leaves a fence that refuses every create. `cleanup()` takes over only a
 * cleanup marked failed and refuses an overlapping live one, so resuming it once here is safe; a second refusal stands.
 */
async function createResumingCleanup(computers: ReturnType<typeof createComputers>, profileId: string) {
  try { return await computers.create(profileId, 'executor'); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'computer_cleanup_active') throw error;
    await computers.cleanup();
    return computers.create(profileId, 'executor');
  }
}

export async function openToolService(config: Config, store: TaskStore, docker?: DockerRunner): Promise<{ tools: NonNullable<ExecutorOptions['tools']>; close(): Promise<void> }> {
  const settings = config.executor!;
  prepareDatabase(computersPath(config));
  const authority = {};
  const owner = `assistant-${createHash('sha256').update(config.profileId).digest('hex').slice(0, 16)}`;
  const computers = createComputers({ databasePath: computersPath(config), owner, operatorAuthority: authority, image: TOOL_IMAGE, ...(docker ? { docker } : {}) });
  const gateway = openToolGateway(config, authority);
  let effects: ToolEffects | undefined;
  try {
    const computer = await createResumingCleanup(computers, config.profileId);
    const port = browserTextPort(gateway, computers);
    // A computer idle past its lifetime refuses work; creating it again is idempotent and renews it, so do it right before each dispatch.
    effects = new ToolEffects(config.databasePath, { ...port, dispatch: async (request, reviewId) => { await computers.create(config.profileId, 'executor'); return port.dispatch(request, reviewId); } },
      (id, revision) => { const task = store.get(id); return task?.status === 'working' && task.revision === revision; });
    const task = new ToolTask(store, effects, config.profileId, settings.channels[0]);
    const request = (current: Task, text: string, operationId: string) => browserTextRequest(
      { version: 1, operationId, profileId: config.profileId, sessionId: 'executor', taskId: current.taskId, runId: operationId, policyVersion: POLICY_VERSION, expiresAt: Date.now() + REVIEW_WINDOW_MS }, computer, text);
    const opened = effects;
    return { tools: { task, request }, async close() {
      opened.close(); gateway.close();
      try { await computers.cleanup(); } catch { console.error('Executor preview computer cleanup failed; inspect Docker for optchat computers.'); }
      computers.close();
    } };
  } catch (error) { effects?.close(); gateway.close(); computers.close(); throw error; }
}
