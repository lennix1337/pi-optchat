import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { isActiveRun, isTerminalState, orderRuns, type RunInfo, type RunState } from './runs.ts';
import { nonnegative } from './diagnostic-metadata.ts';
import { atomicWrite } from './store.ts';

/** The subset of Pi's event bus OptChat needs; keeps this module testable without a Pi runtime. */
export interface SubagentEvents {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface PiSubagentsPaths {
  root: string;
  asyncDir: string;
  resultsDir: string;
  foregroundHistory: string;
  liveForegroundDir: string;
}

export interface TempScopeOptions {
  env?: NodeJS.ProcessEnv;
  getuid?: (() => number) | undefined;
  userInfo?: (() => { username?: string | null }) | undefined;
  homedir?: (() => string) | undefined;
}

const MAX_STATUS_BYTES = 16 * 1024 * 1024;
const MAX_WARNINGS = 20;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const count = (value: unknown): number | undefined => (nonnegative(value) ? value : undefined);

function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized || 'unknown';
}

/** A file-name-safe segment of an id, used for the artifacts a row points at. */
function fileSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
}

/** Mirrors pi-subagents' resolveTempScopeId so both extensions find the same temp root. */
export function resolveTempScopeId(options: TempScopeOptions = {}): string {
  const env = options.env ?? process.env;
  const getuid = Object.hasOwn(options, 'getuid') ? options.getuid : typeof process.getuid === 'function' ? process.getuid.bind(process) : undefined;
  if (typeof getuid === 'function') return `uid-${getuid()}`;
  for (const key of ['USERNAME', 'USER', 'LOGNAME'] as const) {
    const value = env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }
  const info = Object.hasOwn(options, 'userInfo') ? options.userInfo : userInfo;
  try {
    const username = info?.()?.username;
    if (username) return `user-${sanitizeTempScopeSegment(username)}`;
  } catch { /* fall through to the home directory */ }
  const home = env.USERPROFILE ?? env.HOME;
  if (home) return `home-${sanitizeTempScopeSegment(home)}`;
  const resolveHomedir = Object.hasOwn(options, 'homedir') ? options.homedir : homedir;
  try {
    const fallback = resolveHomedir?.();
    if (fallback) return `home-${sanitizeTempScopeSegment(fallback)}`;
  } catch { /* fall through */ }
  return 'shared';
}

/** pi-subagents' temp artifact layout; PI_SUBAGENTS_TEMP_ROOT wins, exactly as in pi-subagents. */
export function piSubagentsPaths(options: TempScopeOptions = {}): PiSubagentsPaths {
  const env = options.env ?? process.env, configured = env.PI_SUBAGENTS_TEMP_ROOT?.trim();
  return pathsFromRoot(configured ? resolve(configured) : join(tmpdir(), `pi-subagents-${resolveTempScopeId(options)}`));
}

export function pathsFromRoot(root: string): PiSubagentsPaths {
  const resolved = resolve(root), resultsDir = join(resolved, 'async-subagent-results');
  return {
    root: resolved,
    asyncDir: join(resolved, 'async-subagent-runs'),
    resultsDir,
    foregroundHistory: join(resultsDir, 'foreground-history.json'),
    liveForegroundDir: join(resultsDir, 'live-foreground'),
  };
}

const asyncStates: Record<string, RunState> = {
  queued: 'running', running: 'running', stopping: 'stopping', complete: 'completed',
  completed: 'completed', failed: 'failed', partial: 'failed', rejected: 'failed',
  stopped: 'stopped', paused: 'paused', pending: 'waiting',
};
const foregroundStates: Record<string, RunState> = { completed: 'completed', failed: 'failed', paused: 'paused', stopped: 'stopped' };
const thinkingLevels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const safeId = fileSafe;

/** pi-subagents writes the thinking level as a model suffix; a model id may also contain a colon, so only a known level is split off. */
export function splitModelSuffix(model: string): { model: string; thinking?: string } {
  const colon = model.lastIndexOf(':');
  if (colon <= 0) return { model };
  const head = model.slice(0, colon), tail = model.slice(colon + 1).toLowerCase();
  if (!head.includes('/') || !thinkingLevels.has(tail)) return { model };
  return { model: head, thinking: tail };
}

/**
 * Converts one pi-subagents async status.json into panel rows. A run with one
 * step is one row; a multi-step run is one row per step, each with its own
 * agent, model, thinking level and state.
 */
