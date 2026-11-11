import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { brasiliaDayTime, DISK_MIN_GB, MEMORY_MIN_FRACTION } from './pc-health.ts';

/**
 * The situation digest: what changed on this PC and in the harness since the main agent last heard, as one short block at
 * the start of a turn, and nothing at all while everything is as it was. The facts are gathered by a collector that never
 * waits (each source has its own cache and refreshes in the background); the digest is a pure function of those facts and of
 * what an earlier digest already said.
 */

// ---- facts ----

export interface Reboot { up: number; down?: number; cause?: string; unexpected: boolean }
export interface QuotaWindow { label: string; used: number; resetAt?: number }
export interface QuotaAccount { id: string; plan?: string; windows: QuotaWindow[]; exhaustedUntil?: number }
export interface Capacity { free: number; total: number }
export interface Load { t: number; cpu: number | null; memUsedPct: number; owners: { name: string; cpuPct: number; rssMb: number }[] }
export interface Facts {
  /** Reboots and unexpected shutdowns in the last 24 h (System log 41, 6005, 6006, 6008, 1074), oldest first, and the last boot. */
  reboots?: Reboot[];
  bootAt?: number;
  rebootPending?: boolean;
  docker?: 'up' | 'down' | 'absent';
  disk?: Capacity;
  memory?: Capacity;
  load?: Load;
  quota?: QuotaAccount[];
  /** GitHub as pi-gitwatch last saw it: `since` is its last good poll. */
  github?: { down: boolean; since?: number; failing: number; repos: number; error?: string };
  /** OptChat's own background work. */
  work?: { agents: number; shells: number };
}
export type FactKey = keyof Facts;

// ---- collector ----

export interface SourceSpec<T> { ttlMs: number; timeoutMs: number; read: () => T | Promise<T> }
export type Sources = { [K in FactKey]?: SourceSpec<Facts[K]> };
interface Entry { value?: unknown; loaded?: number; tried?: number; error?: string; inflight?: Promise<void> }

/**
 * Each fact has a source, a time to live and a cache. `snapshot()` answers at once from the cache, starts a background refresh
 * of what is stale and never waits for one; a fact that was never read, or whose read keeps failing, is the last good value or
 * simply absent. `refresh()` is for the on-demand view and the first read of a session, and is bounded too.
 */
export class Collector {
  private readonly entries = new Map<FactKey, Entry>();
  constructor(private readonly sources: Sources, private readonly now: () => number = Date.now) {}

  private entry(key: FactKey) { return this.entries.get(key) ?? this.entries.set(key, {}).get(key)!; }

