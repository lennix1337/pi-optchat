import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { brasiliaTime } from './heartbeat.ts';
import { assistantProbe, ASSISTANT_HEALTH_FILE, ASSISTANT_WAKE_NOTE } from './assistant-health.ts';
import { pcProbes } from './pc-health.ts';
import { loadedCodeProbe, LOADED_CODE_HEALTH_FILE, LOADED_CODE_WAKE_NOTE } from './loaded-code-health.ts';
import { providerLogProbe, PROVIDER_LOG_HEALTH_FILE, quotaProbe, QUOTA_HEALTH_FILE } from './quota-health.ts';
import { sampleQuotaRound } from './quota-load.ts';
import { applyRemedies, type Remedy } from './self-fix.ts';
import { appendSignals } from './journal-spool.ts';
import { atomicWrite, readJsonOr } from './store.ts';












/** `edge`: CDN colo and cache status (Cloudflare cf-ray / cf-cache-status), so a slow stretch can be tied to a path. `waitMs`: time until the server answered (response headers); `ms - waitMs` is reading the body. Only remote probes have it. */
export interface ProbeResult { ok: boolean; problem?: string; ms: number; build?: string; detail?: string; waitMs?: number; edge?: string }
export interface Probe { name: string; url: string; slowMs: number; judge(status: number, body: string): { problem?: string; build?: string } }


/** `dir` is the profile directory the round runs for, for probes that read its files (assistant.json). */
export interface LocalProbe { name: string; check(context?: { dir: string }): ProbeResult | Promise<ProbeResult>; remedy?: Remedy }
export type Fetcher = (url: string, timeoutMs: number) => Promise<{ status: number; body: string; headersMs?: number; edge?: string }>;

export type ProbeSpec = { name: string; url: string; slowMs: number; judge: { kind: 'jsonHealth'; okStatus: string } | { kind: 'regex'; pattern: string; flags?: string; buildPattern?: string; problem: string } };
export interface ProductionHealthConfig { probes: ProbeSpec[]; channel: string | null; wakeNote?: string }

/** Compile only validated configuration; the JSON judge checks every reported subsystem. */
export function configuredProbes(specs: ProbeSpec[]): Probe[] {
  return specs.map(({ name, url, slowMs, judge }) => ({ name, url, slowMs, judge(status, body) {
    if (status !== 200) return { problem: `HTTP ${status}` };
    if (judge.kind === 'jsonHealth') {
      let report: { status?: string; details?: Record<string, { status?: string }> };
      try { report = JSON.parse(body); } catch { return { problem: 'resposta não é JSON' }; }
      const bad = Object.entries(report.details ?? {}).filter(([, d]) => d?.status !== judge.okStatus).map(([key, d]) => `${key}=${d?.status ?? '?'}`);
      if (report.status !== judge.okStatus || bad.length) return { problem: `health ${report.status ?? '?'}${bad.length ? ` (${bad.join(', ')})` : ''}` };
      return {};
    }
    const match = new RegExp(judge.pattern, judge.flags).test(body);
    const build = judge.buildPattern ? new RegExp(judge.buildPattern).exec(body)?.[1] : undefined;
    if (!match || judge.buildPattern && !build) return { problem: judge.problem };
    return build ? { build } : {};
  } }));
}
export const DEFAULT_PROBES: Probe[] = [];

export function validProductionHealth(value: unknown): value is ProductionHealthConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.probes) || !(v.channel === null || typeof v.channel === 'string' && !!v.channel.trim()) || v.wakeNote !== undefined && typeof v.wakeNote !== 'string') return false;
  const names = new Set<string>();
  return v.probes.every((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const p = raw as Record<string, unknown>;
    if (typeof p.name !== 'string' || !p.name.trim() || names.has(p.name) || typeof p.url !== 'string' || typeof p.slowMs !== 'number' || !Number.isFinite(p.slowMs) || p.slowMs <= 0 || !p.judge || typeof p.judge !== 'object' || Array.isArray(p.judge)) return false;
    names.add(p.name);
    try { if (new URL(p.url).protocol !== 'https:') return false; } catch { return false; }
    const j = p.judge as Record<string, unknown>;
    if (j.kind === 'jsonHealth') return typeof j.okStatus === 'string' && !!j.okStatus;
    if (j.kind !== 'regex' || typeof j.pattern !== 'string' || !j.pattern || typeof j.problem !== 'string' || !j.problem || j.flags !== undefined && j.flags !== 'i' || j.buildPattern !== undefined && typeof j.buildPattern !== 'string') return false;
    try { new RegExp(j.pattern, j.flags as string | undefined); if (j.buildPattern !== undefined) new RegExp(j.buildPattern as string); } catch { return false; }
    return true;
  });
}