export function asyncStatusToRuns(value: unknown, fallbackId = 'run', asyncDir?: string): RunInfo[] {
  if (!isRecord(value)) return [];
  const runId = text(value.runId) ?? fallbackId;
  const steps = Array.isArray(value.steps) ? value.steps.filter(isRecord) : [];
  const runState = asyncStates[String(value.state)];
  const runStarted = count(value.startedAt) ?? count(value.lastUpdate);
  const runEnded = count(value.endedAt);
  if (runStarted === undefined) return [];
  const row = (step: Record<string, unknown>, position: number | undefined, state: RunState | undefined): RunInfo | undefined => {
    if (!state) return undefined;
    const agent = text(step.agent) ?? text(value.agent) ?? 'subagent';
    const sessionFile = text(step.sessionFile) ?? text(value.sessionFile);
    const rawModel = text(step.model) ?? text(value.model) ?? text(value.launchModel) ?? 'unknown';
    const split = splitModelSuffix(rawModel);
    const started = count(step.startedAt) ?? runStarted;
    const ended = isTerminalState(state) ? count(step.endedAt) ?? runEnded ?? count(value.lastUpdate) : undefined;
    return {
      id: position === undefined ? `pi-${safeId(runId)}` : `pi-${safeId(runId)}-${position}`,
      task: text(step.sessionName) ?? text(step.description) ?? text(step.label) ?? text(value.description) ?? `${agent} run`,
      cwd: text(value.cwd) ?? text(step.cwd) ?? process.cwd(),
      model: split.model,
      thinking: text(step.thinking) ?? text(value.thinking) ?? split.thinking ?? 'unknown',
      parentSession: text(value.sessionId) ?? '',
      ...(sessionFile ? { sessionFile } : {}),
      started,
      ...(ended === undefined ? {} : { ended }),
      depth: 1,
      state,
      guidance: [],
      source: 'pi-subagents',
      externalKind: 'async',
      externalRunId: runId,
      ...(position === undefined ? {} : { externalStepIndex: position }),
      ...(asyncDir ? { externalDir: asyncDir } : {}),
      agent,
    };
  };
  if (steps.length <= 1) {
    const step = steps[0] ?? {};
    const state = runState ?? asyncStates[String(step.status)];
    const single = row(step, undefined, state);
    return single ? [single] : [];
  }
  // A multi-step run shows one row per step: the panel lists agents, and every
  // step is an agent with its own model and thinking level.
  return steps.map((step, position) => row(step, position, asyncStates[String(step.status)] ?? runState)).filter((run): run is RunInfo => run !== undefined);
}

/** Converts one live foreground record into a panel row. */
export function liveForegroundToRun(value: unknown): RunInfo | undefined {
  if (!isRecord(value)) return undefined;
  const runId = text(value.runId);
  if (!runId) return undefined;
  const started = count(value.startedAt) ?? count(value.updatedAt);
  if (started === undefined) return undefined;
  const index = count(value.index) ?? 0;
  const sessionFile = text(value.sessionFile);
  const split = splitModelSuffix(text(value.model) ?? 'unknown');
  return {
    id: `pi-${safeId(runId)}-${safeId(String(index))}`,
    task: text(value.task) ?? `${text(value.agent) ?? 'subagent'} run`,
    cwd: text(value.cwd) ?? process.cwd(),
    model: split.model,
    thinking: split.thinking ?? 'unknown',
    parentSession: text(value.sessionId) ?? '',
    ...(sessionFile ? { sessionFile } : {}),
    started,
    depth: 1,
    state: 'running',
    guidance: [],
    source: 'pi-subagents',
    externalKind: 'live-foreground',
    externalRunId: runId,
    externalStepIndex: index,
    agent: text(value.agent) ?? 'subagent',
  };
}

/** Converts pi-subagents' foreground-history.json into one panel row per saved child. */
export function foregroundHistoryToRuns(value: unknown): RunInfo[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.runs)) return [];
  const result: RunInfo[] = [];
  for (const raw of value.runs) {
    if (!isRecord(raw)) continue;
    const runId = text(raw.runId);
    if (!runId) continue;
    const cwd = text(raw.cwd) ?? process.cwd(), parentSession = text(raw.sessionId) ?? '', updatedAt = count(raw.updatedAt) ?? 0;
    const children = Array.isArray(raw.children) ? raw.children.filter(isRecord) : [];
    children.forEach((child, position) => {
      const state = foregroundStates[String(child.status)];
      if (!state) return;
      const agent = text(child.agent) ?? 'subagent';
      const index = count(child.index) ?? position;
      const sessionFile = text(child.sessionFile);
      const split = splitModelSuffix(text(child.model) ?? 'unknown');
      result.push({
        id: `pi-${safeId(runId)}-${safeId(String(index))}`,
        task: text(child.sessionName) ?? `${agent} run`,
        cwd,
        model: split.model,
        thinking: text(child.thinking) ?? split.thinking ?? 'unknown',
        parentSession,
        ...(sessionFile ? { sessionFile } : {}),
        started: updatedAt,
        ended: updatedAt,
        depth: 1,
        state,
        guidance: [],
        source: 'pi-subagents',
        externalKind: 'foreground',
        externalRunId: runId,
        agent,
        durationUnknown: true,
      });
    });
  }
  return result;
}

