import { assistantConfig, assistantRequest, HttpError } from './assistant-client.ts';
import type { LocalProbe, ProbeResult } from './prod-health.ts';

/**
 * The local assistant service as a sense: one authenticated loopback read of the endpoint in the profile's
 * assistant.json. Slack, the inbox and the task queue all go through that service, so when it is down the usual alert
 * channel is down with it; this monitor tells the operator in the terminal instead (see `defaultMonitors`).
 * On 11/11 a reboot made Windows reserve the configured port, the service never came back and nothing noticed for five hours.
 */
export const ASSISTANT_HEALTH_FILE = 'assistant-health.json';
export const ASSISTANT_PROBE = 'Assistente local';
const READ_TIMEOUT_MS = 5000;

type Read = (dir: string) => Promise<unknown>;
const readTasks: Read = dir => assistantRequest(assistantConfig({ dir }), '/v1/tasks?limit=1', undefined, READ_TIMEOUT_MS);

const why = (error: unknown): string => {
  if (error instanceof HttpError) return `HTTP ${error.status}`;
  if (error instanceof Error && error.name === 'TimeoutError') return `sem resposta em ${READ_TIMEOUT_MS / 1000}s`;
  const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return typeof code === 'string' ? `sem conexão (${code})` : 'falha ao ler o serviço';
};

export function assistantProbe(read: Read = readTasks, now: () => number = Date.now): LocalProbe {
  return {
    name: ASSISTANT_PROBE,
    async check({ dir } = { dir: '' }): Promise<ProbeResult> {
      let endpoint: string;
      try { endpoint = assistantConfig({ dir }).endpoint; } catch { return { ok: false, ms: 0, problem: 'assistant.json ilegível ou inválido' }; }
      const started = now();
      try { await read(dir); return { ok: true, ms: now() - started }; }
      catch (error) { return { ok: false, ms: now() - started, problem: `${endpoint}: ${why(error)}` }; }
    },
  };
}

/** What the woken agent is told: where to look, and that Slack cannot carry the answer. */
export const ASSISTANT_WAKE_NOTE = "The local assistant service (the one in this profile's assistant.json, which Slack and the inbox go through) has not answered two health reads in a row, so Slack delivery is down with it. Tell the operator here, in the terminal. Look at the service log beside its config: a `Listen failed: EACCES` means Windows reserved the port (netsh interface ipv4 show excludedportrange protocol=tcp), so move the endpoint to a port below 49152 in both configs; node assistant/scripts/health.mjs --config <path> and start.mjs (now answering port_reserved) tell the rest.";