const defaultFetch: Fetcher = async (url, timeoutMs) => {
  const started = performance.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { 'user-agent': 'optchat-health/1' } });
  const headersMs = Math.round(performance.now() - started);
  const colo = /-([A-Z]{3})$/.exec(response.headers.get('cf-ray') ?? '')?.[1], cache = response.headers.get('cf-cache-status') ?? undefined;
  const edge = [colo, cache].filter(Boolean).join(' ') || undefined;
  return { status: response.status, body: (await response.text()).slice(0, 1_000_000), headersMs, ...(edge ? { edge } : {}) };
};

const reason = (error: unknown) => {
  if (!(error instanceof Error)) return String(error);
  const cause = (error.cause as { code?: unknown } | undefined)?.code;
  return `${error.message.slice(0, 120)}${typeof cause === 'string' ? ` (${cause})` : ''}`;
};

export function runProbe(probe: Probe | LocalProbe, fetcher: Fetcher, now: () => number = Date.now, dir = ''): Promise<ProbeResult> {
  return 'check' in probe ? runLocal(probe, dir) : runRemote(probe, fetcher, now);
}

async function runLocal(probe: LocalProbe, dir: string): Promise<ProbeResult> {
  try { return await probe.check({ dir }); } catch (error) { return { ok: false, ms: 0, problem: `falha na checagem: ${reason(error)}` }; }
}

async function runRemote(probe: Probe, fetcher: Fetcher, now: () => number): Promise<ProbeResult> {
  const started = now();
  try {
    const { status, body, headersMs, edge } = await fetcher(probe.url, 15_000);
    const ms = now() - started, { problem, build } = probe.judge(status, body);
    const seconds = (n: number) => (n / 1000).toFixed(1);
    const split = headersMs === undefined ? '' : ` (${seconds(headersMs)}s até o servidor responder, ${seconds(Math.max(0, ms - headersMs))}s lendo a página)`;
    const slow = !problem && ms > probe.slowMs ? `lento: ${seconds(ms)}s${split}` : undefined;
    return { ok: !problem && !slow, ms, ...(problem ?? slow ? { problem: problem ?? slow } : {}), ...(build ? { build } : {}), ...(headersMs === undefined ? {} : { waitMs: headersMs }), ...(edge ? { edge } : {}) };
  } catch (error) {
    return { ok: false, ms: now() - started, problem: error instanceof Error && error.name === 'TimeoutError' ? 'sem resposta em 15s' : `falha de rede: ${reason(error)}` };
  }
}

type ProbeState = { failures: number; down: boolean; since: number; problem?: string; lastOk?: number; build?: string; ms?: number; detail?: string };
export type HealthState = Record<string, ProbeState>;
export type Transition = { probe: string; kind: 'down' | 'recovered'; text: string; at?: number };
/** Consecutive failures before a probe is called down: one blip is not an outage. */
export const FAILURES_BEFORE_ALERT = 2;

/** Folds one round of results into the state and returns the transitions worth telling: down once, recovered once. */
export function advance(state: HealthState, results: Map<string, ProbeResult>, now: number): Transition[] {
  const out: Transition[] = [];
  for (const [name, r] of results) {
    const s = state[name] ??= { failures: 0, down: false, since: now };
    s.ms = r.ms;
    if (r.build) s.build = r.build;
    if (r.detail) s.detail = r.detail;
    if (r.ok) {
      if (s.down) out.push({ probe: name, kind: 'recovered', text: `✅ ${name} voltou às ${brasiliaTime(now)} (fora desde ${brasiliaTime(s.since)}; ${r.ms} ms)`, at: now });
      Object.assign(s, { failures: 0, down: false, since: now, lastOk: now });
      delete s.problem;
      continue;
    }
    s.failures++;
    s.problem = r.problem;
    if (!s.down && s.failures >= FAILURES_BEFORE_ALERT) {
      s.down = true; s.since = now;
      out.push({ probe: name, kind: 'down', text: `🔴 ${name} com problema às ${brasiliaTime(now)}: ${r.problem} (${s.failures} checagens seguidas)`, at: now });
    }
  }
  return out;
}