/** The head of a Pi session file names the model and thinking level the run actually used. */
export function parseSessionHeader(text: string): { model?: string; thinking?: string } {
  let model: string | undefined, thinking: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!isRecord(value)) continue;
    if (value.type === 'model_change' && typeof value.provider === 'string' && typeof value.modelId === 'string') model = `${value.provider}/${value.modelId}`;
    if (value.type === 'thinking_level_change' && typeof value.thinkingLevel === 'string') thinking = value.thinkingLevel;
  }
  return { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}

/** Only the first bytes of a session file are needed, so a large transcript is never read whole. */
function readHead(file: string, bytes = 8192): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(bytes), read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.toString('utf8', 0, read);
  } catch { return ''; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ } }
}

/** What a panel can do with a pi-subagents row: stop an async run, pause a foreground child, or hide it. */
export type ExternalAction = 'stop' | 'pause' | 'hide';

/**
 * The control a pi-subagents row accepts. An async run is reached through its
 * runner's control inbox, so it answers from any session; a foreground child
 * runs inside the Pi process that started it, so only that session can pause it.
 */
export function externalAction(run: RunInfo, owned: boolean): ExternalAction {
  if (!isActiveRun(run)) return 'hide';
  if (run.externalKind === 'live-foreground') return owned ? 'pause' : 'hide';
  return 'stop';
}

/** What a panel shows under a finished pi-subagents run: its state, and that its transcript is read-only. */
export function externalStateLine(run: RunInfo): string {
  const state = run.state === 'completed' ? 'Finished' : run.state === 'paused' ? 'Paused' : `Ended (${run.state})`;
  return `${state}. Read-only pi-subagents transcript; its artifacts stay in pi-subagents.`;
}

interface CacheEntry { stamp: string; runs?: RunInfo[] }
interface ForegroundCache { stamp: string; runs: RunInfo[] }

/** What a panel needs to reach a run: which run, which step, and where its control inbox is. */
export interface ExternalControlTarget {
  runId: string;
  stepIndex?: number;
  dir?: string;
}

export interface ExternalRunsOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  throttleMs?: number;
  /** A live record older than this belongs to a run that died without cleaning up. */
  liveTtlMs?: number;
}

/**
 * Read-only projection of pi-subagents' saved runs for OptChat's agents panel.
 * It never writes into pi-subagents' artifacts: the only local state is the
 * panel's own hidden-run list.
 */
export class ExternalRuns {
  readonly records = new Map<string, RunInfo>();
  readonly warnings: string[] = [];
  readonly paths: PiSubagentsPaths;
  private readonly hiddenFile: string;
  private readonly hidden: Set<string>;
  private readonly statusCache = new Map<string, CacheEntry>();
  private readonly sessionCache = new Map<string, { stamp: string; meta: { model?: string; thinking?: string } }>();
  private readonly now: () => number;
  private readonly throttleMs: number;
  private readonly liveTtlMs: number;
  private asyncRecords = new Map<string, RunInfo>();
  private foregroundRecords = new Map<string, RunInfo>();
  private liveRecords = new Map<string, RunInfo>();
  /** Start times of the live children this panel has seen, so a finished run keeps its real duration. */
  private readonly liveStarts = new Map<string, number>();
  private foregroundCache?: ForegroundCache;
  private lastRefresh = Number.NEGATIVE_INFINITY;
  private readonly warned = new Set<string>();

  constructor(profileDirectory: string, options: ExternalRunsOptions = {}) {
    this.paths = options.root ? pathsFromRoot(options.root) : piSubagentsPaths({ env: options.env });
    this.now = options.now ?? Date.now;
    this.throttleMs = options.throttleMs ?? 750;
    this.liveTtlMs = options.liveTtlMs ?? 5 * 60 * 1000;
    this.hiddenFile = join(profileDirectory, 'runs', 'external-hidden.json');
    this.hidden = readHidden(this.hiddenFile, this.warnings);
  }

