import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { brasiliaTime } from './heartbeat.ts';
import { atomicWrite } from './store.ts';

/**
 * Production health as a sense, read-only and without personal data: every few minutes each probe asks a public URL and
 * checks more than the status code (the expected content, the API's own subsystem report, latency) and reads the
 * deployed web build. A probe that fails twice in a row alerts once: a line in the project's Slack channel and one
 * woken turn; its recovery is posted without a turn. Steady state (healthy or still down) costs no model call.
 */
export interface ProbeResult { ok: boolean; problem?: string; ms: number; build?: string }
export interface Probe { name: string; url: string; slowMs: number; judge(status: number, body: string): { problem?: string; build?: string } }
export type Fetcher = (url: string, timeoutMs: number) => Promise<{ status: number; body: string }>;

const api: Probe = {
  name: 'API DentAI', url: 'https://api.dentai.com.br/health', slowMs: 3000,
  judge(status, body) {
    if (status !== 200) return { problem: `HTTP ${status}` };
    let report: { status?: string; details?: Record<string, { status?: string }> };
    try { report = JSON.parse(body); } catch { return { problem: 'resposta não é JSON' }; }
    const bad = Object.entries(report.details ?? {}).filter(([, d]) => d?.status !== 'ok').map(([name, d]) => `${name}=${d?.status ?? '?'}`);
    if (report.status !== 'ok' || bad.length) return { problem: `health ${report.status ?? '?'}${bad.length ? ` (${bad.join(', ')})` : ''}` };
    return {};
  },
};
const web: Probe = {
  name: 'Site dentai.com.br', url: 'https://dentai.com.br/', slowMs: 4000,
  judge(status, body) {
    if (status !== 200) return { problem: `HTTP ${status}` };
    const build = /data-dpl-id="([0-9a-f]{7,40})"/.exec(body)?.[1];
    if (!/<html[^>]*lang="pt-BR"/.test(body) || !build) return { problem: 'página sem o conteúdo esperado (html pt-BR com build)' };
    return { build };
  },
};
const us: Probe = {
  name: 'Site usdentai.com', url: 'https://usdentai.com/', slowMs: 4000,
  judge: (status, body) => status !== 200 ? { problem: `HTTP ${status}` } : /<title>[^<]*Dentai/i.test(body) ? {} : { problem: 'página sem o título esperado' },
};
export const DEFAULT_PROBES: Probe[] = [api, web, us];

const defaultFetch: Fetcher = async (url, timeoutMs) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { 'user-agent': 'optchat-health/1' } });
  return { status: response.status, body: (await response.text()).slice(0, 1_000_000) };
};

export async function runProbe(probe: Probe, fetcher: Fetcher, now: () => number = Date.now): Promise<ProbeResult> {
  const started = now();
  try {
    const { status, body } = await fetcher(probe.url, 15_000);
    const ms = now() - started, { problem, build } = probe.judge(status, body);
    const slow = !problem && ms > probe.slowMs ? `lento: ${(ms / 1000).toFixed(1)}s` : undefined;
    return { ok: !problem && !slow, ms, ...(problem ?? slow ? { problem: problem ?? slow } : {}), ...(build ? { build } : {}) };
  } catch (error) {
    return { ok: false, ms: now() - started, problem: error instanceof Error && error.name === 'TimeoutError' ? 'sem resposta em 15s' : `falha de rede: ${error instanceof Error ? error.message.slice(0, 120) : String(error)}` };
  }
}

type ProbeState = { failures: number; down: boolean; since: number; problem?: string; lastOk?: number; build?: string; ms?: number };
export type HealthState = Record<string, ProbeState>;
export type Transition = { probe: string; kind: 'down' | 'recovered'; text: string };
/** Consecutive failures before a probe is called down: one blip is not an outage. */
export const FAILURES_BEFORE_ALERT = 2;

/** Folds one round of results into the state and returns the transitions worth telling: down once, recovered once. */
export function advance(state: HealthState, results: Map<string, ProbeResult>, now: number): Transition[] {
  const out: Transition[] = [];
  for (const [name, r] of results) {
    const s = state[name] ??= { failures: 0, down: false, since: now };
    s.ms = r.ms;
    if (r.build) s.build = r.build;
    if (r.ok) {
      if (s.down) out.push({ probe: name, kind: 'recovered', text: `✅ ${name} voltou às ${brasiliaTime(now)} (fora desde ${brasiliaTime(s.since)}; ${r.ms} ms)` });
      Object.assign(s, { failures: 0, down: false, since: now, lastOk: now });
      delete s.problem;
      continue;
    }
    s.failures++;
    s.problem = r.problem;
    if (!s.down && s.failures >= FAILURES_BEFORE_ALERT) {
      s.down = true; s.since = now;
      out.push({ probe: name, kind: 'down', text: `🔴 ${name} com problema às ${brasiliaTime(now)}: ${r.problem} (${s.failures} checagens seguidas)` });
    }
  }
  return out;
}