const DNS_FAULT = /\((ENOTFOUND|EAI_AGAIN)\)$/;
function withoutLocalNetworkFaults(probes: readonly (Probe | LocalProbe)[], results: Map<string, ProbeResult>): Map<string, ProbeResult> {
  const remote = probes.filter(p => !('check' in p)).map(p => results.get(p.name)!);
  if (remote.length < 2 || !remote.every(r => !r.ok && DNS_FAULT.test(r.problem ?? ''))) return results;
  const kept = new Map(results);
  for (const p of probes) if (!('check' in p)) kept.delete(p.name);
  return kept;
}

/** One line per probe for the morning summary and the status command. */
export function healthLines(state: HealthState): string[] {
  const measure = (s: ProbeState) => s.detail ? ` · ${s.detail}` : s.ms !== undefined ? ` (${s.ms} ms)` : '';
  return Object.entries(state).map(([name, s]) => s.down ? `🔴 ${name}: ${s.problem ?? 'fora'} desde ${brasiliaTime(s.since)}` : `✅ ${name}${measure(s)}${s.build ? ` · build ${s.build.slice(0, 8)}` : ''}`);
}

const FILE = 'prod-health.json';
const NL = String.fromCharCode(10);

const HISTORY_MAX = 3000, HISTORY_KEEP = 2000;
export let prodHealthReadBytes = 0;
const historyLines = new Map<string, { size: number; lines: number }>();
function fileSize(file: string): number {
  try { return statSync(file).size; } catch { return 0; }
}

function appendHistory(file: string, at: number, results: Map<string, ProbeResult>): void {
  if (!results.size) return;
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    const row = ([probe, r]: [string, ProbeResult]) => JSON.stringify({ at, probe, ms: r.ms, ok: r.ok, ...(r.waitMs === undefined ? {} : { waitMs: r.waitMs }), ...(r.edge ? { edge: r.edge } : {}), ...(r.problem ? { problem: r.problem } : {}) });
    const text = [...results].map(row).join(NL) + NL;
    const preSize = fileSize(file), cached = historyLines.get(file);
    let lines: number;
    if (cached && cached.size === preSize) lines = cached.lines;
    else if (preSize === 0) lines = 0;
    else {
      const content = readFileSync(file, 'utf8');
      prodHealthReadBytes += Buffer.byteLength(content);
      lines = content.split(NL).filter(Boolean).length;
    }
    appendFileSync(file, text);
    lines += results.size;
    if (lines > HISTORY_MAX) {
      const content = readFileSync(file, 'utf8');
      prodHealthReadBytes += Buffer.byteLength(content);
      const rows = content.split(NL).filter(Boolean);
      const kept = rows.slice(-HISTORY_KEEP).join(NL) + NL;
      atomicWrite(file, kept);
      historyLines.set(file, { size: Buffer.byteLength(kept), lines: Math.min(rows.length, HISTORY_KEEP) });
    } else {
      historyLines.set(file, { size: preSize + Buffer.byteLength(text), lines });
    }
  } catch {   }
}
export const PC_FILE = 'pc-health.json';
export function readHealth(dir: string, file = FILE): HealthState {
  return readJsonOr<HealthState>(join(dir, file), {});
}

export class ProdHealth {
  constructor(private readonly options: { probes?: (Probe | LocalProbe)[]; fetcher?: Fetcher; now?: () => number; file?: string } = {}) {}
  get file() { return this.options.file ?? FILE; }
  now(): number { return (this.options.now ?? Date.now)(); }
  get remedies(): Map<string, Remedy> {
    return new Map((this.options.probes ?? []).flatMap(p => 'remedy' in p && p.remedy ? [[p.name, p.remedy] as const] : []));
  }

  /** One round: probes all, saves the state in `dir`, returns the transitions. */
  async round(dir: string): Promise<Transition[]> {
    const now = this.options.now ?? Date.now, fetcher = this.options.fetcher ?? defaultFetch;
    const probes = this.options.probes ?? DEFAULT_PROBES;
    const results = new Map(await Promise.all(probes.map(async p => [p.name, await runProbe(p, fetcher, now, dir)] as const)));
    const state = readHealth(dir, this.file), transitions = advance(state, withoutLocalNetworkFaults(probes, results), now());
    atomicWrite(join(dir, this.file), JSON.stringify(state));
    appendHistory(join(dir, this.file.replace(/\.json$/, '.history.jsonl')), now(), results);
    return transitions;
  }
}