  /** Snapshot without another filesystem pass. */
  snapshot(): RunInfo[] { return [...this.records.values()]; }

  list(): RunInfo[] {
    this.refresh();
    return [...this.records.values()].sort((a, b) => Number(isActiveRun(b)) - Number(isActiveRun(a)) || b.started - a.started || a.id.localeCompare(b.id));
  }

  get(id: string): RunInfo | undefined {
    this.refresh();
    return this.records.get(id);
  }

  activeCount(): number {
    this.refresh();
    return [...this.records.values()].filter(isActiveRun).length;
  }

  /** Where a run can be reached: async runs carry their control inbox, foreground runs their rpc id. */
  controlTarget(id: string): ExternalControlTarget | undefined {
    const run = this.get(id);
    if (!run || run.externalKind === 'foreground') return undefined;
    if (!run.externalRunId) return undefined;
    return { runId: run.externalRunId, ...(run.externalStepIndex !== undefined ? { stepIndex: run.externalStepIndex } : {}), ...(run.externalDir ? { dir: run.externalDir } : {}) };
  }

  hide(id: string): boolean {
    if (!this.records.has(id) && !this.hidden.has(id)) return false;
    this.hidden.add(id);
    this.records.delete(id);
    this.asyncRecords.delete(id);
    this.foregroundRecords.delete(id);
    this.liveRecords.delete(id);
    atomicWrite(this.hiddenFile, JSON.stringify([...this.hidden].sort(), null, 2));
    return true;
  }

  isHidden(id: string): boolean { return this.hidden.has(id); }

  refresh(force = false): void {
    const now = this.now();
    if (!force && now - this.lastRefresh < this.throttleMs) return;
    this.lastRefresh = now;
    this.readAsync();
    this.readForeground();
    this.readLiveForeground();
    const next = new Map<string, RunInfo>();
    // A live foreground child is shown while it works; the saved history replaces it
    // when the run ends, and keeps the start time the live record knew.
    for (const run of this.liveRecords.values()) if (!this.hidden.has(run.id)) next.set(run.id, run);
    for (const run of this.foregroundRecords.values()) {
      if (this.hidden.has(run.id)) continue;
      // The live record is gone by now, but the start time it knew is kept: the saved history has none.
      const live = next.get(run.id) ?? (this.liveStarts.has(run.id) ? { started: this.liveStarts.get(run.id)! } : undefined);
      next.set(run.id, run.durationUnknown && live ? { ...run, started: live.started, durationUnknown: false } : run);
    }
    for (const run of this.asyncRecords.values()) if (!this.hidden.has(run.id)) next.set(run.id, run);
    this.records.clear();
    for (const [id, run] of next) this.records.set(id, run);
  }

  private warnOnce(message: string) {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    if (this.warnings.length < MAX_WARNINGS) this.warnings.push(message);
  }