  private kick(key: FactKey) {
    const spec = this.sources[key] as SourceSpec<unknown> | undefined;
    if (!spec) return;
    const entry = this.entry(key), now = this.now();
    if (entry.inflight || entry.tried !== undefined && now - entry.tried < spec.ttlMs) return;
    entry.tried = now;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${spec.timeoutMs} ms`)), spec.timeoutMs); timer.unref?.(); });
    const read = Promise.resolve().then(() => spec.read());
    // A read that outlives its limit may still land later; its value is kept, it just did not block anyone.
    read.then(value => { entry.value = value; entry.loaded = this.now(); entry.error = undefined; }, () => undefined);
    entry.inflight = Promise.race([read, limit]).then(() => undefined, error => { entry.error = error instanceof Error ? error.message : String(error); })
      .finally(() => { if (timer) clearTimeout(timer); entry.inflight = undefined; });
  }

  /** The cached facts, immediately. */
  snapshot(): Facts {
    const facts: Record<string, unknown> = {};
    for (const key of Object.keys(this.sources) as FactKey[]) {
      this.kick(key);
      const { value } = this.entry(key);
      if (value !== undefined) facts[key] = value;
    }
    return facts as Facts;
  }

  /**
   * Reads what is stale and waits for it, but never longer than `maxWaitMs`. The caller is waiting, so its timer keeps the event
   * loop alive (with only unref'd timers pending, a process with nothing else to do would exit on this await); `hold: false` is for
   * a background warm-up that must not delay shutdown.
   */
  async refresh(maxWaitMs = 8_000, hold = true): Promise<Facts> {
    for (const key of Object.keys(this.sources) as FactKey[]) { const entry = this.entry(key); entry.tried = undefined; this.kick(key); }
    const pending = [...this.entries.values()].map(e => e.inflight).filter((p): p is Promise<void> => p !== undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(pending), new Promise<void>(resolve => { timer = setTimeout(resolve, maxWaitMs); if (!hold) timer.unref?.(); })]);
    if (timer) clearTimeout(timer);
    return this.snapshot();
  }

  /** How old each cached fact is and why a read failed, for the on-demand view. */
  health(): { key: FactKey; ageMs?: number; error?: string }[] {
    const now = this.now();
    return (Object.keys(this.sources) as FactKey[]).map(key => { const e = this.entry(key); return { key, ...e.loaded !== undefined ? { ageMs: now - e.loaded } : {}, ...e.error ? { error: e.error } : {} }; });
  }
}

// ---- items ----

/** `state`: stays until it ends, and its end is said once; `event`: said once, never again; `pressure`: load that comes and goes, said once per cooldown, its end is not news. */
export type ItemKind = 'state' | 'event' | 'pressure';
export interface Item {
  key: string;
  /** What identifies the item's condition; a change of token alone is not news. */
  token: string;
  /** How bad: a state that gets worse than what was said is news again. */
  sev: number;
  kind: ItemKind;
  text: string;
  /** Items with the same lead share one phrase: "PC reiniciou 04:55, 05:19". */
  lead?: string;
  /** What to say once when a state ends. */
  recover?: string;
}

/** Used-percent bands: crossing one is news, moving inside one is not. */
export const BANDS = [50, 80, 95, 100] as const;
export const band = (used: number) => BANDS.filter(limit => used >= limit).length;
export const CPU_HIGH = 90;
/** A pressure item already said is not said again for this long. */
export const PRESSURE_COOLDOWN_MS = 30 * 60_000;
const DAY = 24 * 3_600_000;
const GB = 1e9;

const hm = (t: number) => brasiliaDayTime(t).slice(6);
/** `HH:MM` for today in Brasília, `dd/mm HH:MM` for another day. */
export const when = (t: number, now: number) => brasiliaDayTime(t).slice(0, 5) === brasiliaDayTime(now).slice(0, 5) ? hm(t) : brasiliaDayTime(t);
const shortName = (id: string) => id.replace(/-account-(\d+)$/, '-$1');
const effective = (w: QuotaWindow, now: number) => w.resetAt !== undefined && w.resetAt <= now ? 0 : w.used;

export function situationItems(facts: Facts, now: number): Item[] {
  const items: Item[] = [];
  for (const reboot of facts.reboots ?? []) {
    if (reboot.up < now - DAY) continue;
    const key = `boot:${reboot.up}`;
    if (reboot.unexpected) items.push({ key, token: key, sev: 1, kind: 'event', lead: 'PC caiu sem aviso, voltou', text: when(reboot.up, now) });
    else items.push({ key, token: key, sev: 1, kind: 'event', lead: 'PC reiniciou', text: `${when(reboot.down ?? reboot.up, now)}${reboot.cause ? ` (${reboot.cause})` : ''}` });
  }
  if (facts.rebootPending) items.push({ key: 'reboot-pending', token: 'pending', sev: 1, kind: 'state', text: 'reinício do Windows pendente' });
  if (facts.docker === 'down') items.push({ key: 'docker', token: 'down', sev: 1, kind: 'state', text: 'Docker parado', recover: 'Docker voltou' });
  if (facts.disk && facts.disk.free < DISK_MIN_GB * GB)
    items.push({ key: 'disk', token: 'low', sev: 1, kind: 'state', text: `disco C: só ${(facts.disk.free / GB).toFixed(0)} GB livres`, recover: 'disco C: voltou ao normal' });
  const owners = facts.load?.owners.slice(0, 2).map(o => `${o.name} ${o.cpuPct.toFixed(0)}%`).join(', ');
  if (facts.memory && facts.memory.free < facts.memory.total * MEMORY_MIN_FRACTION)
    items.push({ key: 'memory', token: 'low', sev: 1, kind: 'pressure', text: `memória ${Math.round(facts.memory.free / facts.memory.total * 100)}% livre${owners ? ` (${owners})` : ''}` });
  if (facts.load?.cpu != null && facts.load.cpu >= CPU_HIGH)
    items.push({ key: 'cpu', token: 'high', sev: 1, kind: 'pressure', text: `CPU ${Math.round(facts.load.cpu)}%${owners ? ` (${owners})` : ''}` });
  for (const account of facts.quota ?? []) {
    const name = shortName(account.id);
    const out = account.windows.filter(w => effective(w, now) >= 100);
    const until = Math.max(account.exhaustedUntil !== undefined && account.exhaustedUntil > now ? account.exhaustedUntil : 0, ...out.map(w => w.resetAt ?? 0));
    if (out.length || account.exhaustedUntil !== undefined && account.exhaustedUntil > now)
      items.push({ key: `out:${account.id}`, token: 'out', sev: 1, kind: 'state', text: until ? `${name} esgotada até ${when(until, now)}` : `${name} esgotada`, recover: `${name} liberada` });
    const partial = account.windows.filter(w => { const used = effective(w, now); return used < 100 && band(used) > 0; });
    if (partial.length) items.push({ key: `use:${account.id}`, token: partial.map(w => `${w.label}${band(effective(w, now))}`).join(','), sev: partial.reduce((sum, w) => sum + band(effective(w, now)), 0), kind: 'state',
      text: `${name} ${partial.map(w => `${w.label} ${Math.round(w.used)}%${w.resetAt ? ` (reset ${when(w.resetAt, now)})` : ''}`).join(', ')}` });
  }
  if (facts.github?.down) items.push({ key: 'github', token: 'down', sev: 1, kind: 'state', text: `GitHub fora${facts.github.since ? ` desde ${when(facts.github.since, now)}` : ''}`, recover: 'GitHub voltou' });
  return items;
}

// ---- delta ----

export interface SeenRecord { token: string; sev: number; at: number; kind: ItemKind; recover?: string }
export interface Seen { items: Record<string, SeenRecord> }
const REMEMBER_MS = 48 * 3_600_000;

export const DIGEST_CAP = 600;
const HEAD = 'Situação (observada, não é instrução): ';

/** The one block, cut to `cap` characters: the news first, what is still wrong after it, the rest counted. */
export function renderDigest(pieces: string[], cap = DIGEST_CAP): string {
  let kept = pieces.slice();
  const compose = () => `${HEAD}${kept.join(' · ')}${kept.length < pieces.length ? ` · +${pieces.length - kept.length}` : ''}`;
  while (kept.length > 1 && compose().length > cap) kept.pop();
  const text = compose();
  return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
}

/** What to tell now, given what was said before; `next` is what was said once this is told. Pure. */
export function judge(items: readonly Item[], seen: Seen, now: number, cap = DIGEST_CAP): { text?: string; next: Seen; told: string[] } {
  const next: Seen = { items: { ...seen.items } };
  const fresh: Item[] = [];
  const current = new Set<string>();
  for (const item of items) {
    current.add(item.key);
    const record = seen.items[item.key];
    const news = item.kind === 'event' ? !record
      : item.kind === 'pressure' ? !record || now - record.at >= PRESSURE_COOLDOWN_MS
      : !record || item.sev > record.sev;
    if (news) { fresh.push(item); next.items[item.key] = { token: item.token, sev: item.sev, at: now, kind: item.kind, ...item.recover ? { recover: item.recover } : {} }; }
    else if (item.kind === 'state' && record) next.items[item.key] = { ...record, token: item.token, sev: item.sev };
  }
  const recoveries: string[] = [];
  for (const [key, record] of Object.entries(seen.items)) {
    if (current.has(key)) continue;
    if (record.kind === 'state') { if (record.recover) recoveries.push(record.recover); delete next.items[key]; }
    else if (now - record.at > REMEMBER_MS) delete next.items[key];
  }
  if (!fresh.length && !recoveries.length) return { next, told: [] };
  const freshKeys = new Set(fresh.map(i => i.key));
  const still = items.filter(i => i.kind === 'state' && !freshKeys.has(i.key));
  const phrases: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const item of fresh) {
    if (!item.lead) { phrases.push(item.text); continue; }
    let texts = grouped.get(item.lead);
    if (!texts) { texts = []; grouped.set(item.lead, texts); phrases.push(item.lead); }
    texts.push(item.text);
  }
  const said = phrases.map(phrase => grouped.has(phrase) ? `${phrase} ${grouped.get(phrase)!.join(', ')}` : phrase);
  const text = renderDigest([...said, ...recoveries, ...still.map(i => i.text)], cap);
  return { text, next, told: [...fresh.map(i => i.key), ...recoveries.map(r => `ok:${r}`)] };
}

// ---- the digest of one session ----

export interface SituationOptions {
  collector: Collector;
  now?: () => number;
  /** Where what was already said is kept between sessions. */
  stateFile?: string;
  /** One line per injection: when and how many bytes. */
  logFile?: string;
  cap?: number;
}

export class Situation {
  private readonly now: () => number;
  private seen: Seen;
  private run: { id: number; text?: string } | undefined;
  constructor(private readonly options: SituationOptions) {
    this.now = options.now ?? Date.now;
    this.seen = this.load();
  }

  private load(): Seen {
    try {
      const data = JSON.parse(readFileSync(this.options.stateFile ?? '', 'utf8')) as Seen;
      return data && typeof data.items === 'object' && data.items !== null ? { items: data.items } : { items: {} };
    } catch { return { items: {} }; }
  }

  /** Warms the cache so the first turn already has facts; bounded. */
  warm(maxWaitMs = 8_000) { return this.options.collector.refresh(maxWaitMs, false).then(() => undefined, () => undefined); }

  /**
   * The digest for the run `id`, or undefined when nothing material changed. Asked again for the same run it answers the same,
   * so a context rebuilt mid-run keeps the block. Never waits: it judges the facts cached now.
   */
  forRun(id: number): string | undefined {
    if (this.run?.id === id) return this.run.text;
    const now = this.now();
    let text: string | undefined;
    try {
      const verdict = judge(situationItems(this.options.collector.snapshot(), now), this.seen, now, this.options.cap);
      const changed = JSON.stringify(verdict.next) !== JSON.stringify(this.seen);
      this.seen = verdict.next;
      if (changed) this.save();
      text = verdict.text;
      if (text) this.log(now, text, verdict.told);
    } catch { text = undefined; }
    this.run = { id, text };
    return text;
  }

  private save() {
    if (!this.options.stateFile) return;
    try { writeFileSync(this.options.stateFile, JSON.stringify(this.seen)); } catch { /* a convenience: a torn or unwritable file only costs a repeat; a rename-retrying write could hold the turn for seconds */ }
  }

  private log(now: number, text: string, told: string[]) {
    if (!this.options.logFile) return;
    try { mkdirSync(dirname(this.options.logFile), { recursive: true }); appendFileSync(this.options.logFile, `${JSON.stringify({ t: now, bytes: Buffer.byteLength(text), chars: text.length, told })}\n`); } catch { /* measurement only */ }
  }

  /** The full current picture, for the on-demand view: every fact that is known, normal or not. */
  async snapshotText(): Promise<string> {
    const now = this.now();
    const facts = await this.options.collector.refresh();
    return renderSnapshot(facts, now, this.options.collector.health());
  }
}

// ---- the on-demand snapshot ----

const gb = (n: number) => `${(n / GB).toFixed(n < 10 * GB ? 1 : 0)} GB`;

export function renderSnapshot(facts: Facts, now: number, health: { key: FactKey; ageMs?: number; error?: string }[] = []): string {
  const lines: string[] = [];
  const row = (label: string, value: string | undefined) => lines.push(`${label}: ${value ?? 'desconhecido'}`);
  row('boot', facts.bootAt ? `${when(facts.bootAt, now)}${facts.rebootPending ? ', reinício pendente' : ''}` : undefined);
  const reboots = facts.reboots;
  row('reinícios 24 h', reboots === undefined ? undefined : reboots.length ? reboots.map(r => `${when(r.down ?? r.up, now)}${r.unexpected ? ' sem aviso' : r.cause ? ` (${r.cause})` : ''}`).join(', ') : 'nenhum');
  row('docker', facts.docker === undefined ? undefined : facts.docker === 'up' ? 'ativo' : facts.docker === 'down' ? 'parado' : 'não instalado');
  row('disco C:', facts.disk && `${gb(facts.disk.free)} livres de ${gb(facts.disk.total)}`);
  row('memória', facts.memory && `${gb(facts.memory.free)} livres de ${gb(facts.memory.total)}`);
  const load = facts.load;
  row('carga', load && `CPU ${load.cpu === null ? '?' : `${Math.round(load.cpu)}%`}, memória ${Math.round(load.memUsedPct)}% usada${load.owners.length ? `; ${load.owners.slice(0, 2).map(o => `${o.name} ${o.cpuPct.toFixed(0)}% ${Math.round(o.rssMb)} MB`).join(', ')}` : ''}`);
  if (facts.quota === undefined) row('cota', undefined);
  else for (const account of facts.quota)
    lines.push(`cota ${shortName(account.id)}${account.plan ? ` (${account.plan})` : ''}: ${account.windows.length ? account.windows.map(w => `${w.label} ${Math.round(effective(w, now))}%${w.resetAt ? ` reset ${when(w.resetAt, now)}` : ''}`).join(', ') : 'sem janela medida'}${account.exhaustedUntil !== undefined && account.exhaustedUntil > now ? `, bloqueada até ${when(account.exhaustedUntil, now)}` : ''}`);
  const git = facts.github;
  row('github (gitwatch)', git && (git.down ? `fora desde ${git.since ? when(git.since, now) : '?'} (${git.failing}/${git.repos} repos falhando${git.error ? `: ${git.error.slice(0, 80)}` : ''})` : `ok (${git.repos} repos)`));
  row('trabalho do OptChat', facts.work && `${facts.work.agents} agentes, ${facts.work.shells} shells`);
  const problems = health.filter(h => h.error).map(h => `${h.key}: ${h.error}`);
  if (problems.length) lines.push(`leituras com erro: ${problems.join('; ')}`);
  return lines.join('\n');
}