/** Where a monitor's transitions go, and whether its outage wakes the agent. */
export interface Route {
  channel: string | null; wakes: boolean;
  /** Replaces the production instructions in the wake text. */
  wakeNote?: string;
  /** False keeps the monitor off Slack: for a monitor whose outage takes Slack down with it. The wake and the journal carry it. */
  slack?: false;
}
const PRODUCTION: Route = { channel: null, wakes: true, slack: false };
/** A set of probes with its own state file and route. */
export interface Monitor extends Route { health: ProdHealth }
/** Production is opt-in; local monitors stay enabled independently. */
export const defaultMonitors = (config?: ProductionHealthConfig): Monitor[] => [
  ...config ? [{ health: new ProdHealth({ probes: configuredProbes(config.probes) }), channel: config.channel, wakes: true,
    wakeNote: config.wakeNote ? `${config.wakeNote}\nDo not write to production without the operator's OK.` : undefined }] : [],
  { health: new ProdHealth({ probes: pcProbes(), file: PC_FILE }), channel: null, wakes: false },
  { health: new ProdHealth({ probes: [quotaProbe()], file: QUOTA_HEALTH_FILE }), channel: null, wakes: false },
  { health: new ProdHealth({ probes: [providerLogProbe()], file: PROVIDER_LOG_HEALTH_FILE }), channel: null, wakes: false },
  /** A merged fix is not live until the session reloads: the wake reloads it, nobody is messaged. */
  { health: new ProdHealth({ probes: [loadedCodeProbe()], file: LOADED_CODE_HEALTH_FILE }), channel: null, wakes: true, slack: false, wakeNote: LOADED_CODE_WAKE_NOTE },
  /** Slack runs through this service: its outage wakes the agent in the terminal and does not post to Slack. */
  { health: new ProdHealth({ probes: [assistantProbe()], file: ASSISTANT_HEALTH_FILE }), channel: null, wakes: true, slack: false, wakeNote: ASSISTANT_WAKE_NOTE },
];

/** Every transition is posted on the route's channel; only an outage on a waking route wakes the agent (a recovery needs no decision). */
export async function tellTransitions(transitions: Transition[], post: (text: string, channel: string | null) => Promise<unknown>, wake: (text: string) => Promise<unknown> | void, test = false, route: Route = PRODUCTION) {
  for (const t of transitions) {
    const text = `${test ? '[teste de injeção] ' : ''}${t.text}`;

    const posted = route.slack === false ? false : await post(text, route.channel).then(() => true, () => false);
    if (t.kind !== 'down' || !route.wakes) continue;
    const woke = await Promise.resolve(wake(`[OptChat health] ${text}\n${route.wakeNote ?? "Production is failing a read-only health probe. Investigate read-only (logs, recent deploys), and do not write to production without the operator's OK."}${test ? ' This is a controlled injection test: confirm you received it and stop.' : ''}`)).then(() => true, () => false);
    if (!woke && posted) await post(`${text} (não consegui acordar o agente: veja no terminal)`, route.channel).catch(() => undefined);
  }
}

/** The journal view of one monitor's transitions. The notification path is unchanged, so `attention` never claims a suppressed wake. */
export function healthSignals(file: string, transitions: readonly Transition[], now = Date.now()): import('./journal-spool.ts').SignalPublish[] {
  const source = file === PC_FILE ? 'pc' : file === QUOTA_HEALTH_FILE ? 'quota' : 'health';
  const kind = (t: Transition) => {
    if (t.kind === 'recovered') return source === 'pc' ? 'pc.recovered' as const : source === 'quota' ? 'quota.recovered' as const : 'health.recovered' as const;
    if (source === 'pc') return t.probe.includes('disco') ? 'pc.disk_low' as const : t.probe.includes('mem') ? 'pc.memory_low' as const : 'pc.maintenance_stale' as const;
    return source === 'quota' ? 'quota.exhausted' as const : 'health.down' as const;
  };
  return transitions.map(t => ({
    source, kind: kind(t),
    severity: t.kind === 'down' ? source === 'health' ? 'critical' : 'warning' : 'info',
    subject: `health:${file}:${t.probe}`,
    summary: t.text,
    dedupeKey: `health:${file}:${t.probe}:${t.kind}:${t.at ?? now}`,
    evidence: `health:${file}`,
    observedAt: t.at ?? now,
  }));
}