  private readAsync() {
    let entries;
    try { entries = readdirSync(this.paths.asyncDir, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.asyncRecords.clear(); this.statusCache.clear(); return; }
      this.warnOnce(`Could not read pi-subagents async runs: ${String(error)}`);
      return;
    }
    const seen = new Set<string>(), next = new Map<string, RunInfo>();
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const dir = join(this.paths.asyncDir, entry.name), file = join(dir, 'status.json');
      const stamp = this.stamp(file);
      if (!stamp) { this.statusCache.delete(file); continue; }
      seen.add(file);
      const cached = this.statusCache.get(file);
      if (cached?.stamp === stamp) {
        for (const run of cached.runs ?? []) next.set(run.id, run);
        continue;
      }
      let runs: RunInfo[] = [];
      try { runs = asyncStatusToRuns(JSON.parse(readFileSync(file, 'utf8')), entry.name, dir).map(run => this.withSessionMeta(run)); }
      catch { runs = []; }
      this.statusCache.set(file, { stamp, runs });
      for (const run of runs) next.set(run.id, run);
    }
    for (const file of this.statusCache.keys()) if (!seen.has(file)) this.statusCache.delete(file);
    this.asyncRecords = next;
  }

  private readForeground() {
    const file = this.paths.foregroundHistory, stamp = this.stamp(file);
    if (!stamp) { this.foregroundCache = undefined; this.foregroundRecords.clear(); return; }
    if (this.foregroundCache?.stamp === stamp) {
      this.foregroundRecords = new Map(this.foregroundCache.runs.map(run => [run.id, run]));
      return;
    }
    try {
      const runs = foregroundHistoryToRuns(JSON.parse(readFileSync(file, 'utf8'))).map(run => this.withSessionMeta(run));
      this.foregroundCache = { stamp, runs };
      this.foregroundRecords = new Map(runs.map(run => [run.id, run]));
    } catch (error) {
      this.foregroundCache = { stamp, runs: this.foregroundCache?.runs ?? [] };
      this.warnOnce(`Could not read pi-subagents foreground history: ${String(error)}`);
    }
  }

  /** The live records of foreground children that are working right now. */
  private readLiveForeground() {
    let entries: string[];
    try { entries = readdirSync(this.paths.liveForegroundDir); }
    catch { this.liveRecords.clear(); return; }
    const now = this.now(), next = new Map<string, RunInfo>();
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const file = join(this.paths.liveForegroundDir, entry);
      let value: unknown;
      try { value = JSON.parse(readFileSync(file, 'utf8')); }
      catch { continue; }
      const run = liveForegroundToRun(value);
      if (!run) continue;
      // A record whose heartbeat stopped belongs to a run that died without cleaning up.
      const updatedAt = count(isRecord(value) ? value.updatedAt : undefined);
      if (updatedAt !== undefined && now - updatedAt > this.liveTtlMs) continue;
      // Remember the start: the saved history has none, and the live record is gone by then.
      this.liveStarts.set(run.id, run.started);
      if (this.liveStarts.size > 500) this.liveStarts.delete(this.liveStarts.keys().next().value as string);
      next.set(run.id, this.withSessionMeta(run));
    }
    this.liveRecords = next;
  }

  /** Fills in a model or thinking level the saved metadata left out, from the run's own session file. */
  private withSessionMeta(run: RunInfo): RunInfo {
    if (!run.sessionFile || (run.model !== 'unknown' && run.thinking !== 'unknown')) return run;
    const stamp = this.stamp(run.sessionFile) ?? '', cached = this.sessionCache.get(run.sessionFile);
    const meta = cached?.stamp === stamp ? cached.meta : parseSessionHeader(readHead(run.sessionFile));
    this.sessionCache.set(run.sessionFile, { stamp, meta });
    if (run.model !== 'unknown' && run.thinking !== 'unknown') return run;
    return { ...run, model: run.model === 'unknown' && meta.model ? meta.model : run.model, thinking: run.thinking === 'unknown' && meta.thinking ? meta.thinking : run.thinking };
  }

  /** mtime+size is enough: pi-subagents writes atomically, so any content change changes the stamp. */
  private stamp(file: string): string | undefined {
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > MAX_STATUS_BYTES) return undefined;
      return `${stat.mtimeMs}:${stat.size}`;
    } catch { return undefined; }
  }
}

function readHidden(file: string, warnings: string[]): Set<string> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(value)) throw new Error('not an array');
    return new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push(`Could not read hidden pi-subagents runs: ${String(error)}`);
    return new Set();
  }
}

/**
 * The in-process extension RPC documented by pi-subagents. Reply correlation is
 * per request id on `subagents:rpc:v1:reply:<id>`; no state is shared directly.
 */
export class SubagentRpc {
  private sequence = 0;
  constructor(private readonly events?: SubagentEvents, private readonly timeoutMs = 5000) {}

  get available() { return this.events !== undefined; }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    const events = this.events;
    if (!events) throw new Error('pi-subagents control is unavailable: this Pi session has no extension event bus.');
    const requestId = `optchat-${process.pid}-${++this.sequence}-${randomUUID()}`, replyChannel = `subagents:rpc:v1:reply:${requestId}`;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => { settled = true; clearTimeout(timer); unsubscribe(); };
      const fail = (error: unknown) => { if (settled) return; cleanup(); reject(error instanceof Error ? error : new Error(String(error))); };
      const unsubscribe = events.on(replyChannel, raw => {
        if (!isRecord(raw) || raw.requestId !== requestId) return;
        if (raw.success === true) { const data = raw.data; cleanup(); resolve(data as T); return; }
        const error = isRecord(raw.error) ? raw.error : {}, message = text(error.message) ?? 'unknown error', code = text(error.code);
        cleanup();
        reject(new Error(`pi-subagents ${method} failed: ${message}${code ? ` (${code})` : ''}`));
      });
      const timer = setTimeout(() => fail(new Error(`pi-subagents did not answer ${method} within ${this.timeoutMs} ms. Is pi-subagents loaded in this Pi session?`)), this.timeoutMs);
      timer.unref?.();
      try { events.emit('subagents:rpc:v1:request', { version: 1, requestId, method, ...(params === undefined ? {} : { params }), source: { extension: 'pi-optchat' } }); }
      catch (error) { fail(error); }
    });
  }
}