/** One line per probe for the morning summary and the status command. */
export function healthLines(state: HealthState): string[] {
  return Object.entries(state).map(([name, s]) => s.down ? `🔴 ${name}: ${s.problem ?? 'fora'} desde ${brasiliaTime(s.since)}` : `✅ ${name}${s.ms !== undefined ? ` (${s.ms} ms)` : ''}${s.build ? ` · build ${s.build.slice(0, 8)}` : ''}`);
}

const FILE = 'prod-health.json';
export function readHealth(dir: string): HealthState {
  try { return existsSync(join(dir, FILE)) ? JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as HealthState : {}; } catch { return {}; }
}

export class ProdHealth {
  constructor(private readonly options: { probes?: Probe[]; fetcher?: Fetcher; now?: () => number } = {}) {}

  /** One round: probes all, saves the state in `dir`, returns the transitions. */
  async round(dir: string): Promise<Transition[]> {
    const now = this.options.now ?? Date.now, fetcher = this.options.fetcher ?? defaultFetch;
    const probes = this.options.probes ?? DEFAULT_PROBES;
    const results = new Map(await Promise.all(probes.map(async p => [p.name, await runProbe(p, fetcher, now)] as const)));
    const state = readHealth(dir), transitions = advance(state, results, now());
    atomicWrite(join(dir, FILE), JSON.stringify(state));
    return transitions;
  }
}

/** Every transition goes to #dentai; only an outage wakes the agent (a recovery needs no decision). */
export async function tellTransitions(transitions: Transition[], post: (text: string, channel: string | null) => Promise<unknown>, wake: (text: string) => Promise<unknown> | void, test = false) {
  for (const t of transitions) {
    const text = `${test ? '[teste de injeção] ' : ''}${t.text}`;
    // A failed post is not lost: the wake below carries the same text, and a failed wake is posted instead.
    const posted = await post(text, 'dentai').then(() => true, () => false);
    if (t.kind !== 'down') continue;
    const woke = await Promise.resolve(wake(`[OptChat health] ${text}\nProduction is failing a read-only health probe. Investigate read-only (logs, recent deploys), report in #dentai, and do not write to production without the operator's OK.${test ? ' This is a controlled injection test: confirm you received it and stop.' : ''}`)).then(() => true, () => false);
    if (!woke && posted) await post(`${text} (não consegui acordar o agente: veja no terminal)`, 'dentai').catch(() => undefined);
  }
}

export type HealthOwner = { dir: string };
/**
 * Every 5 minutes while a profile with the assistant is open: a down transition posts to #dentai and wakes the agent
 * once; a recovery only posts. `/optchat-health` shows the state; `/optchat-health test` runs the alert path on a
 * synthetic probe, marked as a test, to prove the wiring end to end.
 */
export function registerProdHealth(pi: ExtensionAPI, owner: () => HealthOwner | undefined, post: (text: string, channel: string | null) => Promise<unknown>,
  wake: (text: string) => Promise<unknown> | void, health = new ProdHealth(), intervalMs = 5 * 60_000) {
  let timer: ReturnType<typeof setInterval> | undefined, busy = false, lastError: string | undefined;
  const tell = (transitions: Transition[], test = false) => tellTransitions(transitions, post, wake, test);
  const round = async () => {
    const o = owner();
    if (busy || !o || !existsSync(join(o.dir, 'assistant.json'))) return;
    busy = true;
    // A failed round is retried next interval; /optchat-health shows why it failed.
    try { await tell(await health.round(o.dir)); lastError = undefined; }
    catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    finally { busy = false; }
  };
  pi.on('session_start', () => {
    if (timer) clearInterval(timer);
    timer = setInterval(() => void round(), intervalMs); timer.unref?.();
    const first = setTimeout(() => void round(), 60_000); first.unref?.();
  });
  pi.on('session_shutdown', () => { if (timer) clearInterval(timer); timer = undefined; });
  pi.registerCommand('optchat-health', {
    description: 'Production health probes (read-only): state now; "test" injects a synthetic failure through the alert path',
    handler: async (args, ctx) => {
      const o = owner();
      if (!o) throw new Error('Open an OptChat profile first.');
      if (args.trim() === 'test') {
        const probe: Probe = { name: 'Sonda de teste', url: 'https://example.invalid/', slowMs: 1000, judge: () => ({ problem: 'falha injetada' }) };
        const fake = new ProdHealth({ probes: [probe], fetcher: async () => ({ status: 500, body: '' }) });
        const dir = join(o.dir, 'prod-health-test');
        let transitions: Transition[] = [];
        for (let i = 0; i < FAILURES_BEFORE_ALERT; i++) transitions = [...transitions, ...await fake.round(dir)];
        await tell(transitions, true);
        ctx.ui.notify(`Injected: ${transitions.length} alert(s) sent through the real path.`, 'info');
        return;
      }
      await round();
      const lines = [...healthLines(readHealth(o.dir)), ...lastError ? [`Last round failed: ${lastError}`] : []];
      ctx.ui.notify(lines.join('\n') || 'No probe has run yet (the assistant service must be configured).', lastError ? 'warning' : 'info');
    },
  });
}