export type HealthOwner = { dir: string; prodHealth?: ProductionHealthConfig };
/** Every 5 minutes while a profile with the assistant is open: a down transition posts to the configured channel and wakes the agent
 * once; a recovery only posts. `/optchat-health` shows the state; `/optchat-health test` runs the alert path on a
 * synthetic probe, marked as a test, to prove the wiring end to end.
 */
export function registerProdHealth(pi: ExtensionAPI, owner: () => HealthOwner | undefined, post: (text: string, channel: string | null) => Promise<unknown>,
  wake: (text: string) => Promise<unknown> | void, monitors?: Monitor[], intervalMs = 5 * 60_000,
  /** Runs once per round: the quota history rows (src/quota-history.ts) ride this timer instead of a second one. */
  sample: (dir: string, now: number) => unknown = sampleQuotaRound) {
  let timer: ReturnType<typeof setInterval> | undefined, busy = false, lastError: string | undefined;
  const tell = (transitions: Transition[], test = false, route?: Route) => tellTransitions(transitions, post, wake, test, route);
  const round = async () => {
    const o = owner();
    if (busy || !o || !existsSync(join(o.dir, 'assistant.json'))) return;
    busy = true;
    try { await sample(o.dir, Date.now()); } catch {   }

    lastError = await roundAll(monitors ?? defaultMonitors(o.prodHealth), o.dir, tell, (transitions, monitor) => {
      appendSignals(o.dir, healthSignals(monitor.health.file, transitions, monitor.health.now()));
    });
    busy = false;
  };
  let first: ReturnType<typeof setTimeout> | undefined;
  const stop = () => { if (timer) clearInterval(timer); clearTimeout(first); timer = first = undefined; };
  pi.on('session_start', () => {
    stop();
    timer = setInterval(() => void round(), intervalMs); timer.unref?.();
    first = setTimeout(() => void round(), 60_000); first.unref?.();
  });
  pi.on('session_shutdown', stop);
  pi.registerCommand('optchat-health', {
    description: 'Production health probes (read-only): state now; "test" injects a synthetic failure through the alert path',
    handler: async (args, ctx) => {
      const o = owner();
      if (!o) throw new Error('Open an OptChat profile first.');
      if (args.trim() === 'test') {
        const transitions = await injectedOutage(join(o.dir, 'prod-health-test'));
        const route = monitors?.[0] ?? (o.prodHealth ? defaultMonitors(o.prodHealth)[0] : PRODUCTION);
        await tell(transitions, true, route);
        ctx.ui.notify(`Injected: ${transitions.length} alert(s) sent through the real path.`, 'info');
        return;
      }
      await round();
      const lines = [...(monitors ?? defaultMonitors(o.prodHealth)).flatMap(m => healthLines(readHealth(o.dir, m.health.file))), ...lastError ? [`Last round failed: ${lastError}`] : []];
      ctx.ui.notify(lines.join('\n') || 'No probe has run yet (the assistant service must be configured).', lastError ? 'warning' : 'info');
    },
  });
}


async function roundAll(monitors: readonly Monitor[], dir: string, tell: (t: Transition[], test: boolean, route: Route) => Promise<void>, observe?: (t: Transition[], monitor: Monitor) => void): Promise<string | undefined> {
  const errors: string[] = [];
  for (const m of monitors) {
    try {
      const transitions = await applyRemedies(await m.health.round(dir), m.health.remedies, dir, m.health.now());
      observe?.(transitions, m);
      await tell(transitions, false, m);
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  return errors.length ? errors.join('; ') : undefined;
}


async function injectedOutage(dir: string): Promise<Transition[]> {
  const probe: Probe = { name: 'Sonda de teste', url: 'https://example.invalid/', slowMs: 1000, judge: () => ({ problem: 'falha injetada' }) };
  const fake = new ProdHealth({ probes: [probe], fetcher: async () => ({ status: 500, body: '' }) });
  let transitions: Transition[] = [];
  for (let i = 0; i < FAILURES_BEFORE_ALERT; i++) transitions = [...transitions, ...await fake.round(dir)];
  return transitions;
}
